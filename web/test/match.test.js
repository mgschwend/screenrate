// Matching logic against a tiny fixture DB with the real schema (FTS5 via official sqlite-wasm).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { TitleDb } from '../src/titledb.js';
import { resolve, isStop, dice, contextFor, phrases, Voter } from '../src/match.js';
import { normalize } from '../src/normalize.js';

let tdb;
const ROWS = [
  // tconst, type, title, originalTitle, year, rating, votes
  ['tt0113277', 'movie', 'Heat', 'Heat', 1995, 8.3, 823533],
  ['tt0090142', 'movie', 'Heat', 'Heat', 1986, 5.7, 3035],
  ['tt1160419', 'movie', 'Dune', 'Dune', 2021, 8.0, 1100251],
  ['tt0087182', 'movie', 'Dune', 'Dune', 1984, 6.2, 300000], // <5x below 2021 → ambiguous,
  ['tt15239678', 'movie', 'Dune: Part Two', 'Dune: Part Two', 2024, 8.5, 700000],
  ['tt0068646', 'movie', 'The Godfather', 'The Godfather', 1972, 9.2, 2270488],
  ['tt0211915', 'movie', 'Amélie', "Le fabuleux destin d'Amélie Poulain", 2001, 8.3, 800000],
  ['tt0475784', 'tvSeries', 'Westworld', 'Westworld', 2016, 8.5, 550000],
  ['tt0070909', 'movie', 'Westworld', 'Westworld', 1973, 6.9, 65000],
  ['tt0903747', 'tvSeries', 'Breaking Bad', 'Breaking Bad', 2008, 9.5, 2200000],
  ['tt5180504', 'tvSeries', 'The Witcher', 'The Witcher', 2019, 8.0, 600000],
  ['tt0099785', 'movie', 'Home Alone', 'Home Alone', 1990, 7.7, 700000],
];
const AKAS = [['tt0099785', 'Kevin - Allein zu Haus', 'DE'], ['tt0068646', 'Der Pate', 'DE']];

before(async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  const db = new sqlite3.oo1.DB(':memory:');
  db.exec(`
    CREATE TABLE titles (tconst TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, originalTitle TEXT,
      year INTEGER, rating REAL NOT NULL, votes INTEGER NOT NULL, normTitle TEXT NOT NULL, normOriginal TEXT);
    CREATE TABLE akas (tconst TEXT NOT NULL, title TEXT NOT NULL, region TEXT, normTitle TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE titles_fts USING fts5(normTitle, normOriginal, tconst UNINDEXED, tokenize='unicode61');`);
  for (const r of ROWS) db.exec({ sql: 'INSERT INTO titles VALUES (?,?,?,?,?,?,?,?,?)', bind: [...r, normalize(r[2]), normalize(r[3])] });
  for (const a of AKAS) db.exec({ sql: 'INSERT INTO akas VALUES (?,?,?,?)', bind: [...a, normalize(a[1])] });
  db.exec('INSERT INTO titles_fts(normTitle, normOriginal, tconst) SELECT normTitle, normOriginal, tconst FROM titles');
  db.exec("INSERT INTO meta VALUES ('title_count','12')");
  tdb = new TitleDb(db);
});

test('clear winner by 5x votes, alternatives counted', () => {
  const r = resolve(tdb, 'HEAT');
  assert.equal(r.winner.tconst, 'tt0113277');
  assert.equal(r.alternatives, 1);
  assert.equal(r.how, 'exact');
});

test('no clear winner → ambiguous', () => {
  const r = resolve(tdb, 'Dune');
  assert.equal(r.winner, null);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
});

test('year context disambiguates', () => {
  assert.equal(resolve(tdb, 'Dune', { context: { year: 1984 } }).winner.tconst, 'tt0087182');
});

test('series context disambiguates film vs series', () => {
  assert.equal(resolve(tdb, 'Westworld', { context: { series: true } }).winner.tconst, 'tt0475784');
});

test('remembered choice wins before ranking', () => {
  const r = resolve(tdb, 'dune', { remembered: { dune: 'tt0087182' } });
  assert.equal(r.winner.tconst, 'tt0087182');
  assert.equal(r.how, 'remembered');
});

