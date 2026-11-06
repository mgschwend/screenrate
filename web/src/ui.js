// DOM rendering: result rows, watchlist, detail sheet with similar titles, toast.
import { watchlist, settings } from './store.js';
import { posterFor } from './tmdb.js';

export const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_LABEL = { movie: 'Film', tvSeries: 'Series', tvMiniSeries: 'Mini-series' };
export const fmtRating = (r) => (r == null ? '–' : Number(r).toFixed(1));
const fmtVotes = (v) => {
  const n = Number(v);
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
};
const typeLabel = (t) => TYPE_LABEL[t] || t || '';
export const imdbUrl = (tconst) => `https://www.imdb.com/title/${tconst}/`;

// ---------- toast ----------
let toastTimer;
export function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? '<button type="button">' + esc(action.label) + '</button>' : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 5000 : 2500);
}

// ---------- result rows (search results, recently opened, watchlist) ----------
function rowHtml(t) {
  const sub = [t.year, typeLabel(t.type)].filter(Boolean).join(' · ');
  return `<div class="t"><b>${t.netflix ? '<span class="nf" title="On Netflix">N</span>' : ''}${esc(t.title)}</b>
      <small>${esc(sub)}${t.akaTitle ? ` · <i>${esc(t.akaTitle)}</i>` : ''}</small></div>
    <div class="r"><span class="rating">★ ${fmtRating(t.rating)}</span>${t.votes ? `<small>${fmtVotes(t.votes)}</small>` : ''}</div>
    <a class="imdb" href="${imdbUrl(t.tconst)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(t.title)} on IMDb">IMDb</a>`;
}

/** Render rows into `ol`; tapping a row opens it, the IMDb pill opens IMDb. */
export function renderRows(ol, rows, onOpen) {
  ol.innerHTML = '';
  for (const t of rows) ol.append(rowLi(t, onOpen));
}

function rowLi(t, onOpen) {
  const li = document.createElement('li');
  li.tabIndex = 0;
  li.innerHTML = rowHtml(t);
  li.querySelector('.imdb').addEventListener('click', (e) => e.stopPropagation());
  li.addEventListener('click', () => onOpen(t));
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === li) onOpen(t); });
  return li;
}

// ---------- watchlist ----------
export function renderWatchlist(onOpen) {
  const rows = watchlist.all();
  const ol = $('#watchlist');
  ol.innerHTML = '';
  $('#watchlist-empty').hidden = rows.length > 0;
  for (const w of rows) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = rowHtml(markNetflix(w));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === li) onOpen(w); });
    attachRemoveGestures(li, () => {
      watchlist.remove(w.tconst);
      renderWatchlist(onOpen);
      toast(`Removed “${w.title}”`, { label: 'Undo', run: () => { watchlist.restore(w); renderWatchlist(onOpen); } });
    }, () => onOpen(w));
    ol.append(li);
  }
}

/** Swipe left (>90px) or long-press (600ms) removes; a plain tap opens. */
function attachRemoveGestures(li, onRemove, onTap) {
  let x0 = 0, y0 = 0, dx = 0, pressTimer = null, moved = false, removed = false;
  li.querySelector('.imdb').addEventListener('click', (e) => e.stopPropagation());
  li.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.imdb')) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; moved = false; removed = false;
    pressTimer = setTimeout(() => { removed = true; navigator.vibrate?.(20); onRemove(); }, 600);
  });
  li.addEventListener('pointermove', (e) => {
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) { moved = true; clearTimeout(pressTimer); }
    if (Math.abs(mx) > Math.abs(my)) { dx = Math.min(0, mx); li.style.transform = `translateX(${dx}px)`; }
  });
  li.addEventListener('pointerup', (e) => {
    clearTimeout(pressTimer);
    if (removed || e.target.closest('.imdb')) return;
    if (dx < -90) { removed = true; onRemove(); return; }
    li.style.transform = '';
    if (!moved) onTap();
  });
  li.addEventListener('pointercancel', () => { clearTimeout(pressTimer); li.style.transform = ''; });
  li.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- detail sheet ----------
let sheetOnClose = null;

export function closeSheet() {
  $('#sheet').hidden = true;
  const cb = sheetOnClose; sheetOnClose = null;
  cb?.();
}

