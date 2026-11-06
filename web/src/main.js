import './style.css';
import { api, LoginRequired } from './api.js';
import { openDatabase, forgetDatabase } from './dataload.js';
import { suggest, finalScore } from './foryou.js';
import { buildTaste } from './taste.js';
import { searchTitles, MIN_CHARS } from './search.js';
import { account, clearAccount, history, ratings, settings, shared, skipped, watchlist } from './store.js';
import { recommendationsFor, providersFor } from './tmdb.js';
import { $, NEEDS_NET, fillPosters, toast, renderRows, renderWatchlist, openSheet, closeSheet, setNetflixMarker } from './ui.js';

let tdb = null;
let netflix = new Set();   // tconsts on Netflix in the chosen region (precomputed nightly)
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
  langKey = null;
  renderLanguageFilters();
}
const mark = (t) => ({ ...t, netflix: netflix.has(t.tconst), mine: ratings.get(t.tconst) });
setNetflixMarker(mark);

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

// ---- original language: one filter shared by search, Discover and For you ----
const LANGUAGES = [['', 'All'], ['en', 'EN'], ['fr', 'FR'], ['es', 'ES'], ['en,fr,es', 'E F S']];
let langKey = null, langSet = null;

/** Titles in the chosen language(s), or null when there's no filter. Cached until the choice or database changes. */
function languageFilter() {
  const chosen = tdb.hasLanguages() ? settings.get().language : '';
  if (!chosen) return null;
  if (chosen !== langKey) { langKey = chosen; langSet = tdb.languageSet(chosen.split(',')); }
  return langSet;
}
const chosenLangs = () => (tdb.hasLanguages() && settings.get().language ? settings.get().language.split(',') : []);
const languageLabel = () => (chosenLangs().length ? ` in ${chosenLangs().map((c) => new Intl.DisplayNames(['en'], { type: 'language' }).of(c)).join(', ')}` : '');

function renderLanguageFilters() {
  const on = tdb.hasLanguages();
  const value = settings.get().language;
  for (const sel of document.querySelectorAll('.lang-filter')) {
    if (!sel.options.length) sel.innerHTML = LANGUAGES.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
    sel.hidden = !on;
    sel.value = value;
    sel.classList.toggle('on', !!value);
  }
}
for (const sel of document.querySelectorAll('.lang-filter')) {
  sel.addEventListener('change', (e) => {
    settings.set({ language: e.target.value });
    renderLanguageFilters();
    if (!$('#view-search').hidden) showResults();
    if (!$('#view-discover').hidden) renderDiscover();
    if (!$('#view-foryou').hidden) renderForYou();
  });
}

/** Rows in the given order, with status marks; titles missing from the database are left out. */
function rowsFor(items) {
  const byId = new Map(tdb.many(items.map((i) => i.tconst)).map((t) => [t.tconst, t]));
  return items.filter((i) => byId.has(i.tconst)).map((i) => mark({ ...byId.get(i.tconst), ...i }));
}

// =============== boot / login ===============
async function boot() {
  registerServiceWorker();
  $('#boot-status').textContent = 'Opening database…';
  try {
    tdb = await openDatabase();
    startApp();
  } catch (err) {
    if (err instanceof LoginRequired) return showLogin();
    $('#boot-status').textContent = `Could not open database: ${err.message}`;
  }
}

