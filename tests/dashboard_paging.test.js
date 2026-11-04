// Coach `dashboard` op: every 90-day read is paged (Omar 2026-11-04). PostgREST returns at most 1,000 rows per request;
// one unpaged select silently dropped the newest meals/workouts once the fleet passed 1,000 rows, so active clients
// looked quiet. The REAL source (verifyCoachToken + pagedRows + dashboard) runs against a stand-in that enforces the cap.
//
// Usage (from the DASHBOARD repo root):   node tests/dashboard_paging.test.js
'use strict';
const ts = require('typescript');
const fs = require('fs');
const nodeCrypto = require('crypto');

const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const fnSrc = (sig) => { const i = SRC.indexOf(sig); if (i < 0) throw new Error('missing ' + sig); return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3); };
const code = [fnSrc('function verifyCoachToken'), fnSrc('async function pagedRows('), fnSrc('async function dashboard(body: any) {')].join('\n');
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const CAP = 1000;
const COACH = nodeCrypto.createHash('sha256').update('coach-pw-for-tests').digest('hex');
let DB, REQS;
function table(name) {
  const q = { f: [], order: [], from: 0, to: null };
  const b = {};
  b.select = () => b;
  b.gte = (c, v) => { q.f.push([c, v]); return b; };
  b.order = (c, o) => { q.order.push([c, o && o.ascending === false ? -1 : 1]); return b; };
  b.range = (f, t) => { q.from = f; q.to = t; return b; };
  for (const w of ['insert', 'update', 'upsert', 'delete']) b[w] = () => { throw new Error('dashboard attempted a ' + w + ' on ' + name); };
  b.then = (res) => {
    REQS.push(name);
    let rows = (DB[name] || []).filter((r) => q.f.every(([c, v]) => String(r[c]) >= String(v)));
    if (q.order.length) rows = rows.slice().sort((x, y) => { for (const [c, d] of q.order) { if (x[c] < y[c]) return -d; if (x[c] > y[c]) return d; } return 0; });
    const to = Math.min(q.to == null ? Infinity : q.to, q.from + CAP - 1);          // the server-side cap
    return res({ data: rows.slice(q.from, to + 1).map((r) => ({ ...r })), error: null });
  };
  return b;
}
const json = (o) => ({ __body: o });
const M = {};
new Function('admin', 'ok', 'err', 'json', 'COACH_PASSWORD_HASH', 'exports', js + '\nObject.assign(exports,{dashboard,pagedRows});')(
  { from: table }, (e = {}) => json({ ok: true, ...e }), (r, e = {}) => json({ ok: false, error: r, ...e }), json, COACH, M);

let pass = 0, fail = 0;
const test = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };

const DAY = 86400e3, now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
function seed() {
  DB = { clients: [{ id: 'c1', storage_key: 'adam', is_internal: false }, { id: 'c2', storage_key: 'zed', is_internal: false }],
    weight_logs: [], check_ins: [], meal_logs: [], workout_log_entries: [] };
  // 2,400 old workout sets + 1,600 old meals from zed fill the first pages; adam's newest logs come after the cap.
  for (let i = 0; i < 2400; i++) DB.workout_log_entries.push({ id: i + 1, client_key: 'zed', logged_at: iso(now - 60 * DAY + i * 1000), exercise_name: 'Squat', weight: 100, sets_done: 1, reps_done: 5 });
  for (let i = 0; i < 1600; i++) DB.meal_logs.push({ id: i + 1, client_id: 'c2', logged_at: iso(now - 60 * DAY + i * 1000), meal_name: 'm', kcal: 500 });
  for (let i = 0; i < 12; i++) DB.workout_log_entries.push({ id: 5000 + i, client_key: 'adam', logged_at: iso(now - DAY + i * 60e3), exercise_name: 'Bench ' + i, weight: 80, sets_done: 1, reps_done: 8 });
  DB.meal_logs.push({ id: 9000, client_id: 'c1', logged_at: iso(now - 2 * 3600e3), meal_name: 'Dinner', kcal: 700 });
  DB.workout_log_entries.push({ id: 1, client_key: 'zed', logged_at: iso(now - 200 * DAY), exercise_name: 'too old' });   // outside 90 days
  REQS = [];
}

(async () => {
  console.log('dashboard paging');
  await test('DP1 newest workout + meal beyond the 1,000-row cap are seen', async () => {
    seed();
    const d = (await M.dashboard({ coachToken: COACH })).__body.dashboard;
    eq(d.adam.latestWorkoutTs, iso(now - DAY + 11 * 60e3), 'adam latest workout');
    eq(d.adam.latestMealTs, iso(now - 2 * 3600e3), 'adam latest meal');
    eq(d.adam.recentWorkouts.map((w) => w.exerciseName), ['Bench 2', 'Bench 3', 'Bench 4', 'Bench 5', 'Bench 6', 'Bench 7', 'Bench 8', 'Bench 9', 'Bench 10', 'Bench 11'], 'last 10, oldest first');
    eq(d.zed.recentWorkouts.length, 10, 'zed capped list');
  });
  await test('DP2 every page requested until a short page (3 workout pages, 2 meal pages)', async () => {
    seed(); await M.dashboard({ coachToken: COACH });
    eq(REQS.filter((x) => x === 'workout_log_entries').length, 3, 'workout pages');
    eq(REQS.filter((x) => x === 'meal_logs').length, 2, 'meal pages');
  });
  await test('DP3 coach token required before any read', async () => {
    seed(); const r = (await M.dashboard({ coachToken: 'nope' })).__body;
    eq(r.error, 'unauthorized', 'refused'); eq(REQS.length, 0, 'no reads');
  });
  await test('DP4 pagedRows: exact multiple of the page size ends on an empty page; errors surface', async () => {
    let calls = 0;
    const r = await M.pagedRows(() => ({ range: (f, t) => { calls++; return Promise.resolve({ data: f < 2000 ? Array(t - f + 1).fill(0) : [], error: null }); } }));
    eq([r.data.length, calls], [2000, 3], 'two full pages + empty');
    const e = await M.pagedRows(() => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }));
    eq([e.data, e.error.message], [null, 'boom'], 'error');
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