test('German aka and accents', () => {
  assert.equal(resolve(tdb, 'Kevin – Allein zu Haus').winner.tconst, 'tt0099785');
  assert.equal(resolve(tdb, 'Der Pate').winner.tconst, 'tt0068646');
  assert.equal(resolve(tdb, 'AMELIE').winner.tconst, 'tt0211915');
});

test('fuzzy: OCR noise via FTS prefix + Dice ≥ 0.75', () => {
  assert.equal(resolve(tdb, 'Breaking Ba').winner.tconst, 'tt0903747');
  assert.equal(resolve(tdb, 'Dune Part Tw').winner.tconst, 'tt15239678');
  assert.equal(resolve(tdb, 'The Godfathe').winner.tconst, 'tt0068646');
});

test('fuzzy tolerates OCR errors at word ends (loose prefix)', () => {
  assert.equal(resolve(tdb, 'Breaklng Bad').winner.tconst, 'tt0903747');
  assert.equal(resolve(tdb, 'The Witchar').winner.tconst, 'tt5180504');
  assert.equal(resolve(tdb, 'Westwor1d', { context: { series: true } }).winner.tconst, 'tt0475784');
  assert.equal(resolve(tdb, 'The Wltcher').winner.tconst, 'tt5180504'); // mid-word l↔i
  assert.equal(resolve(tdb, 'Home Aione').winner.tconst, 'tt0099785');
  assert.equal(resolve(tdb, 'Breaking Bab'), resolve(tdb, 'Breaking Bab')); // deterministic
  assert.equal(resolve(tdb, 'Home Alcne').winner.tconst, 'tt0099785'); // o↔c
});

test('fuzzy rejects weak matches', () => {
  assert.equal(resolve(tdb, 'The'), null);
  assert.equal(resolve(tdb, 'Godzilla'), null);
  assert.equal(resolve(tdb, 'W HA'), null); // no fuzzy below 5 letters
});

test('stop-list and junk', () => {
  for (const s of ['Continue Watching', 'Weiterschauen', 'Top 10', 'Top 10 in der Schweiz heute', 'Meine Liste',
    'Play', 'Netflix', 'Staffel 2', 'ed', 'Mo', 'S1:E3', '1 Std. 52 Min.', '2019', '16+', '3 Staffeln', 'Neue Folgen', 'x',
    'Ein junger Mann entdeckt, dass seine Familie ein dunkles Geheimnis hat und muss fliehen']) {
    assert.ok(isStop(normalize(s)), `expected stop: ${s}`);
  }
  for (const s of ['Heat', 'The Witcher', 'Breaking Bad', 'Home Alone']) assert.ok(!isStop(normalize(s)), s);
});

test('dice', () => {
  assert.equal(dice('heat', 'heat'), 1);
  assert.ok(dice('breaking ba', 'breaking bad') > 0.85);
  assert.ok(dice('godzilla', 'the godfather') < 0.5);
});

test('context from nearby OCR lines', () => {
  const title = { text: 'Dune', box: { x: 100, y: 100, width: 120, height: 30 } };
  const year = { text: '1984 · 2 Std. 17 Min.', box: { x: 100, y: 140, width: 200, height: 20 } };
  const far = { text: 'Staffel 3', box: { x: 800, y: 600, width: 100, height: 20 } };
  assert.deepEqual(contextFor(title, [title, year, far]), { year: 1984 });
  const season = { text: '3 Staffeln', box: { x: 110, y: 135, width: 90, height: 20 } };
  assert.deepEqual(contextFor(title, [title, season]), { series: true });
});

test('phrases merges same-row adjacent boxes', () => {
  const items = [
    { text: 'Breaking', box: { x: 10, y: 10, width: 80, height: 20 }, confidence: 0.9 },
    { text: 'Bad', box: { x: 95, y: 12, width: 30, height: 20 }, confidence: 0.95 },
    { text: 'Heat', box: { x: 400, y: 10, width: 40, height: 20 }, confidence: 0.9 },
  ];
  assert.deepEqual(phrases(items).map((p) => p.text).sort(), ['Breaking Bad', 'Heat']);
});

test('voter needs 2 distinct frames', () => {
  const v = new Voter(2, 3);
  v.observe(1, ['heat', 'heat']);
  assert.equal(v.confirmed('heat'), false);
  v.observe(2, ['heat']);
  assert.equal(v.confirmed('heat'), true);
  v.observe(10, []);
  assert.equal(v.confirmed('heat'), false);
});