function showLogin(msg = '') {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-status').textContent = msg;
  $('#username').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#login-form button');
  const prog = $('#login-progress');
  btn.disabled = true;
  $('#login-status').textContent = 'Logging in…';
  try {
    await api.login($('#username').value, $('#password').value);
    $('#password').value = '';
    $('#login-status').textContent = 'Loading the film database…';
    tdb = tdb || await openDatabase({ onProgress: (got, total) => { prog.hidden = false; prog.value = total ? got / total : 0; } });
    $('#login').hidden = true;
    startApp();
  } catch (err) {
    $('#login-status').textContent = err.status === 401 || err.status === 429 ? err.message : `Failed: ${err.message}`;
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
  syncAccount();
  checkForNewData();
  if (matchMedia('(hover: hover) and (min-width: 700px)').matches) $('#q').focus();
}

/** Refresh the local copy of everything personal. Offline just keeps the last copy. */
async function syncAccount() {
  try {
    const me = await api.me();
    account.set(me);
    await Promise.all([ratings.sync(), shared.sync(), watchlist.sync(), settings.sync()]);
    loadNetflix();
    renderSettings();
    if (!$('#view-search').hidden) showResults();
    if (!$('#view-watchlist').hidden) renderWatchlist(openTitle, rowsFor);
    if (!$('#view-foryou').hidden) renderForYou();
    if (!$('#view-discover').hidden) renderDiscover();
  } catch (err) {
    if (err instanceof LoginRequired) showLogin('Please log in again.');
  }
}

/** The server publishes a version next to the database; re-download quietly when it differs. */
async function checkForNewData() {
  try {
    const { built_at: remote } = await api.version();
    if (remote && remote !== tdb.meta().built_at) refreshData({ quiet: true });
  } catch { /* offline or logged out: keep the cached DB */ }
}

// =============== tabs ===============
function showView(name) {
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x.dataset.view === name);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  if (name === 'watchlist') renderWatchlist(openTitle, rowsFor);
  if (name === 'settings') renderSettings();
  if (name === 'foryou') renderForYou();
  if (name === 'discover') renderDiscover();
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
  const inLang = languageFilter();
  const keep = (r) => !inLang || inLang.has(r.tconst);
  if (text.replace(/\s/g, '').length < MIN_CHARS && nfOnly) {
    const rows = tdb.netflixTop(netflixRegion, inLang ? 6000 : 50).filter(keep).slice(0, 50);
    $('#list-head').hidden = false;
    $('#list-head').textContent = `Most popular on Netflix ${netflixRegion}${languageLabel()}`;
    renderRows(list, rows.map(mark), openTitle);
    empty.hidden = rows.length > 0;
    empty.textContent = 'Nothing on Netflix in that language.';
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
  const filtered = nfOnly || !!inLang;
  let rows = searchTitles(tdb, text, filtered ? 5000 : 30, { wide: filtered }).map(mark);
  if (filtered) rows = rows.filter((r) => (!nfOnly || r.netflix) && keep(r)).slice(0, 30);
  $('#list-head').hidden = false;
  $('#list-head').textContent = (rows.length ? `${rows.length}${rows.length === 30 ? '+' : ''} result${rows.length === 1 ? '' : 's'}` : 'No results')
    + (nfOnly ? ` on Netflix ${netflixRegion}` : '') + languageLabel();
  renderRows(list, rows, openTitle);
  list.scrollTop = 0;
  empty.hidden = rows.length > 0;
  empty.textContent = nfOnly ? `Nothing on Netflix ${netflixRegion} for “${text}”${languageLabel()}. Tap “N” to show everything.`
    : `Nothing found for “${text}”${languageLabel()}.`;
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
    context: tdb.ratingContext(title.tconst),
    similar: similar.map(mark),
    netflix: { region: netflixRegion || settings.get().region, on: netflixRegion ? netflix.has(title.tconst) : null,
      asOf: asOf ? new Date(asOf.replace(' ', 'T') + 'Z').toLocaleDateString('de-CH') : '' },
    providers: providersFor(title.tconst, netflixRegion || settings.get().region),
    recommend: recommendationsFor(tdb, title.tconst, 20),
    onOpen: openTitle,
    onClose: () => {
      if (!$('#view-search').hidden && !q.value.trim()) showResults();
      if (!$('#view-watchlist').hidden) renderWatchlist(openTitle, rowsFor);
      if (!$('#view-foryou').hidden) renderForYou();
      if (!$('#view-discover').hidden) renderDiscover();
    },
  });
}

// =============== discover ===============
const DISCOVER_SHOWN = 60;
const MODE_LABEL = { gems: 'Hidden gems', top: 'Top rated', new: 'New' };

function renderDiscover() {
  const d = settings.get().discover;
  const genreSel = $('#dc-genre');
  if (!genreSel.options.length) {
    genreSel.innerHTML = `<option value="">All genres</option>${tdb.genres().map((g) => `<option>${g}</option>`).join('')}`;
  }
  genreSel.value = d.genre;
  $('#dc-type').value = d.type;
  for (const b of document.querySelectorAll('#dc-modes .chip')) {
    b.classList.toggle('on', b.dataset.mode === d.mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === d.mode));
  }
  const nf = !!netflixRegion && d.netflix;
  const nfBtn = $('#dc-netflix');
  nfBtn.hidden = !netflixRegion;
  nfBtn.classList.toggle('on', nf);
  nfBtn.setAttribute('aria-pressed', String(nf));

  const rated = ratings.all();
  const rows = tdb.discover({ mode: d.mode, type: d.type, genre: d.genre, langs: chosenLangs(), region: nf ? netflixRegion : null })
    .filter((t) => !rated[t.tconst]).slice(0, DISCOVER_SHOWN).map(mark);
  $('#dc-head').textContent = `${MODE_LABEL[d.mode]}${nf ? ` on Netflix ${netflixRegion}` : ''}${languageLabel()}`;
  renderRows($('#discover'), rows, openTitle);
  $('#discover').scrollTop = 0;
  const empty = $('#discover-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = 'Nothing matches. Try another genre or language, or turn off Netflix.';
}

