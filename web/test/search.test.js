// Live search ranking against a fixture DB with the real schema.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { TitleDb } from '../src/titledb.js';
import { searchTitles } from '../src/search.js';
import { normalize } from '../src/normalize.js';

let tdb;
const ROWS = [
  ['tt1160419', 'movie', 'Dune', 'Dune', 2021, 8.0, 1100251],
  ['tt0087182', 'movie', 'Dune', 'Dune', 1984, 6.2, 194857],
  ['tt15239678', 'movie', 'Dune: Part Two', 'Dune: Part Two', 2024, 8.5, 700000],
  ['tt0068646', 'movie', 'The Godfather', 'The Godfather', 1972, 9.2, 2270488],
  ['tt0071562', 'movie', 'The Godfather Part II', 'The Godfather Part II', 1974, 9.0, 1500000],
  ['tt0099785', 'movie', 'Home Alone', 'Home Alone', 1990, 7.7, 700000],
  ['tt0211915', 'movie', 'Amélie', "Le fabuleux destin d'Amélie Poulain", 2001, 8.3, 800000],
  ['tt0903747', 'tvSeries', 'Breaking Bad', 'Breaking Bad', 2008, 9.5, 2200000],
  ['tt9999999', 'movie', 'Dunkirk', 'Dunkirk', 2017, 7.8, 750000],
];
const AKAS = [['tt0099785', 'Kevin - Allein zu Haus', 'DE'], ['tt0068646', 'Der Pate', 'DE'], ['tt0071562', 'Der Pate 2', 'DE']];

