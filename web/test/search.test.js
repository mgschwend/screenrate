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
    INSERT INTO netflix VALUES ('CH', 903747), ('CH', 15239678);`);
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

test('Netflix availability per region', () => {
  assert.deepEqual(tdb.netflixRegions(), ['CH']);
  const ch = tdb.netflixSet('CH');
  assert.ok(ch.has('tt0903747'));   // 7-digit id padded
  assert.ok(ch.has('tt15239678'));  // 8-digit id
  assert.ok(!ch.has('tt1160419'));
  assert.equal(tdb.netflixSet('DE').size, 0);
});
