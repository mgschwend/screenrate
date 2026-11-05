import './style.css';
import { openDatabase, forgetKey } from './dataload.js';
import { resolve, contextFor, phrases, Voter } from './match.js';
import { normalize } from './normalize.js';
import { grabFrame, thumbDiff, prepare, DIFF_THRESHOLD } from './frame.js';
import { initOcr, recognize, ocrState } from './ocr.js';
import { Overlay } from './overlay.js';
import { history, watchlist, remembered, settings, posterCache } from './store.js';
import {
  $, toast, renderHistory, appendHistory, refreshHistoryRow, renderWatchlist, openSheet, closeSheet, fmtRating,
} from './ui.js';

let tdb = null;
const video = $('#video');
const overlay = new Overlay($('#overlay'));
const raw = document.createElement('canvas'); // last full-res frame (frozen view)

/** state: 'idle' (no camera yet) | 'scanning' | 'paused' */
const S = {
  mode: 'idle',
  stream: null,
  loopId: 0,
  frameNo: 0,
  prevThumb: null,
  voter: new Voter(2, 8),
  badges: [],              // [{box, label, ambiguous, data}] in raw-frame px
  frameSize: [0, 0],
  lookups: new Map(),      // cache key → resolve() result
  sessionSeen: new Map(),  // dedupe key → history row id (this app run)
  floorSince: 0,
  lastMatches: [],         // matches of the last OCR'd frame (re-used while the picture is unchanged)
};

const setMode = (m) => { S.mode = m; document.body.dataset.state = m; };
const status = (t) => { $('#vf-status').textContent = t || ''; };

// =============== boot / unlock ===============
async function boot() {
  registerServiceWorker();
  $('#boot-status').textContent = 'Opening database…';
  try {
    tdb = await openDatabase();
    startApp();
  } catch (err) {
    if (err.code === 'BAD_KEY') await forgetKey();
    if (err.code === 'NO_KEY' || err.code === 'BAD_KEY') return showUnlock(err.code === 'BAD_KEY' ? 'Stored passphrase no longer works.' : '');
    $('#boot-status').textContent = `Could not open database: ${err.message}`;
  }
}

function showUnlock(msg) {
  $('#boot').hidden = true;
  $('#unlock').hidden = false;
  $('#unlock-status').textContent = msg;
  $('#passphrase').focus();
}

$('#unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#passphrase').value.trim();
  const btn = e.submitter || $('#unlock-form button');
  const prog = $('#unlock-progress');
  btn.disabled = true;
  $('#unlock-status').textContent = 'Downloading and decrypting…';
  try {
    tdb = await openDatabase({
      passphrase: pass,
      onProgress: (got, total) => { prog.hidden = false; prog.value = total ? got / total : 0; },
    });
    $('#passphrase').value = '';
    $('#unlock').hidden = true;
    startApp();
  } catch (err) {
    $('#unlock-status').textContent = err.code === 'BAD_KEY' ? 'Wrong passphrase.' : `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    prog.hidden = true;
  }
});

function startApp() {
  $('#boot').hidden = true;
  $('#app').hidden = false;
  setMode('idle');
  renderHistory(openHistoryRow);
  renderWatchlist(openTconst);
  renderSettings();
  overlay.clear();
}

// =============== tabs ===============
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    if (b.dataset.view !== 'scan') pause();
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x === b);
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${b.dataset.view}`;
    if (b.dataset.view === 'watchlist') renderWatchlist(openTconst);
    if (b.dataset.view === 'settings') renderSettings();
  });
}

// =============== camera ===============
async function startCamera() {
  if (S.stream) return;
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = S.stream;
  await video.play();
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
}

function stopCamera() {
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  video.srcObject = null;
}

let orientationAsked = false;
async function askOrientationPermission() {
  if (orientationAsked) return;
  orientationAsked = true;
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch { /* denied → floor-pause just won't trigger */ }
}

// =============== state machine ===============
async function startScanning() {
  if (S.mode === 'scanning') return;
  askOrientationPermission();
  status('Starting camera…');
  try {
    await startCamera();
  } catch (err) {
    status('');
    toast(`Camera unavailable: ${err.message}`);
    return;
  }
  setMode('scanning');
  overlay.clear();
  S.badges = [];
  S.prevThumb = null;
  S.lastMatches = [];
  S.voter.reset();
  S.floorSince = 0;
  ensureOcr().then(() => loop(++S.loopId));
}

