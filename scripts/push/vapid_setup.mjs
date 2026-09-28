#!/usr/bin/env node
// Generates the LOCKED IN VAPID keypair ONCE, on Omar's Mac.
//
//   node scripts/push/vapid_setup.mjs
//
// * Writes ~/.lockedin/vapid_push.env (dir 0700, file 0600) — outside every repo.
//   This is the recovery copy. Move it into your password manager, then delete it.
// * Prints ONLY the public key.
// * Optionally puts the private key on the clipboard for pasting into
//   Supabase → Edge Functions → Secrets, then clears the clipboard.
// * Refuses to run if the file already exists: rotating VAPID keys silently
//   breaks every existing subscription.
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { prompt } from './common.mjs';

const DIR = path.join(os.homedir(), '.lockedin');
const FILE = path.join(DIR, 'vapid_push.env');
const SUBJECT = 'https://omarsoubra.github.io/DASHBOARD/';

if (existsSync(FILE)) {
  console.error(`Refusing: ${FILE} already exists. Rotating VAPID keys breaks every subscription.`);
  console.error('If you really intend to rotate, move that file aside yourself first.');
  process.exit(1);
}

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');

mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
writeFileSync(FILE,
  `VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${jwk.d}\nVAPID_SUBJECT=${SUBJECT}\nPUSH_ALLOWED_CLIENTS=_push_canary\n`,
  { mode: 0o600, flag: 'wx' });

console.log(`\nWrote ${FILE} (mode 600).`);
console.log(`\nSet these FOUR Supabase Edge Function secrets (Dashboard → Edge Functions → Secrets):`);
console.log(`  VAPID_PUBLIC_KEY      = ${pub}`);
console.log(`  VAPID_SUBJECT         = ${SUBJECT}`);
console.log(`  PUSH_ALLOWED_CLIENTS  = _push_canary`);
console.log(`  VAPID_PRIVATE_KEY     = (not shown — use the clipboard step below, or the file above)`);

const a = await prompt('\nCopy VAPID_PRIVATE_KEY to the clipboard now? [y/N] ');
if (/^y/i.test(a.trim())) {
  execFileSync('pbcopy', { input: jwk.d });
  await prompt('Copied. Paste it into the Supabase secret value, save, then press Enter to clear the clipboard… ');
  execFileSync('pbcopy', { input: '' });
  console.log('Clipboard cleared.');
}
console.log('\nDone. Keep the file until the canary passes, then store it in your password manager and delete it.');
