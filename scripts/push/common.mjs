// Shared helpers for the push canary scripts. Omar runs these locally.
// Nothing here prints a password, token, coach hash or private key.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

export const CANARY_KEY = '_push_canary';
export const CANARY_PAGE = 'https://omarsoubra.github.io/DASHBOARD/clients/_push_canary/';

// Single source of truth for the backend origin: the canary shell's config.
export function functionsBase() {
  const html = readFileSync(path.join(REPO, 'clients', '_push_canary', 'index.html'), 'utf8');
  const m = html.match(/pushUrl: '(https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1)\/push'/);
  if (!m) throw new Error('could not read pushUrl from clients/_push_canary/index.html');
  return m[1];
}

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

/** Prompt without echoing what is typed. */
export function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

export function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

/** Coach token = sha256(password), exactly as api/authCoach derives it. */
export async function coachToken() {
  const pw = await promptHidden('Coach password (not shown): ');
  if (!pw) throw new Error('no password entered');
  return sha256hex(pw);
}

export async function post(fn, body) {
  const r = await fetch(`${functionsBase()}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* keep null */ }
  return { status: r.status, j };
}
