// Cross-language roundtrip: Python encrypts, browser code (run in Node) decrypts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKey, decryptDb } from '../src/dbcrypto.js';

const PY = process.env.PYTHON || 'python3';
const script = fileURLToPath(new URL('../../scripts/encrypt_db.py', import.meta.url));
const TEST_PASSPHRASE = 'unit-test-passphrase-not-secret';

test('decrypts what encrypt_db.py produced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'srdb-'));
  const plain = Buffer.from('SQLite format 3\0' + 'x'.repeat(5000));
  writeFileSync(join(dir, 'in.bin'), plain);
  execFileSync(PY, [script, join(dir, 'in.bin'), join(dir, 'out.enc')],
    { env: { ...process.env, DB_PASSPHRASE: TEST_PASSPHRASE } });
  const enc = readFileSync(join(dir, 'out.enc'));
  const out = await decryptDb(enc, await deriveKey(TEST_PASSPHRASE));
  assert.deepEqual(Buffer.from(out), plain);
  await assert.rejects(decryptDb(enc, await deriveKey('wrong-passphrase-123')));
});