/** → Paused: freeze the last frame WITH its badges. */
function pause() {
  if (S.mode !== 'scanning') return;
  S.loopId++;
  setMode('paused');
  stopCamera();
  status('');
  requestAnimationFrame(() => overlay.render(S.badges, ...S.frameSize, raw.width ? raw : null));
}

let ocrReady = null;
function ensureOcr() {
  if (!ocrReady) {
    status('Loading OCR models…');
    ocrReady = initOcr().then(() => status(''), (err) => {
      ocrReady = null;
      status('');
      toast(`OCR failed to load: ${err.message}`);
      throw err;
    });
  }
  return ocrReady;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop(id) {
  while (S.mode === 'scanning' && id === S.loopId) {
    const t0 = performance.now();
    try {
      await scanFrame({ snapshot: false, id });
    } catch (err) {
      status(`OCR error: ${err.message}`);
      await sleep(1000);
    }
    await sleep(Math.max(0, 1000 / settings.get().fps - (performance.now() - t0)));
  }
}

/** Grab → (skip if unchanged) → preprocess → OCR → match → badges/history. */
async function scanFrame({ snapshot, id }) {
  if (!grabFrame(video, raw)) return;
  const { thumb, diff } = thumbDiff(raw, S.prevThumb);
  if (!snapshot && diff < DIFF_THRESHOLD) {
    // Nothing changed: no OCR, but the previous frame's titles count as seen again (voting on static screens).
    if (S.lastMatches.length) { S.frameNo++; showMatches(S.lastMatches, { snapshot: false }); }
    return;
  }
  S.prevThumb = thumb;
  await ocrRaw({ snapshot, id });
}

/** OCR whatever is in `raw` and update badges/history. */
async function ocrRaw({ snapshot, id }) {
  const { preprocess, minConfidence } = settings.get();
  const { canvas, scale } = prepare(raw, { preprocess });
  const items = await recognize(canvas);
  if (!snapshot && (S.mode !== 'scanning' || id !== S.loopId)) return; // paused meanwhile
  const scaled = items
    .filter((it) => it.confidence >= minConfidence && it.text.trim())
    .map((it) => ({ ...it, box: { x: it.box.x * scale, y: it.box.y * scale, width: it.box.width * scale, height: it.box.height * scale } }));
  S.frameNo++;
  processOcr(scaled, { snapshot });
  const ms = ocrState.lastMs != null ? `${ocrState.lastMs} ms` : '';
  if (!snapshot) status(`${ocrState.backend || ''} ${ms}`.trim());
}

function lookup(text, context) {
  const key = `${normalize(text)}|${context.year || ''}|${context.series ? 's' : ''}`;
  if (!S.lookups.has(key)) S.lookups.set(key, resolve(tdb, text, { context, remembered: remembered.all() }));
  return S.lookups.get(key);
}

function processOcr(items, { snapshot }) {
  const matches = [];
  for (const ph of phrases(items)) {
    let res = lookup(ph.text, contextFor(ph, items));
    if (res) { matches.push({ res, box: ph.box, text: ph.text }); continue; }
    if (ph.parts.length > 1) {
      for (const part of ph.parts) {
        res = lookup(part.text, contextFor(part, items));
        if (res) matches.push({ res, box: part.box, text: part.text });
      }
    }
  }
  S.lastMatches = matches;
  showMatches(matches, { snapshot });
}

function showMatches(matches, { snapshot }) {
  if (!snapshot) S.voter.observe(S.frameNo, matches.map((m) => m.res.norm));
  const shown = snapshot ? matches : matches.filter((m) => S.voter.confirmed(m.res.norm));

  S.badges = shown.map((m) => {
    const rowId = recordHistory(m);
    return { box: m.box, ...badgeLabel(m.res), data: { res: m.res, text: m.text, rowId } };
  });
  S.frameSize = [raw.width, raw.height];
  overlay.render(S.badges, raw.width, raw.height, S.mode === 'paused' || snapshot ? raw : null);
}

function badgeLabel(res) {
  if (!res.winner) return { label: '?', ambiguous: true };
  return { label: `★ ${fmtRating(res.winner.rating)}${res.alternatives ? ` ·${res.alternatives}` : ''}`, ambiguous: false };
}

/** Append to history once per title per app run; returns the row id. */
function recordHistory(m) {
  const { res } = m;
  const key = res.winner ? res.winner.tconst : `?${res.norm}`;
  if (S.sessionSeen.has(key)) return S.sessionSeen.get(key);
  const w = res.winner;
  const row = history.add(w
    ? { norm: res.norm, tconst: w.tconst, title: w.title, year: w.year, type: w.type, rating: w.rating }
    : { norm: res.norm, tconst: null, title: res.candidates[0]?.title || m.text, year: null, type: null, rating: null });
  S.sessionSeen.set(key, row.id);
  appendHistory(row, openHistoryRow);
  return row.id;
}

// =============== snapshot ===============
$('#shutter').addEventListener('click', async (e) => {
  e.stopPropagation();
  S.loopId++; // stop live loop
  status('Snapshot…');
  try {
    const wasRunning = !!S.stream;
    await startCamera();
    if (!wasRunning) await sleep(500); // let exposure settle
    await ensureOcr();
    setMode('scanning'); // so pause() freezes properly
    await scanFrame({ snapshot: true });
    pause();
    status(S.badges.length ? '' : 'No titles recognised');
    if (!S.badges.length) setTimeout(() => status(''), 2500);
  } catch (err) {
    status('');
    toast(`Snapshot failed: ${err.message}`);
  }
});

// =============== viewfinder interaction ===============
$('#viewfinder').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  const hit = overlay.hit(e.clientX, e.clientY);
  if (hit) { pause(); openMatch(hit); return; }
  if (S.mode !== 'scanning') startScanning();
});
$('#resume').addEventListener('click', (e) => { e.stopPropagation(); startScanning(); });

