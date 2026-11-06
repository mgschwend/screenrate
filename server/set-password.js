// Set or change a password: node set-password.js <username> [users.json]
// The password is read from the terminal without echoing it; only the hash is stored.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hashPassword } from './auth.js';

const [name, file = '/data/users.json'] = process.argv.slice(2);
if (!name) { console.error('Usage: node set-password.js <username> [users.json]'); process.exit(1); }

async function readHidden() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text.replace(/\r?\n$/, '');
  }
  process.stdout.write('Password: ');
  process.stdin.setRawMode(true);
  let text = '';
  for await (const chunk of process.stdin) {
    for (const c of chunk.toString('utf8')) {
      if (c === '\u0003') process.exit(1);
      if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdout.write('\n'); return text; }
      text = c === '\u007f' ? text.slice(0, -1) : text + c;
    }
  }
  return text;
}

const password = await readHidden();
if (password.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
const users = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
users[name.toLowerCase()] = await hashPassword(password);
writeFileSync(`${file}.tmp`, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
renameSync(`${file}.tmp`, file);
console.log(`Password set for ${name.toLowerCase()}.`);
process.exit(0);
