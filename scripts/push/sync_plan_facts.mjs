#!/usr/bin/env node
// ============================================================================
// LOCKED IN Push — Daily Reminders V1: served-shell plan facts sync
// (runs in GitHub Actions: .github/workflows/push-plan-facts.yml)
//
// For every client shell in the pushed commit, it waits until GitHub Pages
// SERVES exactly the committed bytes (the notifier's verifyLive), reads the
// facts from those bytes (plan_facts.mjs: feed count, Finish Workout, hash) and
// sends them to the push function's planFactsSync op.
//
// Every shell is synced on every run, not only the changed ones, so a queued
// run that GitHub cancels can never leave stale facts behind; served-byte
// verification makes an older run unable to overwrite a newer deploy's facts
// (its bytes are no longer served → skipped).
//
// It never edits a shell, a prescription or a preference, and never sends a
// notification. A 4 → 3 feed change therefore reaches the scheduler as soon
// as the 3-feed shell is live: the stale Meal 4 is suppressed from then on.
// Inert until the PUSH_DEPLOY_SECRET repository secret exists.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyLive, PAGES_BASE } from './notify_program_update.mjs';
import { planFactsFromShell } from './plan_facts.mjs';

const KEY_RE = /^[a-z0-9_]{2,40}$/;

export async function main({ git, fetchServed, post, sleep, env, log = console.log, attempts, delayMs }) {
  const report = { synced: [], skipped: [] };
  if (!env.PUSH_DEPLOY_SECRET || !env.SUPABASE_PROJECT_REF) {
    log('plan-facts sync inert: PUSH_DEPLOY_SECRET / SUPABASE_PROJECT_REF not configured');
    return report;
  }
  if (env.DISPATCH && env.CONFIRM !== 'SYNC') { log('manual run refused: confirm input must be SYNC'); return report; }
  const sha = env.SHA;
  const keys = git.shellKeys(sha).filter((k) => KEY_RE.test(k)).sort();
  for (const key of keys) {                              // bounded: one entry per client folder
    const live = await verifyLive({ key, sha, git, fetchServed, sleep, attempts, delayMs });
    if (!live.ok) { report.skipped.push({ key, reason: 'not_live' }); log(`${key}: served shell never matched ${sha.slice(0, 7)} — facts NOT synced`); continue; }
    const facts = planFactsFromShell(git.show(sha, `clients/${key}/index.html`));
    if (facts.served_sha256 !== live.hash) { report.skipped.push({ key, reason: 'hash_mismatch' }); continue; }
    const r = await post(env, { type: 'planFactsSync', storageKey: key, facts, commit: sha });
    const j = r.j || {};
    if (!j.ok) { report.skipped.push({ key, reason: `error:${j.error || r.status}` }); log(`${key}: planFactsSync → ${j.error || r.status}`); continue; }
    report.synced.push({ key, meals: facts.meal_facts_status === 'consistent' ? facts.meal_slot_count : facts.meal_facts_status,
                         workoutCompletion: facts.has_workout_completion, changed: !!j.changed });
    log(`${key}: meals=${facts.meal_facts_status === 'consistent' ? facts.meal_slot_count : facts.meal_facts_status} finishWorkout=${facts.has_workout_completion}${j.changed ? ' (changed)' : ''}`);
  }
  return report;
}

// ── real dependencies (GitHub Actions runner) ───────────────────────────────
function realGit() {
  const g = (...args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return {
    shellKeys(sha) {
      const out = g('ls-tree', '--name-only', '-r', sha, '--', 'clients').toString('utf8');
      return out.split('\n').map((p) => (/^clients\/([^/]+)\/index\.html$/.exec(p.trim()) || [])[1]).filter(Boolean);
    },
    show(sha, p) { return g('show', `${sha}:${p}`); },
  };
}

async function realFetchServed(key, sha) {
  const r = await fetch(`${PAGES_BASE}/clients/${key}/index.html?v=${sha.slice(0, 12)}`, { cache: 'no-store', redirect: 'error' });
  if (!r.ok) throw new Error('http_' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function realPost(env, body) {
  const r = await fetch(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/functions/v1/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', 'x-push-deploy-secret': env.PUSH_DEPLOY_SECRET },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* keep null */ }
  return { status: r.status, j };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await main({
    git: realGit(), fetchServed: realFetchServed, post: realPost,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), env: process.env,
  });
  console.log(JSON.stringify({ synced: report.synced.length, skipped: report.skipped }));
}
