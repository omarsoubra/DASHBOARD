#!/usr/bin/env node
// Issues (or rotates) the access token for `_push_canary` ONLY, through the
// existing coach-authenticated `issueClientToken` endpoint, and puts the canary
// link on the clipboard. The token is never printed.
//
//   node scripts/push/issue_canary_link.mjs
//
// Cost: 1 `api` invocation. Prerequisite: supabase/manual/push_canary_seed.sql has run.
// With Universal Clipboard (same Apple ID) you can paste the link straight on your iPhone.
import { execFileSync } from 'node:child_process';
import { CANARY_KEY, CANARY_PAGE, coachToken, post } from './common.mjs';

const ct = await coachToken();
const { status, j } = await post('api', {
  type: 'issueClientToken', coachToken: ct, storageKey: CANARY_KEY, reason: 'push_canary_proof',
});
if (!j || j.ok !== true || typeof j.token !== 'string') {
  console.error(`issueClientToken failed (HTTP ${status}): ${j && j.error ? j.error : 'no response'}`);
  process.exit(1);
}
execFileSync('pbcopy', { input: `${CANARY_PAGE}?t=${j.token}` });
console.log('Canary link copied to the clipboard (not shown). Any older canary link is now invalid.');