// touching the history list pauses
$('#history').addEventListener('touchstart', () => pause(), { passive: true });
$('#history').addEventListener('wheel', () => pause(), { passive: true });

// app backgrounded
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// phone pointed at the floor for ~2 s (lying flat, screen up)
window.addEventListener('deviceorientation', (e) => {
  if (S.mode !== 'scanning' || e.beta == null) return;
  const flat = Math.abs(e.beta) < 25 && Math.abs(e.gamma) < 25;
  if (!flat) { S.floorSince = 0; return; }
  S.floorSince ||= performance.now();
  if (performance.now() - S.floorSince > 2000) pause();
});

// Re-draw whenever the viewfinder changes size (pause/resume height transition, rotation).
new ResizeObserver(() => {
  if (!S.frameSize[0]) return;
  overlay.render(S.badges, ...S.frameSize, S.mode === 'paused' ? raw : null);
}).observe($('#viewfinder'));

// =============== detail / picker ===============
function openMatch({ res, text, rowId }) {
  openSheet({
    title: res.winner,
    candidates: res.candidates,
    norm: res.norm,
    seenText: text,
    onChoose: (chosen) => onUserChoice(res.norm, chosen, rowId),
  });
}

/** User picked/switched a title: remember, update the history row in place, refresh badges. */
function onUserChoice(norm, chosen, rowId) {
  S.lookups.clear();
  if (rowId) {
    const row = history.update(rowId, { tconst: chosen.tconst, title: chosen.title, year: chosen.year, type: chosen.type, rating: chosen.rating });
    if (row) refreshHistoryRow(row);
  }
  const chosenRes = (res) => ({ ...res, winner: chosen, ambiguous: false, how: 'remembered' });
  S.lastMatches = S.lastMatches.map((m) => (m.res.norm === norm ? { ...m, res: chosenRes(m.res) } : m));
  S.badges = S.badges.map((b) => {
    if (b.data.res.norm !== norm) return b;
    const res = { ...b.data.res, winner: chosen, ambiguous: false, how: 'remembered' };
    return { ...b, ...badgeLabel(res), data: { ...b.data, res } };
  });
  if (S.mode === 'paused') overlay.render(S.badges, ...S.frameSize, raw);
}

function openHistoryRow(row) {
  pause();
  const res = resolve(tdb, row.norm || row.title, { remembered: remembered.all() });
  const title = row.tconst ? (tdb.get(row.tconst) || res?.winner) : (res?.how === 'remembered' ? res.winner : null);
  const candidates = res?.candidates || (title ? [title] : []);
  if (title && !candidates.some((c) => c.tconst === title.tconst)) candidates.unshift(title);
  openSheet({
    title, candidates, norm: row.norm, seenText: row.tconst ? null : row.title,
    onChoose: (chosen) => onUserChoice(row.norm, chosen, row.id),
  });
}

