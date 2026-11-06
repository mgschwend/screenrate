import './style.css';
import { openDatabase, forgetKey } from './dataload.js';
import { searchTitles, MIN_CHARS } from './search.js';
import { history, settings, posterCache } from './store.js';
import { recommendationsFor, providersFor } from './tmdb.js';
import { $, toast, renderRows, renderWatchlist, openSheet, closeSheet, setNetflixMarker } from './ui.js';

let tdb = null;
let netflix = new Set();   // tconsts on Netflix in the chosen region (precomputed weekly)
let netflixRegion = null;  // null → no Netflix data in this DB for the chosen region

function loadNetflix() {
  const { region } = settings.get();
  const regions = tdb.netflixRegions();
  netflixRegion = regions.includes(region) ? region : regions[0] || null;
  netflix = netflixRegion ? tdb.netflixSet(netflixRegion) : new Set();
  $('#nf-only').hidden = !netflixRegion;
  const nfOn = !!netflixRegion && settings.get().netflixOnly;
  $('#nf-only').classList.toggle('on', nfOn);
  $('#nf-only').setAttribute('aria-pressed', String(nfOn));
  $('#nf-only').textContent = netflixRegion ? `N ${netflixRegion}` : 'N';
}
const mark = (t) => ({ ...t, netflix: netflix.has(t.tconst) });
setNetflixMarker(mark);

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
  loadNetflix();
  showResults();
  renderSettings();
  checkForNewData();
  if (matchMedia('(hover: hover) and (min-width: 700px)').matches) $('#q').focus();
}

/** CI publishes db-version.json next to the DB; re-download quietly when it differs from the cached DB. */
async function checkForNewData() {
  try {
    const res = await fetch(new URL('db-version.json', document.baseURI), { cache: 'no-store' });
    if (!res.ok) { if (!tdb.hasSimilar()) refreshData({ quiet: true }); return; }
    const { built_at: remote } = await res.json();
    if (remote && remote !== tdb.meta().built_at) refreshData({ quiet: true });
  } catch { /* offline: keep the cached DB */ }
}

// =============== tabs ===============
function showView(name) {
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x.dataset.view === name);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  if (name === 'watchlist') renderWatchlist(openTitle);
  if (name === 'settings') renderSettings();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));

// =============== search ===============
const q = $('#q');
let searchTimer;
q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(showResults, 60); });
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); q.blur(); showResults(); });

function showResults() {
  const text = q.value.trim();
  const list = $('#results'), empty = $('#results-empty');
  const nfOnly = !!netflixRegion && settings.get().netflixOnly;
  if (text.replace(/\s/g, '').length < MIN_CHARS && nfOnly) {
    $('#list-head').hidden = false;
    $('#list-head').textContent = `Most popular on Netflix ${netflixRegion}`;
    renderRows(list, tdb.netflixTop(netflixRegion).map(mark), openTitle);
    empty.hidden = true;
    return;
  }
  if (text.replace(/\s/g, '').length < MIN_CHARS) {
    const recent = history.all().reverse();
    $('#list-head').textContent = 'Recently opened';
    $('#list-head').hidden = recent.length === 0;
    renderRows(list, recent.map(mark), openTitle);
    empty.hidden = recent.length > 0;
    empty.textContent = 'Type a film or series title — results appear as you type.';
    return;
  }
  let rows = searchTitles(tdb, text, nfOnly ? 300 : 30).map(mark);
  if (nfOnly) rows = rows.filter((r) => r.netflix).slice(0, 30);
  $('#list-head').hidden = false;
  $('#list-head').textContent = (rows.length ? `${rows.length}${rows.length === 30 ? '+' : ''} result${rows.length === 1 ? '' : 's'}` : 'No results')
    + (nfOnly ? ` on Netflix ${netflixRegion}` : '');
  renderRows(list, rows, openTitle);
  list.scrollTop = 0;
  empty.hidden = rows.length > 0;
  empty.textContent = nfOnly ? `Nothing on Netflix ${netflixRegion} for “${text}”. Tap “N” to show everything.` : `Nothing found for “${text}”.`;
}

