// IMDb ratings export → rows. Only ids, ratings and dates are read: other columns follow the IMDb
// account language (`Fernsehserie`, `Komödie`), so the film database stays the source for those.

/** Minimal RFC 4180 parser: quotes, escaped quotes, commas and newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** @returns {{rows: {tconst, rating, ratedAt}[], skipped: number}} @throws Error if not a ratings export */
export function parseRatings(text) {
  const [header, ...lines] = parseCsv(text.replace(/^﻿/, ''));
  const col = (name) => (header || []).findIndex((h) => h.trim().toLowerCase() === name);
  const id = col('const'), rate = col('your rating'), date = col('date rated');
  if (id < 0 || rate < 0) throw new Error('This is not an IMDb ratings export (columns Const and Your Rating are missing)');
  const rows = [];
  let skipped = 0;
  for (const line of lines) {
    const tconst = line[id]?.trim(), rating = Number(line[rate]);
    if (!/^tt\d+$/.test(tconst || '') || !Number.isInteger(rating) || rating < 1 || rating > 10) { skipped++; continue; }
    const d = date >= 0 ? line[date]?.trim() : '';
    rows.push({ tconst, rating, ratedAt: /^\d{4}-\d{2}-\d{2}/.test(d || '') ? d : null });
  }
  return { rows, skipped };
}