before(async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  const db = new sqlite3.oo1.DB(':memory:');
  db.exec(`
    CREATE TABLE titles (tconst TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, originalTitle TEXT,
      year INTEGER, rating REAL NOT NULL, votes INTEGER NOT NULL, normTitle TEXT NOT NULL, normOriginal TEXT);
    CREATE TABLE akas (tconst TEXT NOT NULL, title TEXT NOT NULL, region TEXT, normTitle TEXT NOT NULL);
    CREATE INDEX idx_akas_norm ON akas(normTitle);
    CREATE VIRTUAL TABLE titles_fts USING fts5(normTitle, normOriginal, tconst UNINDEXED, tokenize='unicode61');`);
  for (const r of ROWS) db.exec({ sql: 'INSERT INTO titles VALUES (?,?,?,?,?,?,?,?,?)', bind: [...r, normalize(r[2]), normalize(r[3])] });
  for (const a of AKAS) db.exec({ sql: 'INSERT INTO akas VALUES (?,?,?,?)', bind: [...a, normalize(a[1])] });
  db.exec('INSERT INTO titles_fts(normTitle, normOriginal, tconst) SELECT normTitle, normOriginal, tconst FROM titles');
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE netflix (region TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (region, id)) WITHOUT ROWID;
    INSERT INTO meta VALUES ('netflix_regions', 'CH');
    INSERT INTO netflix VALUES ('CH', 903747), ('CH', 15239678);
    CREATE TABLE similar (id INTEGER PRIMARY KEY, others TEXT NOT NULL, why TEXT NOT NULL);
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO similar VALUES (903747, '15239678', 'd0');
    INSERT INTO people VALUES (0, 'Vince Gilligan');
    ALTER TABLE titles ADD COLUMN genres TEXT DEFAULT '';
    UPDATE titles SET genres = 'Crime,Drama' WHERE tconst IN ('tt0903747', 'tt0068646');
    UPDATE titles SET genres = 'Action,Adventure' WHERE tconst = 'tt15239678';
    INSERT INTO titles (tconst, type, title, originalTitle, year, rating, votes, normTitle, normOriginal, genres) VALUES
      ('tt8000001', 'movie', 'Qqq Gem', 'Qqq Gem', 2025, 8.1, 80000, 'qqq gem', 'qqq gem', 'Drama'),
      ('tt8000002', 'movie', 'Qqq Quiet', 'Qqq Quiet', 2001, 7.9, 9000, 'qqq quiet', 'qqq quiet', 'Action'),
      ('tt8000003', 'movie', 'Qqq Obscure', 'Qqq Obscure', 2001, 8.9, 3000, 'qqq obscure', 'qqq obscure', 'Action'),
      ('tt8000004', 'movie', 'Qqq Solid', 'Qqq Solid', 2001, 7.9, 150000, 'qqq solid', 'qqq solid', 'Action'),
      ('tt8000005', 'movie', 'Qqq Toon', 'Qqq Toon', 2001, 8.5, 90000, 'qqq toon', 'qqq toon', 'Animation');
    CREATE TABLE title_people (id INTEGER PRIMARY KEY, people TEXT NOT NULL);
    INSERT INTO title_people VALUES (903747, 'd0,a1'); INSERT INTO people VALUES (1, 'Bryan Cranston');
    INSERT INTO netflix VALUES ('XX', 8000001);
    ALTER TABLE titles ADD COLUMN lang TEXT;
    UPDATE titles SET lang = 'fr' WHERE tconst IN ('tt0211915', 'tt8000002');
    UPDATE titles SET lang = 'en' WHERE tconst = 'tt8000001';
    INSERT INTO meta VALUES ('lang_count', '3');`);
  tdb = new TitleDb(db);
});

const ids = (q) => searchTitles(tdb, q).map((r) => r.tconst);

test('exact matches first, then prefix, by votes', () => {
  assert.deepEqual(ids('dune'), ['tt1160419', 'tt0087182', 'tt15239678']);
  assert.deepEqual(ids('dun'), ['tt1160419', 'tt9999999', 'tt15239678', 'tt0087182']);
});

test('multi-word prefix', () => {
  assert.equal(ids('dune par')[0], 'tt15239678');
  assert.equal(ids('godf part')[0], 'tt0071562');
});

test('German aliases, shown via akaTitle', () => {
  const r = searchTitles(tdb, 'der pate');
  assert.equal(r[0].tconst, 'tt0068646');
  assert.equal(r[0].akaTitle, 'Der Pate');
  assert.ok(ids('kevin').includes('tt0099785'));
  assert.ok(ids('allein zu').includes('tt0099785')); // phrase inside the alias
  assert.equal(searchTitles(tdb, 'dune')[0].akaTitle, undefined); // no alias label when equal
});

test('accents and case', () => {
  assert.equal(ids('AMELIE')[0], 'tt0211915');
});

test('typo fallback', () => {
  assert.equal(ids('braking bad')[0], 'tt0903747');
});

test('too short / nonsense', () => {
  assert.deepEqual(ids('d'), []);
  assert.deepEqual(ids('zzzzqq'), []);
});

test('Discover: modes, filters and Netflix', () => {
  const ids2 = (o) => tdb.discover({ year: 2026, ...o }).map((t) => t.tconst);
  assert.deepEqual(ids2({ mode: 'gems' }), ['tt8000001', 'tt8000004']); // not too famous, not too obscure
  assert.deepEqual(ids2({ mode: 'gems', region: 'XX' }), ['tt8000001']);
  assert.deepEqual(ids2({ mode: 'gems', genre: 'Animation' }), ['tt8000005']); // left out unless asked for
  assert.equal(ids2({ mode: 'top' })[0], 'tt0903747');
  assert.deepEqual(ids2({ mode: 'top', type: 'series' }), ['tt0903747']);
  assert.deepEqual(ids2({ mode: 'top', genre: 'Crime', type: 'film' }), ['tt0068646']);
  assert.ok(!ids2({ mode: 'top', genre: 'Drama' }).includes('tt1160419'));
  assert.deepEqual(ids2({ mode: 'new' }), ['tt15239678', 'tt8000001']); // 2024 and 2025, best first
  assert.deepEqual(tdb.genres(), ['Action', 'Adventure', 'Animation', 'Crime', 'Drama']);
});

test('original language filter', () => {
  assert.ok(tdb.hasLanguages());
  assert.deepEqual([...tdb.languageSet(['fr'])].sort(), ['tt0211915', 'tt8000002']);
  assert.equal(tdb.languageSet(['en', 'fr']).size, 3);
  assert.equal(tdb.get('tt0211915').lang, 'fr');
  assert.deepEqual(tdb.discover({ mode: 'gems', langs: ['en'], year: 2026 }).map((t) => t.tconst), ['tt8000001']);
  assert.deepEqual(tdb.discover({ mode: 'top', langs: ['fr'], year: 2026 }).map((t) => t.tconst), ['tt0211915']);
});

test('rating context picks a big enough genre', () => {
  assert.equal(tdb.ratingContext('tt0903747'), null); // no genre reaches 100 titles here
  assert.deepEqual(tdb.ratingContext('tt0903747', 1), { pct: 100, genre: 'Crime', kind: 'series' });
  assert.deepEqual(tdb.ratingContext('tt0068646', 1), { pct: 50, genre: 'Drama', kind: 'films' }); // its better genre
  assert.equal(tdb.ratingContext('tt0000001', 1), null);
});

test('credits for the taste profile', () => {
  const [row] = tdb.tasteRows(['tt0903747', 'tt0000001']);
  assert.deepEqual(row.people, [{ role: 'd', name: 'Vince Gilligan' }, { role: 'a', name: 'Bryan Cranston' }]);
  assert.deepEqual(row.genres, ['Crime', 'Drama']);
});

test('a wide search looks past the usual top matches', () => {
  const limits = [];
  const fake = { exact: () => [], akaPrefix: (_, n) => { limits.push(n); return []; }, akaContains: (_, n) => { limits.push(n); return []; },
    prefix: (_, n) => { limits.push(n); return []; } };
  searchTitles(fake, 'the');
  assert.deepEqual(limits, [40, 80, 30]);
  limits.length = 0;
  searchTitles(fake, 'the', 5000, { wide: true });
  assert.deepEqual(limits, [5000, 5000, 5000]);
});

test('Netflix availability per region', () => {
  assert.deepEqual(tdb.netflixRegions(), ['CH']);
  const ch = tdb.netflixSet('CH');
  assert.ok(ch.has('tt0903747'));   // 7-digit id padded
  assert.ok(ch.has('tt15239678'));  // 8-digit id
  assert.ok(!ch.has('tt1160419'));
  assert.equal(tdb.netflixSet('DE').size, 0);
  const top = tdb.netflixTop('CH');
  assert.equal(top.length, 2);
  assert.ok(top.every((t) => ch.has(t.tconst)));
  assert.ok(top[0].votes >= top[1].votes);
  assert.deepEqual(tdb.netflixTop('DE'), []);
  const sim = tdb.similar('tt0903747');
  assert.equal(sim[0].tconst, 'tt15239678');
  assert.equal(sim[0].why, 'Dir. Vince Gilligan');
});