$('#nf-only').addEventListener('click', () => {
  settings.set({ netflixOnly: !settings.get().netflixOnly });
  loadNetflix();
  showResults();
});

// =============== detail ===============
/** Open a title (row object or tconst): detail sheet with similar titles; remembers it as recently opened. */
function openTitle(t) {
  const title = tdb.get(typeof t === 'string' ? t : t.tconst);
  if (!title) return toast('Title not in the database');
  history.add(title);
  let similar = tdb.similar(title.tconst);
  if (!similar.length) similar = tdb.sameGenre(title.tconst);
  const asOf = tdb.meta().netflix_built_at;
  openSheet({
    title: mark(title),
    similar: similar.map(mark),
    netflix: { region: netflixRegion || settings.get().region, on: netflixRegion ? netflix.has(title.tconst) : null,
      asOf: asOf ? new Date(asOf.replace(' ', 'T') + 'Z').toLocaleDateString('de-CH') : '' },
    providers: providersFor(title.tconst, netflixRegion || settings.get().region),
    recommend: recommendationsFor(tdb, title.tconst),
    onOpen: openTitle,
    onClose: () => { if (!q.value.trim()) showResults(); if (!$('#view-watchlist').hidden) renderWatchlist(openTitle); },
  });
}

// =============== settings ===============
function renderSettings() {
  const s = settings.get();
  $('#tmdb-key').value = s.tmdbKey;
  if (tdb) {
    const m = tdb.meta();
    const built = m.built_at ? new Date(m.built_at.replace(' ', 'T') + 'Z').toLocaleString('de-CH') : '–';
    const num = (v) => (v ? Number(v).toLocaleString('de-CH') : '–');
    $('#stats').innerHTML = `<dt>Built</dt><dd>${built}</dd><dt>Titles</dt><dd>${num(m.title_count)}</dd>
      <dt>DE/CH/AT titles</dt><dd>${num(m.aka_count)}</dd><dt>Similar lists</dt><dd>${num(m.similar_count)}</dd>
      <dt>Min. votes</dt><dd>${m.min_votes ?? '–'}</dd>
      <dt>Netflix</dt><dd>${netflixRegion ? `${num(m[`netflix_${netflixRegion}_count`])} titles in ${netflixRegion}` : 'no data yet'}</dd>`;
    const regions = tdb.netflixRegions();
    const sel = $('#region');
    const all = [...new Set([...regions, s.region])];
    sel.innerHTML = all.map((r) => `<option value="${r}" ${r === s.region ? 'selected' : ''}>${r}${regions.includes(r) ? '' : ' (no data)'}</option>`).join('');
  }
  $('#clear-history').textContent = `Clear recently opened (${history.all().length})`;
}

$('#tmdb-key').addEventListener('change', (e) => { settings.set({ tmdbKey: e.target.value.trim() }); posterCache.clear(); toast('Saved'); });
$('#region').addEventListener('change', (e) => { settings.set({ region: e.target.value }); loadNetflix(); renderSettings(); showResults(); });
$('#clear-history').addEventListener('click', () => { history.clear(); renderSettings(); showResults(); toast('Cleared'); });
$('#lock').addEventListener('click', async () => { await forgetKey(); location.reload(); });
$('#update-data').addEventListener('click', () => refreshData({ quiet: false }));

async function refreshData({ quiet }) {
  const btn = $('#update-data'), prog = $('#update-progress');
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const fresh = await openDatabase({ force: true, onProgress: (g, t) => { prog.hidden = false; prog.value = t ? g / t : 0; } });
    tdb?.db.close();
    tdb = fresh;
    loadNetflix();
    renderSettings();
    showResults();
    if (!quiet) toast('Data updated');
  } catch (err) {
    if (!quiet) toast(`Update failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Update data'; prog.hidden = true;
  }
}

// =============== service worker ===============
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is best-effort */ });
}

window.screenrate = { get tdb() { return tdb; }, search: (s) => searchTitles(tdb, s), openTitle, closeSheet };

boot();
