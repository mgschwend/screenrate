#!/usr/bin/env python3
"""
Encrypt imdb.sqlite for public static hosting (IMDb data is licensed for
personal use only, so the published file must not be readable by others).

Format (mirrored in web/src/dbcrypto.js):
  bytes 0-3   magic  b"SRDB"
  byte  4     version (1)
  bytes 5-16  AES-GCM IV (random, 12 bytes)
  bytes 17-   AES-256-GCM( gzip(sqlite) ), 16-byte tag appended; AAD = bytes 0-4
Key = PBKDF2-HMAC-SHA256(passphrase, SALT, ITERATIONS, 32 bytes).
The salt is fixed so the app can derive the key once and reuse it across
weekly rebuilds; the IV is fresh per file.

Usage:  DB_PASSPHRASE=… python encrypt_db.py imdb.sqlite imdb.sqlite.enc
        DB_PASSPHRASE=… python encrypt_db.py --decrypt imdb.sqlite.enc out.sqlite
"""
import argparse, gzip, hashlib, os, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"SRDB"
VERSION = 1
SALT = b"screenrate/imdb-db/v1"
ITERATIONS = 600_000

def derive_key(passphrase: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), SALT, ITERATIONS, 32)

def encrypt(data: bytes, key: bytes) -> bytes:
    header = MAGIC + bytes([VERSION])
    iv = os.urandom(12)
    return header + iv + AESGCM(key).encrypt(iv, gzip.compress(data, 9, mtime=0), header)

def decrypt(blob: bytes, key: bytes) -> bytes:
    header, iv, ct = blob[:5], blob[5:17], blob[17:]
    if header[:4] != MAGIC or header[4] != VERSION:
        raise ValueError("not a ScreenRate encrypted DB (bad magic/version)")
    return gzip.decompress(AESGCM(key).decrypt(iv, ct, header))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--decrypt", action="store_true")
    args = ap.parse_args()
    passphrase = os.environ.get("DB_PASSPHRASE", "")
    if len(passphrase) < 12:
        sys.exit("DB_PASSPHRASE env var missing or shorter than 12 characters")
    key = derive_key(passphrase)
    with open(args.src, "rb") as f: data = f.read()
    out = decrypt(data, key) if args.decrypt else encrypt(data, key)
    if not args.decrypt:
        assert decrypt(out, key) == data, "roundtrip check failed"
    with open(args.dst, "wb") as f: f.write(out)
    print(f"{'decrypted' if args.decrypt else 'encrypted'} {args.src} ({len(data)/1e6:.1f} MB) "
          f"-> {args.dst} ({len(out)/1e6:.1f} MB)")

if __name__ == "__main__":
    main()
