#!/usr/bin/env node
// One-time setup for the "program updated" notifier's credential.
//
//   node scripts/push/deploy_notifier_key_setup.mjs
//
// * Generates a random secret in memory.
// * Pipes it straight into `gh secret set PUSH_DEPLOY_SECRET` (stdin; never
//   printed, never written to disk, never on a command line).
// * Prints ONLY its sha256 and the SQL that stores that hash in
//   push_internal_auth('deploy') — the push function compares hashes.
// Re-running rotates it (old secret stops working once the new hash is stored).
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = 'omarsoubra/DASHBOARD';
const secret = randomBytes(32).toString('hex');
execFileSync('gh', ['secret', 'set', 'PUSH_DEPLOY_SECRET', '-R', REPO], { input: secret, stdio: ['pipe', 'ignore', 'inherit'] });
const hash = createHash('sha256').update(secret).digest('hex');
console.log(`PUSH_DEPLOY_SECRET set on ${REPO} (value not shown).`);
console.log('Now store its hash (safe to share) in Supabase:');
console.log(`insert into public.push_internal_auth (name, secret_sha256) values ('deploy', '${hash}')`);
console.log(`on conflict (name) do update set secret_sha256 = excluded.secret_sha256, rotated_at = now();`);
