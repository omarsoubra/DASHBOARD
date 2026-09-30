#!/usr/bin/env node
// Provisions the INTERNAL `_workout_canary` client through the existing
// coach-authenticated api, then puts its link on the clipboard (never printed):
//   1. entitlementGrant locked_in_1to1 (skipped if an active grant exists)
//   2. issueClientToken (rotates any older canary link)
//
//   node scripts/workouts/issue_workout_canary.mjs
//
// Prerequisite: supabase/manual/workout_canary_seed.sql has run.
// Cost: 2–3 `api` invocations. Only ever acts on `_workout_canary`.
import { execFileSync } from 'node:child_process';
import { coachToken, post } from '../push/common.mjs';

const KEY = '_workout_canary';
const PAGE = 'https://omarsoubra.github.io/DASHBOARD/clients/_workout_canary/';
const ct = await coachToken();

const ent = await post('api', { type: 'entitlementsGet', coachToken: ct, storageKey: KEY });
const has1to1 = !!(ent.j && ent.j.ok && Array.isArray(ent.j.products) && ent.j.products.includes('locked_in_1to1'));
if (!has1to1) {
  const g = await post('api', { type: 'entitlementGrant', coachToken: ct, storageKey: KEY, productCode: 'locked_in_1to1',
    source: 'manual', notes: 'internal workout-completion canary (not a client)' });
  if (!g.j || g.j.ok !== true) { console.error(`entitlementGrant failed (HTTP ${g.status}): ${g.j && g.j.error ? g.j.error : 'no response'}`); process.exit(1); }
  console.log('locked_in_1to1 granted to _workout_canary.');
} else {
  console.log('_workout_canary already holds locked_in_1to1.');
}
const t = await post('api', { type: 'issueClientToken', coachToken: ct, storageKey: KEY, reason: 'workout_completion_canary' });
if (!t.j || t.j.ok !== true || typeof t.j.token !== 'string') {
  console.error(`issueClientToken failed (HTTP ${t.status}): ${t.j && t.j.error ? t.j.error : 'no response'}`);
  process.exit(1);
}
execFileSync('pbcopy', { input: `${PAGE}?t=${t.j.token}` });
console.log('Workout canary link copied to the clipboard (not shown). Any older canary link is now invalid.');