const setDiscover = (patch) => { settings.set({ discover: { ...settings.get().discover, ...patch } }); renderDiscover(); };
$('#dc-modes').addEventListener('click', (e) => { const m = e.target.closest('[data-mode]')?.dataset.mode; if (m) setDiscover({ mode: m }); });
$('#dc-type').addEventListener('change', (e) => setDiscover({ type: e.target.value }));
$('#dc-genre').addEventListener('change', (e) => setDiscover({ genre: e.target.value }));
$('#dc-netflix').addEventListener('click', () => setDiscover({ netflix: !settings.get().discover.netflix }));

// =============== for you ===============
const FOR_YOU_SHOWN = 40;

function renderForYou() {
  const s = settings.get();
  const others = shared.all();
  const together = s.withOthers && others.length > 0;
  const nf = !!netflixRegion && s.forYouNetflix;
  const nfBtn = $('#fy-netflix'), togetherBtn = $('#fy-together');
  nfBtn.hidden = !netflixRegion;
  nfBtn.classList.toggle('on', nf);
  nfBtn.setAttribute('aria-pressed', String(nf));
  togetherBtn.hidden = others.length === 0;
  togetherBtn.classList.toggle('on', together);
  togetherBtn.setAttribute('aria-pressed', String(together));
  if (others.length) togetherBtn.textContent = `With ${others.map((o) => capitalize(o.user)).join(', ')}`;

  const people = [{ name: account.get()?.user || 'me', rated: ratings.all() },
    ...(together ? others.map((o) => ({ name: o.user, rated: o.ratings })) : [])];
  const found = suggest(people, (id) => tdb.similarIds(id));
  const byId = new Map(found.map((f) => [f.tconst, f]));
  const titles = new Map(tdb.many(found.map((f) => f.tconst)).map((t) => [t.tconst, t]));
  const seedNames = new Map(tdb.many([...new Set(found.map((f) => f.seed))]).map((t) => [t.tconst, t.title]));

  let rows = found.filter((f) => titles.has(f.tconst)).map((f) => mark(titles.get(f.tconst)));
  if (nf) rows = rows.filter((t) => t.netflix);
  const inLang = languageFilter();
  if (inLang) rows = rows.filter((t) => inLang.has(t.tconst));
  rows.sort((a, b) => Number(byId.get(b.tconst).shared) - Number(byId.get(a.tconst).shared)
    || finalScore(byId.get(b.tconst), b.rating) - finalScore(byId.get(a.tconst), a.rating));
  rows = rows.slice(0, FOR_YOU_SHOWN).map((t) => {
    const f = byId.get(t.tconst);
    const seed = seedNames.get(f.seed);
    const who = together ? `${capitalize(f.name)} liked` : 'You liked';
    return { ...t, why: seed ? `${f.shared && together ? 'For both of you · ' : ''}${who} ${seed}` : '' };
  });
  renderRows($('#foryou'), rows, openTitle);
  renderTaste();

  const empty = $('#foryou-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = ratings.count() < 3
    ? 'Rate a few films you know, and suggestions appear here.'
    : nf ? 'Nothing on Netflix fits yet. Turn off the filter or rate more films.' : 'Nothing to suggest yet. Rate more films you liked.';
}

function renderTaste() {
  const rated = ratings.all();
  const box = $('#taste');
  const taste = buildTaste(tdb.tasteRows(Object.keys(rated)).map((t) => ({ ...t, rating: rated[t.tconst] })));
  const lines = [['Genres', taste.genres], ['Directors', taste.directors], ['Actors', taste.actors], ['Decades', taste.decades]]
    .filter(([, names]) => names.length);
  box.hidden = lines.length === 0;
  $('#taste-lines').replaceChildren(...lines.flatMap(([label, names]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = names.join(' · ');
    return [dt, dd];
  }));
}

$('#fy-netflix').addEventListener('click', () => { settings.set({ forYouNetflix: !settings.get().forYouNetflix }); renderForYou(); });
$('#fy-together').addEventListener('click', () => { settings.set({ withOthers: !settings.get().withOthers }); renderForYou(); });

// quick rating: one title at a time, most popular first
let quickQueue = [], quickDone = 0;

function showQuickCard() {
  const t = quickQueue[0];
  $('#quick-count').textContent = `${quickDone} rated`;
  const card = $('#quick-card');
  if (!t) { card.innerHTML = '<p>That was the whole list.</p>'; return; }
  card.innerHTML = '<div class="poster"></div><h2></h2><p></p>';
  const poster = card.querySelector('.poster');
  poster.dataset.poster = t.tconst;
  poster.textContent = t.title;
  card.querySelector('h2').textContent = t.title;
  card.querySelector('p').textContent = [t.year, `★ ${Number(t.rating).toFixed(1)}`].filter(Boolean).join(' · ');
  fillPosters(card);
}

$('#quick-rate').addEventListener('click', () => {
  const pass = skipped.all(), rated = ratings.all();
  quickQueue = tdb.popular().filter((t) => !pass.has(t.tconst) && !rated[t.tconst]);
  quickDone = 0;
  $('#quick').hidden = false;
  showQuickCard();
});
$('#quick-done').addEventListener('click', () => { $('#quick').hidden = true; renderForYou(); });
document.querySelector('.quick-buttons').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-rate]');
  const t = quickQueue[0];
  if (!button || !t) return;
  const value = Number(button.dataset.rate);
  if (value) {
    try { await ratings.set(t.tconst, value); } catch { return toast(NEEDS_NET); }
    quickDone += 1;
  } else skipped.add(t.tconst);
  quickQueue.shift();
  showQuickCard();
});

