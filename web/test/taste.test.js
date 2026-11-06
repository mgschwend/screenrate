import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaste } from '../src/taste.js';

const film = (rating, genres, people = [], year = 2000) => ({ rating, genres, people, year });
const d = (name) => ({ role: 'd', name }), a = (name) => ({ role: 'a', name });

test('nothing shows until enough is rated', () => {
  assert.deepEqual(buildTaste([film(9, ['Drama'])]).genres, []);
});

test('favourites rate above your average, and need more than one title', () => {
  const t = buildTaste([
    film(10, ['Crime'], [d('Nolan'), a('Bale')], 2008), film(9, ['Crime'], [d('Nolan'), a('Bale')], 2005),
    film(4, ['Comedy'], [d('Other')], 1995), film(3, ['Comedy'], [d('Other')], 1994),
    film(9, ['Drama'], [d('Once')], 1972),
  ]);
  assert.deepEqual(t.genres, ['Crime']);
  assert.deepEqual(t.directors, ['Nolan']);
  assert.deepEqual(t.actors, ['Bale']);
  assert.deepEqual(t.decades, ['2000s']);
});

test('more titles beat a slightly higher average', () => {
  const rows = [...Array(9)].map(() => film(9, ['Drama'])).concat(film(10, ['War']), film(10, ['War']), film(3, ['Comedy']), film(3, ['Comedy']));
  assert.equal(buildTaste(rows).genres[0], 'Drama');
});
