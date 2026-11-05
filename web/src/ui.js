// DOM rendering: history list, watchlist, detail sheet / picker, toast.
import { history, watchlist, remembered } from './store.js';
import { posterFor } from './tmdb.js';

export const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_LABEL = { movie: 'Film', tvSeries: 'Series', tvMiniSeries: 'Mini-series' };
export const fmtRating = (r) => (r == null ? '–' : Number(r).toFixed(1));
const fmtVotes = (v) => Number(v).toLocaleString('de-CH');
const typeLabel = (t) => TYPE_LABEL[t] || t || '';

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

// ---------- history ----------
function historyRowHtml(r) {
  const known = !!r.tconst;
  return `<div class="t"><b>${esc(r.title)}</b><small>${known ? [r.year, typeLabel(r.type)].filter(Boolean).join(' · ') : 'Tap to pick the right title'}</small></div>
    <span class="rating ${known ? '' : 'q'}">${known ? fmtRating(r.rating) : '?'}</span>`;
}

export function renderHistory(onOpen) {
  const ol = $('#history');
  ol.innerHTML = '';
  for (const r of history.all()) ol.append(historyLi(r, onOpen));
  ol.scrollTop = ol.scrollHeight;
}

function historyLi(r, onOpen) {
  const li = document.createElement('li');
  li.dataset.id = r.id;
  li.innerHTML = historyRowHtml(r);
  li.onclick = () => onOpen(history.all().find((x) => x.id === r.id) || r);
  return li;
}

/** Append a row at the bottom (existing rows never move). */
export function appendHistory(r, onOpen) {
  const ol = $('#history');
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  const li = historyLi(r, onOpen);
  li.classList.add('fresh');
  ol.append(li);
  if (atBottom) ol.scrollTop = ol.scrollHeight;
}

/** Update a row in place (after the user picked/switched the title). */
export function refreshHistoryRow(r) {
  const li = $(`#history li[data-id="${CSS.escape(r.id)}"]`);
  if (li) li.innerHTML = historyRowHtml(r);
}

// ---------- watchlist ----------
export function renderWatchlist(onOpen) {
  const rows = watchlist.all();
  const ol = $('#watchlist');
  ol.innerHTML = '';
  $('#watchlist-empty').hidden = rows.length > 0;
  for (const w of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="t"><b>${esc(w.title)}</b><small>${esc(w.year ?? '')}</small></div><span class="rating">${fmtRating(w.rating)}</span>`;
    attachRemoveGestures(li, () => {
      watchlist.remove(w.tconst);
      renderWatchlist(onOpen);
      toast(`Removed “${w.title}”`, { label: 'Undo', run: () => { watchlist.restore(w); renderWatchlist(onOpen); } });
    }, () => onOpen(w.tconst));
    ol.append(li);
  }
}

/** Swipe left (>90px) or long-press (600ms) removes; a plain tap opens. */
function attachRemoveGestures(li, onRemove, onTap) {
  let x0 = 0, y0 = 0, dx = 0, pressTimer = null, moved = false, removed = false;
  li.addEventListener('pointerdown', (e) => {
    x0 = e.clientX; y0 = e.clientY; dx = 0; moved = false; removed = false;
    pressTimer = setTimeout(() => { removed = true; navigator.vibrate?.(20); onRemove(); }, 600);
  });
  li.addEventListener('pointermove', (e) => {
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) { moved = true; clearTimeout(pressTimer); }
    if (Math.abs(mx) > Math.abs(my)) { dx = Math.min(0, mx); li.style.transform = `translateX(${dx}px)`; }
  });
  const end = () => {
    clearTimeout(pressTimer);
    if (removed) return;
    if (dx < -90) { removed = true; onRemove(); return; }
    li.style.transform = '';
    if (!moved) onTap();
  };
  li.addEventListener('pointerup', end);
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
  // swipe the panel down to close
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
    <div class="poster" data-poster="${esc(c.tconst)}">${esc(c.title)}</div>
    <span><b>${esc(c.title)}</b>${esc(c.year ?? '')} · ${esc(typeLabel(c.type))} · ★ ${fmtRating(c.rating)}</span></button>`;
}

function fillPosters(root) {
  for (const el of root.querySelectorAll('[data-poster]')) {
    posterFor(el.dataset.poster).then((url) => {
      if (!url || !el.isConnected) return;
      const img = new Image();
      img.className = el.className; img.alt = ''; img.src = url; img.referrerPolicy = 'no-referrer';
      img.onload = () => el.replaceWith(img);
    });
  }
}

/**
 * Show details for `title`, or a picker when `title` is null.
 * @param opts {title, candidates, norm, seenText, onChoose(tconst)}
 */
export function openSheet({ title, candidates = [], norm, seenText, onChoose, onClose }) {
  setupSheetOnce();
  sheetOnClose = onClose || null;
  const body = $('#sheet-body');
  const others = candidates.filter((c) => !title || c.tconst !== title.tconst);

  if (!title) {
    body.innerHTML = `<h2 id="sheet-title" style="margin:0 0 .3rem">Which one?</h2>
      ${seenText ? `<p class="seen">Seen on screen: “${esc(seenText)}”</p>` : ''}
      <div class="strip">${others.map(cardHtml).join('')}</div>
      <p class="seen">Your choice is remembered for this title.</p>`;
  } else {
    const inWl = watchlist.has(title.tconst);
    const sub = [title.year, typeLabel(title.type),
      title.originalTitle && title.originalTitle !== title.title ? `“${title.originalTitle}”` : ''].filter(Boolean).join(' · ');
    body.innerHTML = `
      <div class="detail-head">
        <div class="ph" data-poster="${esc(title.tconst)}"></div>
        <div><h2 id="sheet-title">${esc(title.title)}</h2><p class="sub">${esc(sub)}</p></div>
      </div>
      <div class="big-rating"><span class="rating">★ ${fmtRating(title.rating)}</span><small>${fmtVotes(title.votes)} votes on IMDb</small></div>
      <div class="links">
        <a href="https://www.imdb.com/title/${esc(title.tconst)}/" target="_blank" rel="noopener noreferrer">IMDb</a>
        <a href="https://letterboxd.com/imdb/${esc(title.tconst)}/" target="_blank" rel="noopener noreferrer">Letterboxd</a>
      </div>
      <button type="button" class="wl-btn ${inWl ? 'on' : ''}">${inWl ? '✓ On watchlist' : '+ Add to watchlist'}</button>
      ${others.length ? `<h3>Not this one? ${others.length} other match${others.length > 1 ? 'es' : ''}</h3>
        <div class="strip">${others.map(cardHtml).join('')}</div>` : ''}`;
    const btn = body.querySelector('.wl-btn');
    btn.onclick = () => {
      if (watchlist.has(title.tconst)) watchlist.remove(title.tconst); else watchlist.add(title);
      const on = watchlist.has(title.tconst);
      btn.classList.toggle('on', on);
      btn.textContent = on ? '✓ On watchlist' : '+ Add to watchlist';
    };
  }

  for (const card of body.querySelectorAll('.card')) {
    card.onclick = () => {
      const chosen = candidates.find((c) => c.tconst === card.dataset.tconst);
      if (norm) remembered.set(norm, chosen.tconst);
      onChoose?.(chosen);
      openSheet({ title: chosen, candidates, norm, seenText, onChoose, onClose: sheetOnClose });
    };
  }
  fillPosters(body);
  $('#sheet').hidden = false;
  $('.sheet-panel').scrollTop = 0;
}
