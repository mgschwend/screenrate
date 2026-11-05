import './style.css';

// Step 1 skeleton: only confirms the encrypted DB was deployed next to the app.
// Decryption + sql.js loading arrive in step 2 (see src/dbcrypto.js).
const DB_URL = new URL('imdb.sqlite.enc', document.baseURI);
const status = document.getElementById('status');

try {
  const res = await fetch(DB_URL, { method: 'HEAD', cache: 'no-store' });
  const mb = (Number(res.headers.get('content-length')) / 1e6).toFixed(1);
  status.textContent = res.ok ? `Encrypted database deployed (${mb} MB).` : `Database missing (HTTP ${res.status}).`;
} catch (err) {
  status.textContent = `Could not reach database: ${err.message}`;
}
