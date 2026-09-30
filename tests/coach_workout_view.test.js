// LOCKED IN Coach Workout Completion View V1 — api op coachWorkoutCompletions.
//
// 0 production invocations. The REAL api source (verifyCoachToken + the
// COACH-WORKOUT-VIEW-V1 block) runs against a stand-in that answers ONLY
// SELECTs on `clients` and `workout_completions`: any write, and any other
// table (exercise logs, push/notification tables, programmes), fails the test.
//
// Usage (from the DASHBOARD repo root):   node tests/coach_workout_view.test.js
'use strict';
const ts = require('typescript');
const fs = require('fs');
const { execSync } = require('child_process');
const nodeCrypto = require('crypto');

const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const START = '// ══════════════════════════════════════════════════════════════════════════\n// COACH-WORKOUT-VIEW-V1';
const END = '// ═══════════════════════════════════════ END COACH-WORKOUT-VIEW-V1';
const block = SRC.slice(SRC.indexOf(START), SRC.indexOf(END));
const vct = SRC.slice(SRC.search(/function verifyCoachToken/), SRC.indexOf('\n}\n', SRC.search(/function verifyCoachToken/)) + 3);
const js = ts.transpileModule(vct + '\n' + block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const COACH = nodeCrypto.createHash('sha256').update('coach-pw-for-tests').digest('hex');
let DB, CALLS;
const ALLOWED = new Set(['clients', 'workout_completions', 'push_preferences']);
function table(name) {
  if (!ALLOWED.has(name)) throw new Error('coach view touched forbidden table ' + name);
  const q = { f: [], order: null, lim: null };
  const b = {};
  b.select = (cols) => { if (name === 'push_preferences' && cols !== 'client_id, timezone') throw new Error('push_preferences read beyond client_id, timezone: ' + cols); return b; };
  b.gte = (c, v) => { q.f.push([c, v]); return b; };
  b.order = (c, o) => { q.order = [c, o && o.ascending === false ? -1 : 1]; return b; };
  b.limit = (n) => { q.lim = n; return b; };
  for (const w of ['insert', 'update', 'upsert', 'delete']) b[w] = () => { throw new Error('coach view attempted a ' + w + ' on ' + name); };
  b.then = (res) => {
    CALLS.push(name);
    if (DB.fail === name) return res({ data: null, error: { message: 'outage' } });
    let rows = DB[name].filter((r) => q.f.every(([c, v]) => Date.parse(r[c]) >= Date.parse(v)));
    if (q.order) rows = rows.slice().sort((x, y) => (Date.parse(x[q.order[0]]) - Date.parse(y[q.order[0]])) * q.order[1]);
    if (q.lim != null) rows = rows.slice(0, q.lim);
    return res({ data: rows.map((r) => ({ ...r })), error: null });
  };
  return b;
}
const json = (o) => ({ __body: o });
const M = {};
new Function('admin', 'ok', 'err', 'json', 'logEfError', 'COACH_PASSWORD_HASH', 'exports',
  js + '\nObject.assign(exports,{coachWorkoutCompletions,cwvSummarize,cwvWeekStart,cwvLogged});'
)({ from: table }, (e = {}) => json({ ok: true, ...e }), (r, e = {}) => json({ ok: false, error: r, ...e }), json, () => {}, COACH, M);

// ── fixtures ───────────────────────────────────────────────────────────────
const H = 3600e3, D = 24 * H;
function row(client, o = {}) {
  const at = o.at ?? Date.now() - H;
  return { client_id: client, completion_ref: 'cmp_' + nodeCrypto.randomUUID(), phase_key: '1', day_index: 0, day_label: 'Day 1 — Upper A',
    session_kind: 'mandatory', exercises_prescribed: 5, exercises_logged: 5, sets_logged: 15, completed_at: new Date(at).toISOString(),
    recorded_at: new Date(at).toISOString(), local_date: o.local_date ?? new Date(at).toISOString().slice(0, 10), timezone: 'Australia/Sydney',
    status: 'completed', revoked_at: null, revoked_by: null, ...o, at: undefined };
}
function seed() {
  DB = { clients: [
    { id: 'A', storage_key: 'client_a', display_name: 'Client A', is_internal: false },
    { id: 'B', storage_key: 'client_b', display_name: 'Client B', is_internal: false },
    { id: 'Z', storage_key: 'client_zero', display_name: 'Zero', is_internal: false },
    { id: 'I', storage_key: '_workout_canary', display_name: 'Canary', is_internal: true },
  ], workout_completions: [], push_preferences: [] };
  CALLS = [];
}
const call = (b) => M.coachWorkoutCompletions(b).then((r) => r.__body);

const tests = [];
const test = (n, f) => tests.push([n, f]);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`ASSERT: ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

test('CV1 coach reads a per-client summary: name, latest, weeks, totals, history', async () => {
  seed(); DB.workout_completions.push(row('A'));
  const r = await call({ coachToken: COACH });
  eq(r.ok, true, 'ok'); const a = r.clients.client_a;
  eq(a.displayName, 'Client A', 'name'); assert(a.latest && a.latest.dayLabel === 'Day 1 — Upper A' && a.latest.phase === '1', 'latest event');
  eq(a.totals.completed, 1, 'total'); eq(a.history.length, 1, 'history');
  assert(!('client_id' in a.latest) && !('id' in a.latest), 'no internal ids exposed');
});

test('CV2 unauthenticated (no token / wrong token) → unauthorized, zero database reads', async () => {
  seed();
  for (const b of [{}, { coachToken: '' }, { coachToken: 'nope' }, { coachToken: COACH.slice(0, 63) }]) eq((await call(b)).error, 'unauthorized', JSON.stringify(b));
  eq(CALLS.length, 0, 'no reads before auth');
});

test('CV3 a client token cannot use the coach endpoint (in either field)', async () => {
  seed(); const clientTok = 'tok_' + nodeCrypto.randomBytes(24).toString('hex');
  eq((await call({ token: clientTok, storageKey: 'client_a' })).error, 'unauthorized', 'client token field');
  eq((await call({ coachToken: clientTok, storageKey: 'client_a' })).error, 'unauthorized', 'client token as coachToken');
  eq(CALLS.length, 0, 'no reads');
});

test('CV4 A/B isolation: each client sees only its own rows; storageKey filter; internal excluded by default', async () => {
  seed();
  DB.workout_completions.push(row('A', { day_label: 'A-only' }), row('B', { day_label: 'B-only' }), row('I', { day_label: 'canary' }));
  const r = await call({ coachToken: COACH });
  assert(r.clients.client_a.history.every((e) => e.dayLabel === 'A-only'), 'A has only A');
  assert(r.clients.client_b.history.every((e) => e.dayLabel === 'B-only'), 'B has only B');
  assert(!('_workout_canary' in r.clients), 'internal hidden');
  const one = await call({ coachToken: COACH, storageKey: 'CLIENT_B' });
  eq(Object.keys(one.clients).join(','), 'client_b', 'filter to one client (case-insensitive)');
  eq((await call({ coachToken: COACH, includeInternal: true })).clients._workout_canary.history[0].dayLabel, 'canary', 'internal only when asked');
});

test('CV5 revoked completions are distinguished: excluded from latest and counts, kept and marked in history', async () => {
  seed();
  DB.workout_completions.push(row('A', { at: Date.now() - 3 * H, day_label: 'older active' }),
    row('A', { at: Date.now() - H, day_label: 'newer revoked', status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: 'client' }));
  const a = (await call({ coachToken: COACH })).clients.client_a;
  eq(a.latest.dayLabel, 'older active', 'latest = latest ACTIVE'); eq(a.totals.completed, 1, 'active count'); eq(a.totals.revoked, 1, 'revoked count');
  eq(a.history[0].status, 'revoked', 'revoked shown, marked'); eq(a.history[0].revokedBy, 'client', 'who revoked');
});

test('CV6 zero-completion client: no latest, zero counts, empty history — nothing more', async () => {
  seed(); DB.workout_completions.push(row('A'));
  const z = (await call({ coachToken: COACH })).clients.client_zero;
  eq(z.latest, null, 'latest null'); eq(z.thisWeek.completed, 0, 'this week 0'); eq(z.previousWeek.completed, 0, 'prev 0');
  eq(z.history.length, 0, 'no history'); eq(z.totals.completed + z.totals.revoked, 0, 'totals 0');
  const keys = JSON.stringify(z).toLowerCase();
  for (const w of ['missed', 'behind', 'compliant', 'inactive', 'adherence', 'remaining', 'percent']) assert(!keys.includes(w), 'no judgement field: ' + w);
});

test('CV7 multiple completions on the same local day are all counted and listed', async () => {
  seed(); const d = new Date(Date.now() - H).toISOString().slice(0, 10);
  DB.workout_completions.push(row('A', { at: Date.now() - 2 * H, local_date: d, day_index: 0 }), row('A', { at: Date.now() - H, local_date: d, day_index: 1, day_label: 'Day 2' }));
  const a = (await call({ coachToken: COACH })).clients.client_a;
  eq(a.history.length, 2, 'both listed'); eq(a.totals.completed, 2, 'both counted'); eq(a.latest.dayLabel, 'Day 2', 'latest by time');
});

test('CV8 the same programme day repeated later: two separate events, newest first', async () => {
  seed();
  DB.workout_completions.push(row('A', { at: Date.now() - 8 * D }), row('A', { at: Date.now() - H }));
  const a = (await call({ coachToken: COACH })).clients.client_a;
  eq(a.history.length, 2, 'two events'); assert(Date.parse(a.history[0].completedAt) > Date.parse(a.history[1].completedAt), 'newest first');
  assert(a.history.every((e) => e.phase === '1' && e.dayIdx === 0), 'same session identity, separate events');
});

test('CV9 calendar weeks are Monday–Sunday in the client timezone, across the midnight boundary', async () => {
  // Sunday 2026-10-11 23:30 Sydney (AEDT, UTC+11) = 12:30Z. Monday 00:30 Sydney = 13:30Z.
  const sun = Date.UTC(2026, 9, 11, 12, 30), mon = Date.UTC(2026, 9, 11, 13, 30);
  const rows = [row('A', { local_date: '2026-10-11', completed_at: new Date(sun - H).toISOString() }), row('A', { local_date: '2026-10-05', completed_at: new Date(sun - 6 * D).toISOString() })];
  let s = M.cwvSummarize(rows, sun);
  eq(s.thisWeek.from, '2026-10-05', 'week starts Monday'); eq(s.thisWeek.to, '2026-10-11', 'ends Sunday');
  eq(s.thisWeek.completed, 2, 'Sunday night Sydney: both in this week');
  s = M.cwvSummarize(rows, mon);
  eq(s.thisWeek.from, '2026-10-12', 'Monday 00:30 Sydney → new week'); eq(s.thisWeek.completed, 0, 'new week empty');
  eq(s.previousWeek.completed, 2, 'last week holds both');
  const utc = rows.map((r) => ({ ...r, timezone: 'UTC' }));
  eq(M.cwvSummarize(utc, mon).thisWeek.from, '2026-10-05', 'UTC client at the same instant is still on Sunday');
});

test('CV10 week grouping uses each completion\'s own local_date (not UTC date); DST day correct', async () => {
  const now = Date.UTC(2026, 9, 6, 2, 0);                                     // Tue 06 Oct 13:00 AEDT
  const rows = [row('A', { local_date: '2026-10-05', completed_at: '2026-10-04T13:30:00.000Z' }),   // Mon 00:30 local, Sunday in UTC
                row('A', { local_date: '2026-10-04', completed_at: '2026-10-04T01:00:00.000Z' })];  // DST Sunday
  const s = M.cwvSummarize(rows, now);
  eq(s.thisWeek.completed, 1, 'Monday-local completion is this week'); eq(s.previousWeek.completed, 1, 'DST Sunday is last week');
});

test('CV11 logged metadata: none / partial / all / unknown', async () => {
  eq(M.cwvLogged({ exercises_prescribed: 5, exercises_logged: 0 }), 'none', 'none');
  eq(M.cwvLogged({ exercises_prescribed: 5, exercises_logged: 3 }), 'partial', 'partial');
  eq(M.cwvLogged({ exercises_prescribed: 5, exercises_logged: 5 }), 'all', 'all');
  eq(M.cwvLogged({ exercises_prescribed: null, exercises_logged: 2 }), 'unknown', 'no prescribed count');
  eq(M.cwvLogged({ exercises_prescribed: 5, exercises_logged: null }), 'unknown', 'no logged count');
});

test('CV12 read-only: only clients + workout_completions (+ push_preferences client_id,timezone) are read; no write, no notification table', async () => {
  seed(); DB.workout_completions.push(row('A'));
  await call({ coachToken: COACH }); await call({ coachToken: COACH, storageKey: 'client_a' });
  assert(CALLS.every((t) => ALLOWED.has(t)), 'tables: ' + CALLS.join(','));
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const w of ['.insert(', '.update(', '.upsert(', '.delete(', 'notification_events', 'push_devices', 'push_internal_auth', 'workout_log_entries', 'programs', 'rpc(']) assert(!code.includes(w), 'block has no ' + w);
  assert((code.match(/push_preferences/g) || []).length === 1, 'push_preferences referenced once (the timezone read)');
});

test('CV13 database outage → db_error, nothing fabricated', async () => {
  seed(); DB.fail = 'workout_completions';
  eq((await call({ coachToken: COACH })).error, 'db_error', 'fail closed');
});

test('CV14 existing coach `dashboard` op byte-identical; new op dispatched; coach-only', async () => {
  const fnOf = (src) => { const i = src.indexOf('async function dashboard(body: any) {'); return src.slice(i, src.indexOf('\n}\n', i)); };
  let head = null;
  try { head = execSync('git show 70c0541:supabase/functions/api/index.ts', { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { /* shallow CI clone */ }
  if (head) eq(fnOf(SRC), fnOf(head), 'dashboard() unchanged');
  assert(/case 'coachWorkoutCompletions': return coachWorkoutCompletions\(body\);/.test(SRC), 'dispatched');
  const fn = SRC.slice(SRC.indexOf('async function coachWorkoutCompletions('));
  assert(fn.indexOf('verifyCoachToken(') < fn.indexOf('admin.from('), 'coach auth before any read');
  assert(!/verifyClientToken/.test(block), 'no client-token path into the coach view');
});

test('CV15 timezone precedence: stored client timezone > latest completion > Australia/Sydney', async () => {
  const mon = Date.UTC(2026, 9, 11, 13, 30);                                    // Mon 00:30 Sydney, Sun 13:30 UTC
  const rows = [row('A', { local_date: '2026-10-11', completed_at: '2026-10-11T01:00:00.000Z', timezone: 'Australia/Sydney' })];
  let s = M.cwvSummarize(rows, mon, 'UTC');
  eq(s.timezone, 'UTC', 'stored wins over completion'); eq(s.timezoneSource, 'client_setting', 'source'); eq(s.thisWeek.from, '2026-10-05', 'UTC: still Sunday');
  s = M.cwvSummarize(rows, mon, null);
  eq(s.timezone, 'Australia/Sydney', 'completion when no stored'); eq(s.timezoneSource, 'latest_completion', 'source'); eq(s.thisWeek.from, '2026-10-12', 'Sydney: Monday');
  s = M.cwvSummarize([], mon, 'America/Los_Angeles');
  eq(s.timezone, 'America/Los_Angeles', 'zero completions use the stored timezone'); eq(s.timezoneSource, 'client_setting', 'source');
  s = M.cwvSummarize([], mon, null);
  eq(s.timezone, 'Australia/Sydney', 'final fallback'); eq(s.timezoneSource, 'default', 'source');
  eq(M.cwvSummarize([], mon, 'Mars/Base').timezoneSource, 'default', 'invalid stored timezone ignored');
  seed(); DB.push_preferences.push({ client_id: 'Z', timezone: 'Europe/London' }, { client_id: 'A', timezone: 'Not/AZone' });
  DB.workout_completions.push(row('A', { timezone: 'Australia/Perth' }));
  const r = await call({ coachToken: COACH });
  eq(r.clients.client_zero.timezone, 'Europe/London', 'op: zero-completion client uses stored timezone');
  eq(r.clients.client_a.timezone, 'Australia/Perth', 'op: invalid stored → latest completion');
  eq(r.clients.client_b.timezone, 'Australia/Sydney', 'op: nothing stored, no completions → fallback');
  DB.fail = 'push_preferences'; eq((await call({ coachToken: COACH })).ok, true, 'timezone read failure falls through, view still served');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) { try { await f(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + (e && e.message)); } }
  console.log(`\ncoach_workout_view: ${pass} passed, ${fail} failed, ${tests.length} total`);
  process.exit(fail ? 1 : 0);
})();
