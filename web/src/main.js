import './style.css';
import { openDatabase, forgetKey } from './dataload.js';
import { searchTitles, MIN_CHARS } from './search.js';
import { history, settings, posterCache } from './store.js';
import { recommendationsFor } from './tmdb.js';
import { $, toast, renderRows, renderWatchlist, openSheet, closeSheet } from './ui.js';

let tdb = null;

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
  showResults();
  renderSettings();
  // DB cached by an older app version (before similar titles)? Refresh it once in the background.
  if (!tdb.hasSimilar()) refreshData({ quiet: true });
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
  if (text.replace(/\s/g, '').length < MIN_CHARS) {
    const recent = history.all().reverse();
    $('#list-head').textContent = 'Recently opened';
    $('#list-head').hidden = recent.length === 0;
    renderRows(list, recent, openTitle);
    empty.hidden = recent.length > 0;
    empty.textContent = 'Type a film or series title — results appear as you type.';
    return;
  }
  const rows = searchTitles(tdb, text);
  $('#list-head').hidden = false;
  $('#list-head').textContent = rows.length ? `${rows.length}${rows.length === 30 ? '+' : ''} results` : 'No results';
  renderRows(list, rows, openTitle);
  list.scrollTop = 0;
  empty.hidden = rows.length > 0;
  empty.textContent = `Nothing found for “${text}”.`;
}

// =============== detail ===============
/** Open a title (row object or tconst): detail sheet with similar titles; remembers it as recently opened. */
function openTitle(t) {
  const title = tdb.get(typeof t === 'string' ? t : t.tconst);
  if (!title) return toast('Title not in the database');
  history.add(title);
  let similar = tdb.similar(title.tconst);
  if (!similar.length) similar = tdb.sameGenre(title.tconst);
  openSheet({
    title,
    similar,
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
      <dt>Min. votes</dt><dd>${m.min_votes ?? '–'}</dd>`;
  }
  $('#clear-history').textContent = `Clear recently opened (${history.all().length})`;
}

$('#tmdb-key').addEventListener('change', (e) => { settings.set({ tmdbKey: e.target.value.trim() }); posterCache.clear(); toast('Saved'); });
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