function openTconst(tconst) {
  const t = tdb.get(tconst);
  if (!t) return toast('Title no longer in the database');
  openSheet({ title: t, candidates: [t], onClose: () => renderWatchlist(openTconst) });
}

// manual input (debug aid): same pipeline, no camera
$('#manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#manual-input');
  const text = input.value.trim();
  if (!text) return;
  pause();
  const res = resolve(tdb, text, { remembered: remembered.all() });
  input.blur();
  if (!res) return toast(`No match for “${text}”`);
  const rowId = recordHistory({ res, text });
  openMatch({ res, text, rowId });
  input.value = '';
});

// =============== settings ===============
function renderSettings() {
  const s = settings.get();
  $('#tmdb-key').value = s.tmdbKey;
  $('#fps').value = String(s.fps);
  $('#preprocess').checked = s.preprocess;
  if (tdb) {
    const m = tdb.meta();
    const built = m.built_at ? new Date(m.built_at.replace(' ', 'T') + 'Z').toLocaleString('de-CH') : '–';
    $('#stats').innerHTML = `<dt>Built</dt><dd>${built}</dd><dt>Titles</dt><dd>${Number(m.title_count).toLocaleString('de-CH')}</dd>
      <dt>DE/CH/AT titles</dt><dd>${Number(m.aka_count).toLocaleString('de-CH')}</dd><dt>Min. votes</dt><dd>${m.min_votes}</dd>`;
  }
  const rememberedCount = Object.keys(remembered.all()).length;
  $('#clear-remembered').textContent = `Clear remembered choices (${rememberedCount})`;
  $('#clear-history').textContent = `Clear history (${history.all().length})`;
  $('#ocr-stats').innerHTML = `<dt>Backend</dt><dd>${ocrState.backend || 'not loaded yet'}</dd>
    <dt>Last frame</dt><dd>${ocrState.lastMs != null ? ocrState.lastMs + ' ms' : '–'}</dd>
    <dt>WebGPU</dt><dd>${'gpu' in navigator ? 'available' : 'not available'}</dd>`;
}

$('#tmdb-key').addEventListener('change', (e) => { settings.set({ tmdbKey: e.target.value.trim() }); posterCache.clear(); toast('Saved'); });
$('#fps').addEventListener('change', (e) => settings.set({ fps: Number(e.target.value) }));
$('#preprocess').addEventListener('change', (e) => settings.set({ preprocess: e.target.checked }));
$('#clear-remembered').addEventListener('click', () => { remembered.clear(); S.lookups.clear(); renderSettings(); toast('Remembered choices cleared'); });
$('#clear-history').addEventListener('click', () => {
  history.clear(); S.sessionSeen.clear(); renderHistory(openHistoryRow); renderSettings(); toast('History cleared');
});
$('#lock').addEventListener('click', async () => { await forgetKey(); location.reload(); });
$('#update-data').addEventListener('click', async (e) => {
  const btn = e.currentTarget, prog = $('#update-progress');
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const fresh = await openDatabase({ force: true, onProgress: (g, t) => { prog.hidden = false; prog.value = t ? g / t : 0; } });
    tdb?.db.close();
    tdb = fresh;
    S.lookups.clear();
    renderSettings();
    toast('Data updated');
  } catch (err) {
    toast(`Update failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Update data'; prog.hidden = true;
  }
});

// =============== service worker ===============
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is best-effort */ });
}

// exposed for debugging in the console / smoke tests
window.screenrate = {
  get tdb() { return tdb; },
  S,
  ocrState,
  overlay,
  resolve: (t) => resolve(tdb, t, { remembered: remembered.all() }),
  /** Run the snapshot pipeline on any image/canvas instead of the camera (debugging). */
  async snapshotFrom(source) {
    raw.width = source.width; raw.height = source.height;
    raw.getContext('2d').drawImage(source, 0, 0);
    await ensureOcr();
    setMode('scanning');
    await ocrRaw({ snapshot: true });
    pause();
    return S.badges.map((b) => ({ label: b.label, text: b.data.text, title: b.data.res.winner?.title ?? null }));
  },
};

boot();
