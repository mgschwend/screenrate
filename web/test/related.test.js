import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRelated, ratingFloor } from '../src/related.js';

const t = (tconst, rating, why) => ({ tconst, rating, ...(why ? { why } : {}) });

test('titles in both lists come first, with the local reason', () => {
  const out = mergeRelated([t('a', 8), t('b', 8)], [t('c', 8, 'With X'), t('b', 8, 'Dir. Y')], 8);
  assert.deepEqual(out.map((x) => x.tconst), ['b', 'a', 'c']);
  assert.equal(out[0].why, 'Dir. Y');
  assert.equal(out[1].why, 'Fans also liked');
});

test('weak titles are dropped, relative to a weak source title', () => {
  assert.deepEqual(mergeRelated([t('a', 5.9)], [t('b', 6.5), t('c', 3.9)], 8.6).map((x) => x.tconst), ['b']);
  assert.equal(ratingFloor(6), 5.5);
  assert.deepEqual(mergeRelated([t('a', 5.6)], [], 6).map((x) => x.tconst), ['a']);
  assert.equal(ratingFloor(undefined), 6);
});

test('unrated titles are dropped', () => {
  assert.deepEqual(mergeRelated([t('a', null)], [], 8), []);
});