// =============== settings ===============
function renderSettings() {
  const s = settings.get();
  if (tdb) {
    const m = tdb.meta();
    const built = m.built_at ? new Date(m.built_at.replace(' ', 'T') + 'Z').toLocaleString('de-CH') : '–';
    const num = (v) => (v ? Number(v).toLocaleString('de-CH') : '–');
    $('#stats').innerHTML = `<dt>Logged in</dt><dd>${account.get()?.user ? capitalize(account.get().user) : '–'}</dd>
      <dt>Your ratings</dt><dd>${num(ratings.count())}</dd>
      <dt>Built</dt><dd>${built}</dd><dt>Titles</dt><dd>${num(m.title_count)}</dd>
      <dt>DE/CH/AT titles</dt><dd>${num(m.aka_count)}</dd><dt>Similar lists</dt><dd>${num(m.similar_count)}</dd>
      <dt>Netflix</dt><dd>${netflixRegion ? `${num(m[`netflix_${netflixRegion}_count`])} titles in ${netflixRegion}` : 'no data yet'}</dd>
      <dt>Languages</dt><dd>${m.lang_count ? `${num(m.lang_count)} of ${num(m.title_count)} titles` : 'no data yet'}</dd>`;
    const regions = tdb.netflixRegions();
    const sel = $('#region');
    const all = [...new Set([...regions, s.region])];
    sel.innerHTML = all.map((r) => `<option value="${r}" ${r === s.region ? 'selected' : ''}>${r}${regions.includes(r) ? '' : ' (no data)'}</option>`).join('');
  }
  $('#clear-history').textContent = `Clear recently opened (${history.all().length})`;
}

$('#region').addEventListener('change', (e) => { settings.set({ region: e.target.value }); loadNetflix(); renderSettings(); showResults(); });
$('#clear-history').addEventListener('click', () => { history.clear(); renderSettings(); showResults(); toast('Cleared'); });
$('#update-data').addEventListener('click', () => refreshData({ quiet: false }));
$('#logout').addEventListener('click', async () => {
  try { await api.logout(); } catch { return toast(NEEDS_NET); }
  clearAccount();
  await forgetDatabase();
  location.reload();
});

// ---- import: IMDb ratings CSV, or the watchlist file from the old app ----
async function importFile(file) {
  const status = $('#import-status');
  status.textContent = `Reading ${file.name}…`;
  try {
    const text = await file.text();
    if (file.name.endsWith('.json') || text.trimStart().startsWith('[')) {
      const { rows, added } = await api.importWatchlist(JSON.parse(text));
      await watchlist.sync();
      status.textContent = `Watchlist: ${added} added, ${rows - added} already there.`;
    } else {
      const { rows, skipped: bad } = await api.importRatings(text);
      await ratings.sync();
      const known = tdb.many(Object.keys(ratings.all())).length;
      const missing = ratings.count() - known;
      status.textContent = `${rows.toLocaleString('de-CH')} rating${rows === 1 ? '' : 's'} read`
        + `${bad ? `, ${bad} unreadable` : ''}${missing ? `, ${missing} not in the film database` : ''}.`;
    }
    renderSettings();
  } catch (err) {
    status.textContent = err instanceof LoginRequired ? 'Please log in again.' : `Import failed: ${err.message}`;
  }
}

$('#import-file').addEventListener('change', (e) => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = '';
});
const drop = $('#import-drop');
for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); });

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
    if (err instanceof LoginRequired) return showLogin('Please log in again.');
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
