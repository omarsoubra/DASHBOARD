#!/usr/bin/env node
// ============================================================================
// LOCKED IN — "Program updated" notifier (runs in GitHub Actions after a push)
//
// It OBSERVES an approved programme deploy; it never causes or takes part in it.
//
// A client is notified only when ALL hold:
//   1. a commit in the pushed range carries the explicit trailer
//        LOCKED-IN-Program-Update: <storage_key>
//      (fleet-wide shell patches, template fixes, registry commits carry no
//      trailer → silence);
//   2. that commit range actually changed clients/<key>/index.html;
//   3. the bytes GitHub Pages SERVES for that shell equal the committed bytes
//      (bounded polling; never equal → never notified);
//   4. the `push` function accepts it (pilot allow-list, the client's opt-in and
//      program-update setting, active device, quiet hours → deferred).
//
// Dedupe is server-side: program_update:<client_id>:<sha256(served shell)>.
// Inert until the PUSH_DEPLOY_SECRET repository secret exists.
// ============================================================================
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const TRAILER = 'LOCKED-IN-Program-Update';
export const PAGES_BASE = 'https://omarsoubra.github.io/DASHBOARD';
const KEY_RE = /^[a-z0-9_]{2,40}$/;
const ZERO_SHA = /^0{40}$/;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Keys named by trailers in the range AND whose shell changed in the range. */
export function findCandidates({ git, before, sha, dispatchKey }) {
  if (dispatchKey) {
    const k = String(dispatchKey).trim().toLowerCase();
    return KEY_RE.test(k) && git.fileExists(sha, `clients/${k}/index.html`) ? [k] : [];
  }
  const named = new Set();
  for (const c of git.commitTrailers(before, sha)) {
    for (const v of c.values) {
      for (const k of String(v).split(',').map((s) => s.trim().toLowerCase())) if (KEY_RE.test(k)) named.add(k);
    }
  }
  const changed = new Set(git.changedShellKeys(before, sha));
  return [...named].filter((k) => changed.has(k)).sort();
}

/** Served bytes must equal committed bytes. Bounded: attempts × delayMs. */
export async function verifyLive({ key, sha, git, fetchServed, sleep, attempts = 30, delayMs = 20_000 }) {
  const expected = sha256(git.show(sha, `clients/${key}/index.html`));
  for (let i = 0; i < attempts; i++) {
    let got = null;
    try { got = sha256(await fetchServed(key, sha)); } catch { got = null; }
    if (got === expected) return { ok: true, hash: expected, attempts: i + 1 };
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { ok: false, hash: expected, attempts };
}

export async function main({ git, fetchServed, post, sleep, env, log = console.log, attempts, delayMs }) {
  const report = { candidates: [], notified: [], skipped: [] };
  if (!env.PUSH_DEPLOY_SECRET || !env.SUPABASE_PROJECT_REF) {
    log('notifier inert: PUSH_DEPLOY_SECRET / SUPABASE_PROJECT_REF not configured');
    return report;
  }
  if (env.DISPATCH_KEY && env.CONFIRM !== 'NOTIFY') { log('manual run refused: confirm input must be NOTIFY'); return report; }
  const sha = env.SHA;
  const before = env.BEFORE && !ZERO_SHA.test(env.BEFORE) ? env.BEFORE : `${sha}~1`;
  const candidates = findCandidates({ git, before, sha, dispatchKey: env.DISPATCH_KEY || null });
  report.candidates = candidates;
  if (!candidates.length) { log(`no ${TRAILER} trailer for a changed shell in ${before.slice(0, 7)}..${sha.slice(0, 7)} — nothing to notify`); return report; }

  for (const key of candidates) {                      // bounded: candidates come from explicit trailers
    const live = await verifyLive({ key, sha, git, fetchServed, sleep, attempts, delayMs });
    if (!live.ok) { report.skipped.push({ key, reason: 'not_live' }); log(`${key}: served shell never matched ${sha.slice(0, 7)} — NOT notifying`); continue; }
    const r = await post(env, { type: 'programUpdated', storageKey: key, deployHash: live.hash, commit: sha });
    const j = r.j || {};
    const outcome = j.ok ? (j.duplicate ? 'duplicate' : j.status) : `error:${j.error || r.status}`;
    report.notified.push({ key, outcome });
    log(`${key}: live after ${live.attempts} check(s); push → ${outcome}`);
  }
  return report;
}

// ── real dependencies (GitHub Actions runner) ───────────────────────────────
function realGit() {
  const g = (...args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return {
    commitTrailers(before, sha) {
      const out = g('log', '--format=%H%x00%(trailers:key=' + TRAILER + ',valueonly,separator=%x2C)%x1e', `${before}..${sha}`).toString('utf8');
      return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [h, v = ''] = s.split('\x00');
        return { sha: h, values: v.split(',').map((x) => x.trim()).filter(Boolean) };
      });
    },
    changedShellKeys(before, sha) {
      const out = g('diff', '--name-only', before, sha, '--', 'clients/*/index.html').toString('utf8');
      return out.split('\n').map((p) => (/^clients\/([^/]+)\/index\.html$/.exec(p.trim()) || [])[1]).filter(Boolean);
    },
    fileExists(sha, p) { try { g('cat-file', '-e', `${sha}:${p}`); return true; } catch { return false; } },
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
  console.log(JSON.stringify(report));
}
