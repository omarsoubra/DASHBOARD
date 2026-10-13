// CLIENT JOURNEY history read (Omar 2026-10-13) — the real coachClientHistory source against an in-memory DB.
//   coach-only · bad / unknown key refused · pages past 1000 rows (nothing cut) · ordered oldest first · read-only
const ts = require('typescript');
const fs = require('fs');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const i = SRC.indexOf('const HIST_PAGE'), j = SRC.indexOf('async function registryGetPrivate');
if (i < 0 || j < 0) throw new Error('locate coachClientHistory');
const js = ts.transpileModule(SRC.slice(i, j), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const T = { clients: [{ id: 'c1', storage_key: 'bishoy_shaker' }], weight_logs: [], workout_log_entries: [], check_ins: [] };
const writes = [];
for (let n = 0; n < 2345; n++) T.workout_log_entries.push({ client_key: 'bishoy_shaker', logged_at: new Date(Date.UTC(2026, 6, 1) + (2345 - n) * 60000).toISOString(), exercise_name: 'Bench', weight: '80', sets_done: '3', reps_done: '8', phase_key: 'phase1' });
T.workout_log_entries.push({ client_key: 'someone_else', logged_at: '2026-07-02T00:00:00Z', exercise_name: 'X' });
T.weight_logs.push({ client_key: 'bishoy_shaker', logged_at: '2026-07-01T00:00:00Z', weight_kg: 80 }, { client_key: 'bishoy_shaker', logged_at: '2026-09-01T00:00:00Z', weight_kg: 77 });
function from(t) {
  const q = { f: [], r: null, o: null, single: false };
  const b = {
    select: () => b, eq: (c, v) => { q.f.push([c, v]); return b; }, order: (c, o) => { q.o = [c, o.ascending]; return b; },
    range: (a, z) => { q.r = [a, z]; return b; }, maybeSingle: () => { q.single = true; return b; },
    insert: () => { writes.push(t); return b; }, update: () => { writes.push(t); return b; }, upsert: () => { writes.push(t); return b; }, delete: () => { writes.push(t); return b; },
    then: (res) => {
      let rows = T[t].filter((r) => q.f.every(([c, v]) => r[c] === v));
      if (q.o) rows = rows.slice().sort((a, z) => (a[q.o[0]] < z[q.o[0]] ? -1 : 1) * (q.o[1] ? 1 : -1));
      if (q.single) return res({ data: rows[0] ?? null, error: null });
      if (q.r) { if (q.r[1] - q.r[0] + 1 > 1000) throw new Error('page larger than the server cap'); rows = rows.slice(q.r[0], q.r[1] + 1); }
      else rows = rows.slice(0, 1000);                                  // PostgREST default cap
      return res({ data: rows, error: null });
    },
  };
  return b;
}
const admin = { from };
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const M = {};
new Function('admin', 'ok', 'err', 'verifyCoachToken', 'logEfError', 'CI_KEY_RE', 'exports', js + '\nexports.h = coachClientHistory;')(
  admin, ok, err, (t) => t === 'coach', () => {}, /^[a-z0-9_]{1,64}$/, M);

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + JSON.stringify(d).slice(0, 300) : '')); } };
(async () => {
  console.log('coachClientHistory');
  t('client token -> unauthorized', (await M.h({ coachToken: 'x', storageKey: 'bishoy_shaker' })).__body.error === 'unauthorized');
  t('bad key refused', (await M.h({ coachToken: 'coach', storageKey: "a'; drop" })).__body.error === 'bad_storageKey');
  t('unknown client', (await M.h({ coachToken: 'coach', storageKey: 'nobody' })).__body.error === 'unknown_client');
  const r = (await M.h({ coachToken: 'coach', storageKey: 'Bishoy_Shaker' })).__body;
  t('all 2345 workout rows returned (paged, nothing cut at 1000)', r.ok && r.workouts.length === 2345, r.workouts && r.workouts.length);
  t('only this client', r.workouts.every((w) => w.exercise_name === 'Bench'));
  t('oldest first', r.workouts[0].logged_at < r.workouts[2344].logged_at && r.weights[0].weight_kg === 80);
  t('read-only', writes.length === 0, writes);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
