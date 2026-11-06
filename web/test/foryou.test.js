import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, tasteScores, finalScore } from '../src/foryou.js';

const graph = { a: ['x', 'y', 'seen'], b: ['y', 'z'], bad: ['z'], c: ['q'] };
const similarOf = (id) => graph[id] || [];

test('liked titles add, disliked titles subtract, middling ones do nothing', () => {
  const s = tasteScores({ a: 10, bad: 3, b: 7 }, similarOf);
  assert.ok(s.get('x').score > 0);
  assert.ok(s.get('z').score < 0);
  assert.equal(s.get('x').seed, 'a');
});

test('rated titles are never suggested, negatives are dropped', () => {
  const out = suggest([{ name: 'marc', rated: { a: 10, seen: 8, bad: 2 } }], similarOf);
  assert.deepEqual(out.map((s) => s.tconst), ['x', 'y']);
});

test('titles both people would like come first', () => {
  const out = suggest([{ name: 'marc', rated: { a: 10 } }, { name: 'thomas', rated: { b: 10 } }], similarOf);
  assert.equal(out[0].tconst, 'y');
  assert.ok(out[0].shared);
  assert.ok(!out.find((s) => s.tconst === 'x').shared);
});

test('a title one person would dislike is out, and so is anything either has seen', () => {
  const out = suggest([{ name: 'marc', rated: { b: 9 } }, { name: 'thomas', rated: { a: 9, bad: 1 } }], similarOf);
  assert.ok(!out.some((s) => s.tconst === 'z'));
  assert.ok(!out.some((s) => s.tconst === 'a'));
});

test('someone with no ratings does not empty the list', () => {
  const out = suggest([{ name: 'marc', rated: { a: 9 } }, { name: 'thomas', rated: {} }], similarOf);
  assert.deepEqual(out.map((s) => s.tconst).sort(), ['seen', 'x', 'y']);
});

test('nothing liked means no suggestions', () => {
  assert.deepEqual(suggest([{ name: 'marc', rated: {} }], similarOf), []);
});

test('the IMDb rating moves the final order', () => {
  assert.ok(finalScore({ score: 1 }, 8.5) > finalScore({ score: 1 }, 6.5));
});
