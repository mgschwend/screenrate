// normalize() must match scripts/build_imdb_db.py exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { normalize } from '../src/normalize.js';

const PY = process.env.PYTHON || 'python3';
const CASES = [
  'The Godfather', 'Amélie', 'Die Schöne & das Biest', 'WALL·E', 'Léon: The Professional',
  'Ça', 'Crème brûlée', '  Spaces  ', 'Mission: Impossible – Dead Reckoning', '1917',
  'Æon Flux', 'Straße', 'Ⅻ Monkeys', 'ﬁnal ﬁlm', 'Pokémon', 'Hänsel & Gretel', '',
];

test('JS normalize matches Python normalize', () => {
  const py = `
import json, re, sys, unicodedata
def normalize(title):
    if not isinstance(title, str): return ""
    t = unicodedata.normalize("NFKD", title)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.lower().replace("&", " and ")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return t.strip()
print(json.dumps([normalize(s) for s in json.load(sys.stdin)]))`;
  const expected = JSON.parse(execFileSync(PY, ['-c', py], { input: JSON.stringify(CASES) }));
  CASES.forEach((s, i) => assert.equal(normalize(s), expected[i], `mismatch for ${JSON.stringify(s)}`));
});