function setupSheetOnce() {
  if (setupSheetOnce.done) return;
  setupSheetOnce.done = true;
  $('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  const panel = $('.sheet-panel');
  let y0 = null;
  panel.addEventListener('touchstart', (e) => { y0 = panel.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeSheet();
    y0 = null;
  });
}

function cardHtml(c) {
  return `<button type="button" class="card" data-tconst="${esc(c.tconst)}">
    <div class="poster-wrap"><div class="poster" data-poster="${esc(c.tconst)}">${esc(c.title)}</div>${c.netflix ? '<span class="nf nf-card">N</span>' : ''}</div>
    <span><b>${esc(c.title)}</b>${esc(c.year ?? '')} · ★ ${fmtRating(c.rating)}</span></button>`;
}

/**
 * Posters paint over a fixed-size frame, so nothing moves when they arrive. With a key the frame stays
 * blank until the answer is in (the title only shows when there is no poster); an image is added once
 * decoded, and fades in only if it had to be fetched.
 */
function fillPosters(root) {
  const hasKey = !!settings.get().tmdbKey;
  for (const el of root.querySelectorAll('[data-poster]')) {
    if (!hasKey || el.dataset.filled) continue;
    el.dataset.filled = '1';
    el.classList.add('pending');
    const started = performance.now();
    const show = async (url) => {
      if (!url) return;
      const img = new Image();
      img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = url;
      await img.decode();
      if (performance.now() - started > 80) img.classList.add('fade');
      el.append(img);
    };
    posterFor(el.dataset.poster).then(show).catch(() => {}).finally(() => el.classList.remove('pending'));
  }
}

function stripSection(id, heading, rows) {
  return `<section id="${id}" ${rows.length ? '' : 'hidden'}><h3>${esc(heading)}</h3>
    <div class="strip">${rows.map(cardHtml).join('')}</div></section>`;
}

/** Same footprint as a loaded strip, so Similar doesn't jump when recommendations arrive. */
function stripSkeleton(id, heading) {
  const card = '<div class="card skel" aria-hidden="true"><div class="poster"></div><span><b></b></span></div>';
  return `<section id="${id}"><h3>${esc(heading)}</h3><div class="strip">${card.repeat(10)}</div></section>`;
}

/**
 * Detail sheet for `title`.
 * @param similar   local IMDb-based similar titles (sync)
 * @param recommend Promise of TMDB recommendations (optional; shown on top when it resolves non-empty)
 * @param onOpen    open another title (a tapped card)
 */
/**
 * Netflix line: precomputed status (weekly) replaced by the live TMDB check when it resolves.
 * netflix = {region, on: boolean|null, asOf}  — on=null → no precomputed data for this region
 */
function netflixHtml(netflix, live) {
  const status = !netflix || netflix.on == null ? (live ? `<p class="avail no">Netflix (${esc(netflix?.region || '')})</p>` : '')
    : `<p class="avail ${netflix.on ? 'yes' : 'no'}">${netflix.on ? '<span class="nf">N</span> On Netflix' : 'Not on Netflix'}
    (${esc(netflix.region)})<small> · as of ${esc(netflix.asOf || '–')}</small></p>`;
  if (!status) return '';
  return `${status}${live ? '<p class="streams muted" id="streams-note">Checking streaming services…</p>' : ''}
    <p class="jw">Streaming data: JustWatch (via TMDB)</p>`;
}

let markNetflix = (t) => t;
export function setNetflixMarker(fn) { markNetflix = fn; }

export function openSheet({ title, similar = [], recommend, netflix, providers, onOpen, onClose }) {
  setupSheetOnce();
  sheetOnClose = onClose || null;
  const body = $('#sheet-body');
  const inWl = watchlist.has(title.tconst);
  const live = !!settings.get().tmdbKey;
  const sub = [title.year, typeLabel(title.type),
    title.originalTitle && title.originalTitle !== title.title ? `“${title.originalTitle}”` : ''].filter(Boolean).join(' · ');
  body.innerHTML = `
    <div class="detail-head">
      <div class="ph" data-poster="${esc(title.tconst)}"></div>
      <div><h2 id="sheet-title">${esc(title.title)}</h2><p class="sub">${esc(sub)}</p>
        ${title.genres ? `<p class="sub genres">${esc(title.genres.replaceAll(',', ' · '))}</p>` : ''}</div>
    </div>
    <div class="big-rating"><span class="rating">★ ${fmtRating(title.rating)}</span><small>${Number(title.votes).toLocaleString('de-CH')} votes on IMDb</small></div>
    <div class="links">
      <a href="${imdbUrl(title.tconst)}" target="_blank" rel="noopener noreferrer">IMDb</a>
      <a href="https://letterboxd.com/imdb/${esc(title.tconst)}/" target="_blank" rel="noopener noreferrer">Letterboxd</a>
    </div>
    <div id="avail">${netflixHtml(netflix, live)}</div>
    <button type="button" class="wl-btn ${inWl ? 'on' : ''}">${inWl ? '✓ On watchlist' : '+ Add to watchlist'}</button>
    ${live ? stripSkeleton('recs', 'Recommended (TMDB)') : ''}
    ${stripSection('similar', 'Similar', similar)}`;

  const btn = body.querySelector('.wl-btn');
  btn.onclick = () => {
    if (watchlist.has(title.tconst)) watchlist.remove(title.tconst); else watchlist.add(title);
    const on = watchlist.has(title.tconst);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '✓ On watchlist' : '+ Add to watchlist';
  };

  const wireCards = (root) => {
    for (const card of root.querySelectorAll('.card')) card.onclick = () => onOpen(card.dataset.tconst);
    fillPosters(root);
  };
  wireCards(body);

  providers?.then((p) => {
    const box = body.querySelector('#avail');
    if (!box?.isConnected) return;
    if (!p) { const note = box.querySelector('#streams-note'); if (note) note.textContent = 'No live streaming data for this title.'; return; }
    const list = p.flatrate.length ? p.flatrate.map(esc).join(', ') : 'no subscription service';
    box.innerHTML = `<p class="avail ${p.netflix ? 'yes' : 'no'}">${p.netflix ? '<span class="nf">N</span> On Netflix' : 'Not on Netflix'} (${esc(netflix?.region || '')}) <small>· live</small></p>
      <p class="streams">Streaming in ${esc(netflix?.region || '')}: ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">${list}</a>` : list}</p>
      <p class="jw">Streaming data: JustWatch (via TMDB)</p>`;
  });

  recommend?.then((rows) => {
    const sec = body.querySelector('#recs');
    if (!sec?.isConnected) return;
    if (!rows.length) { sec.remove(); return; }
    sec.outerHTML = stripSection('recs', 'Recommended (TMDB)', rows.map(markNetflix));
    wireCards(body.querySelector('#recs'));
  });

  $('#sheet').hidden = false;
  $('.sheet-panel').scrollTop = 0;
}
