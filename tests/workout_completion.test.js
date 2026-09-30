// LOCKED IN Workout Completion V1 — api operations (workoutComplete,
// workoutCompleteUndo, workoutCompletionsGet).
//
// 0 production invocations. The REAL api source is used for everything under
// test: verifyClientToken + sha256 (token hashing), the entitlement/capability
// machinery (requireCapability → log_workout), capabilityDenied, and the three
// WORKOUT-COMPLETION-V1 handlers. They run against a STRICT in-memory stand-in
// whose workout_completions columns and checks come from the migration file:
// an unknown column, a check violation or a duplicate (client_id, completion_ref)
// is an error, exactly as Postgres would answer.
//
// Usage (from the DASHBOARD repo root):   node tests/workout_completion.test.js
'use strict';
const S = require('./workout_completion_sandbox');
const { SRC, MIG, WC_COLUMNS, M, B, TOK, sha, seed, ref, todayLocal, complete, undo, list, rows, LOGS } = S;
const DBX = new Proxy({}, { get: (_, k) => S.db()[k], set: (_, k, v) => { S.db()[k] = v; return true; } });

// ── runner ─────────────────────────────────────────────────────────────────
const tests = [];
const test = (n, f) => tests.push([n, f]);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`ASSERT: ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

// ════════════════════════════════════════════════════════════════════════════
test('C1 first completion: one row, server identity, echoed public shape', async () => {
  seed();
  const r = await complete('client_a', TOK.a);
  eq(r.ok, true, 'ok'); eq(r.duplicate, false, 'not duplicate'); eq(rows().length, 1, 'one row');
  const row = rows()[0];
  eq(row.client_id, 'c_a', 'client_id from the verified token'); eq(row.storage_key, 'client_a', 'canonical key');
  eq(row.status, 'completed', 'status'); eq(row.phase_key, '1', 'phase'); eq(row.day_index, 0, 'day'); eq(row.session_kind, 'mandatory', 'kind');
  eq(r.completion.ref, ref(1), 'ref echoed'); eq(r.completion.status, 'completed', 'status echoed');
  assert(!('client_id' in r.completion) && !('id' in r.completion), 'no internal ids in the response');
  assert(Math.abs(Date.parse(row.recorded_at) - Date.now()) < 5000, 'recorded_at is server time');
});

test('C2 double tap / retry / refresh (same ref) → one row, duplicate:true, identical completion', async () => {
  seed();
  const a = await complete('client_a', TOK.a);
  const b = await complete('client_a', TOK.a);
  const c = await complete('client_a', TOK.a, { setsLogged: 99, dayLabel: 'changed' });   // a retry can never rewrite the row
  eq(rows().length, 1, 'one row'); eq(b.duplicate, true, 'retry is duplicate'); eq(c.duplicate, true, 'altered retry is duplicate');
  eq(JSON.stringify(c.completion), JSON.stringify(a.completion), 'the original row is returned unchanged');
});

test('C3 race: insert hits the unique constraint → resolves to the existing row', async () => {
  seed();
  const p1 = complete('client_a', TOK.a), p2 = complete('client_a', TOK.a);
  const [r1, r2] = await Promise.all([p1, p2]);
  eq(rows().length, 1, 'one row'); assert(r1.ok && r2.ok, 'both ok'); assert(r1.duplicate !== r2.duplicate, 'exactly one is the duplicate');
});

test('C4 same session later (new occurrence, new ref) → a second completion', async () => {
  seed();
  await complete('client_a', TOK.a, { ref: ref(1) });
  const r = await complete('client_a', TOK.a, { ref: ref(2) });
  eq(r.duplicate, false, 'new occurrence'); eq(rows().length, 2, 'two rows for the same (phase, day)');
});

test('C5 phase transition: phase 2 day 0 is a distinct session; both recorded as stated', async () => {
  seed();
  await complete('client_a', TOK.a, { ref: ref(1), phase: '1' });
  await complete('client_a', TOK.a, { ref: ref(2), phase: '2' });
  eq(rows().map((r) => r.phase_key).sort().join(','), '1,2', 'both phases');
});

test('C6 wrong token / missing token / revoked / suspended → rejected, nothing written', async () => {
  seed();
  for (const [key, tok, want] of [['client_a', 'nope', 'bad_token'], ['client_a', '', 'missing_credentials'], ['ghost', TOK.a, 'unknown_client']]) {
    const r = await complete(key, tok); eq(r.ok, false, key + ' refused'); eq(r.error, want, 'reason');
  }
  for (const st of ['revoked', 'suspended']) {
    seed(); DBX.client_sessions.find((s) => s.storage_key === 'client_a').access_status = st;
    const r = await complete('client_a', TOK.a); eq(r.error, 'access_' + st, st);
  }
  eq(rows().length, 0, 'nothing written');
});

test('C7 cross-client: B\'s token cannot write, undo or read A\'s completions; body client_id ignored', async () => {
  seed();
  await complete('client_a', TOK.a);
  const x = await complete('client_a', TOK.b); eq(x.error, 'bad_token', 'B token on A key refused');
  const y = await complete('client_b', TOK.b, {}, { client_id: 'c_a', clientId: 'c_a' });
  eq(y.ok, true, 'B writes its own'); eq(rows('c_b').length, 1, 'row belongs to B'); eq(rows('c_a').length, 1, 'A untouched');
  const u = await undo('client_b', TOK.b, ref(1));
  eq(u.ok, true, 'B undoes ITS OWN ref(1) (same string, different client)'); eq(rows('c_a')[0].status, 'completed', 'A\'s row with the same ref is untouched');
  const l = await list('client_b', TOK.b); eq(l.completions.length, 1, 'B sees one'); eq(l.completions[0].status, 'revoked', 'its own revoked row');
  const u2 = await undo('client_b', TOK.b, ref(7)); eq(u2.error, 'not_found', 'unknown ref → not_found');
});

test('C8 capability: self-guided-only, provisioning-incomplete → denied; legacy marker → allowed', async () => {
  seed();
  eq((await complete('client_np', TOK.np)).error, 'provisioning_incomplete', 'no entitlement');
  const sg = await complete('client_sg', TOK.sg);
  const sgCap = (await M.requireCapability('client_sg', 'log_workout')).ok;
  eq(sg.ok, sgCap, 'self-guided follows the log_workout matrix exactly (same gate as the workout write)');
  seed(); DBX.client_entitlements = DBX.client_entitlements.filter((e) => e.client_id !== 'c_a'); DBX.clients.find((c) => c.id === 'c_a').entitlement_legacy = true;
  eq((await complete('client_a', TOK.a)).ok, true, 'pre-cutover legacy 1:1 client allowed');
});

test('C9 malformed session fields → rejected with a specific reason, nothing written', async () => {
  seed();
  const bad = [
    [{ ref: 'perf_123' }, 'bad_completion_ref'], [{ ref: 'cmp_short' }, 'bad_completion_ref'], [{ ref: 'cmp_' + 'x'.repeat(70) }, 'bad_completion_ref'],
    [{ phase: 'p1' }, 'bad_phase'], [{ phase: '' }, 'bad_phase'], [{ dayIdx: -1 }, 'bad_day'], [{ dayIdx: 14 }, 'bad_day'], [{ dayIdx: 1.5 }, 'bad_day'], [{ dayIdx: 'x' }, 'bad_day'],
    [{ dayLabel: '   ' }, 'bad_day_label'], [{ sessionKind: 'MANDATORY' }, 'bad_session_kind'], [{ sessionKind: 'required' }, 'bad_session_kind'],
    [{ rxFingerprint: 'abc' }, 'bad_rx_fingerprint'], [{ exercisesLogged: -1 }, 'bad_counts'], [{ setsLogged: 1000 }, 'bad_counts'], [{ exercisesPrescribed: 2.5 }, 'bad_counts'],
    [{ timezone: 'Mars/Base' }, 'bad_timezone'], [{ localDate: '2026-13-40' }, 'bad_local_date'], [{ localDate: 'today' }, 'bad_local_date'], [{ localDate: '2020-01-01' }, 'bad_local_date'],
  ];
  for (const [over, want] of bad) { const r = await complete('client_a', TOK.a, over); eq(r.error, want, JSON.stringify(over)); }
  eq((await M.workoutComplete({ storageKey: 'client_a', token: TOK.a }).then(B)).error, 'bad_completion', 'missing completion object');
  eq(rows().length, 0, 'nothing written');
});

test('C10 session not in the programme: V1 cannot know — a well-shaped unknown session IS accepted (documented limitation)', async () => {
  seed();
  const r = await complete('client_a', TOK.a, { phase: '9', dayIdx: 13, dayLabel: 'Day 14 — does not exist' });
  eq(r.ok, true, 'accepted: the server has no session registry to check against');
  assert(/cannot independently prove that the stated session exists/.test(MIG.replace(/\n-- /g, ' ')), 'limitation is written into the migration');
});

test('C11 mandatory / optional / unspecified all recorded as stated', async () => {
  seed();
  let n = 0;
  for (const k of ['mandatory', 'optional', 'unspecified']) await complete('client_a', TOK.a, { ref: ref(++n), sessionKind: k });
  eq(rows().map((r) => r.session_kind).sort().join(','), 'mandatory,optional,unspecified', 'kinds');
});

test('C12 zero / partial logs → accepted (completion is the client\'s statement, not inferred from logs)', async () => {
  seed();
  eq((await complete('client_a', TOK.a, { ref: ref(1), exercisesLogged: 0, setsLogged: 0 })).ok, true, 'zero logs');
  eq((await complete('client_a', TOK.a, { ref: ref(2), exercisesLogged: 2, exercisesPrescribed: 5 })).ok, true, 'partial');
  eq((await complete('client_a', TOK.a, { ref: ref(3), exercisesLogged: null, setsLogged: null, exercisesPrescribed: null, rxFingerprint: null })).ok, true, 'counts optional');
});

test('C13 completed_at: device time kept; future → now; older than 72 h → clamped to 72 h', async () => {
  seed();
  const now = Date.now();
  await complete('client_a', TOK.a, { ref: ref(1), completedAt: new Date(now - 5 * 3600e3).toISOString(), localDate: todayLocal('UTC', now - 5 * 3600e3), timezone: 'UTC' });
  await complete('client_a', TOK.a, { ref: ref(2), completedAt: new Date(now + 3 * 86400e3).toISOString() });
  await complete('client_a', TOK.a, { ref: ref(3), completedAt: new Date(now - 10 * 86400e3).toISOString(), localDate: todayLocal('UTC', now - 72 * 3600e3), timezone: 'UTC' });
  await complete('client_a', TOK.a, { ref: ref(4), completedAt: 'garbage' });
  const at = (n) => Date.parse(rows().find((r) => r.completion_ref === ref(n)).completed_at);
  assert(Math.abs(at(1) - (now - 5 * 3600e3)) < 2000, 'offline tap 5 h ago keeps its time');
  assert(Math.abs(at(2) - now) < 5000, 'future clamped to now');
  assert(Math.abs(at(3) - (now - 72 * 3600e3)) < 5000, 'ancient clamped to 72 h');
  assert(Math.abs(at(4) - now) < 5000, 'unparseable → now');
});

test('C14 local_date must be the tap\'s own calendar day (any real timezone)', async () => {
  seed();
  const now = Date.now();
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Sydney', 'UTC']) {
    const r = await complete('client_a', TOK.a, { ref: 'cmp_tz_' + tz.replace(/\W/g, '_').padEnd(16, 'x'), timezone: tz, localDate: todayLocal(tz, now) });
    eq(r.ok, true, tz);
  }
  eq((await complete('client_a', TOK.a, { ref: ref(9), localDate: todayLocal('UTC', now - 4 * 86400e3) })).error, 'bad_local_date', '4 days off');
});

test('U1 undo own latest within 24 h → revoked; row kept; audit fields set', async () => {
  seed();
  await complete('client_a', TOK.a);
  const u = await undo('client_a', TOK.a, ref(1));
  eq(u.ok, true, 'ok'); eq(u.alreadyRevoked, false, 'first undo');
  const r = rows()[0];
  eq(rows().length, 1, 'never deleted'); eq(r.status, 'revoked', 'revoked'); eq(r.revoked_by, 'client', 'by client'); assert(r.revoked_at, 'revoked_at');
  const again = await undo('client_a', TOK.a, ref(1)); eq(again.alreadyRevoked, true, 'idempotent undo');
  const l = await list('client_a', TOK.a); eq(l.completions[0].status, 'revoked', 'revoked stays visible in history');
});

test('U2 undo refused: not the latest, window closed (>24 h after recording), bad ref', async () => {
  seed();
  await complete('client_a', TOK.a, { ref: ref(1), completedAt: new Date(Date.now() - 3600e3).toISOString() });
  await complete('client_a', TOK.a, { ref: ref(2) });
  eq((await undo('client_a', TOK.a, ref(1))).error, 'not_latest', 'older completion');
  rows().find((r) => r.completion_ref === ref(2)).recorded_at = new Date(Date.now() - 25 * 3600e3).toISOString();
  eq((await undo('client_a', TOK.a, ref(2))).error, 'undo_window_closed', '> 24 h');
  eq((await undo('client_a', TOK.a, 'bogus')).error, 'bad_completion_ref', 'bad ref');
  eq(rows().filter((r) => r.status === 'revoked').length, 0, 'nothing revoked');
});

test('U3 after undoing the latest, the next-most-recent completed one becomes the latest (rule applied literally, 24 h still enforced)', async () => {
  seed();
  await complete('client_a', TOK.a, { ref: ref(1), completedAt: new Date(Date.now() - 3600e3).toISOString() });
  await complete('client_a', TOK.a, { ref: ref(2) });
  await undo('client_a', TOK.a, ref(2));
  const r = await undo('client_a', TOK.a, ref(1));
  eq(r.ok, true, 'ref(1) is now the latest completed and within 24 h — allowed by the stated rule');
});

test('U4 undo with another client\'s token / wrong token → refused', async () => {
  seed();
  await complete('client_a', TOK.a);
  eq((await undo('client_a', TOK.b, ref(1))).error, 'bad_token', 'wrong token');
  eq((await undo('client_b', TOK.b, ref(1))).error, 'not_found', 'B cannot see A\'s ref');
  eq(rows()[0].status, 'completed', 'untouched');
});

test('G1 list: own rows only, newest first, includes revoked, no internals', async () => {
  seed();
  await complete('client_a', TOK.a, { ref: ref(1), completedAt: new Date(Date.now() - 7200e3).toISOString() });
  await complete('client_a', TOK.a, { ref: ref(2) });
  await complete('client_b', TOK.b, { ref: ref(3) });
  const l = await list('client_a', TOK.a);
  eq(l.completions.map((c) => c.ref).join(','), [ref(2), ref(1)].join(','), 'own, newest first');
  assert(l.completions.every((c) => !('client_id' in c) && !('id' in c) && !('storage_key' in c)), 'no internals');
  eq((await list('client_a', 'bad')).error, 'bad_token', 'auth required');
  eq((await list('client_np', TOK.np)).error, 'provisioning_incomplete', 'capability required');
});

test('G2 existing clients with no completion rows → empty list, no inference from exercise logs', async () => {
  seed();
  const l = await list('client_a', TOK.a);
  eq(l.ok, true, 'ok'); eq(l.completions.length, 0, 'empty although an exercise log exists');
});

test('F1 read failure → db_error, nothing written (fail closed)', async () => {
  seed(); S.setFailRead('workout_completions');
  eq((await complete('client_a', TOK.a)).error, 'db_error', 'complete'); eq((await list('client_a', TOK.a)).error, 'db_error', 'list');
  S.setFailRead(null); eq(rows().length, 0, 'nothing written');
});

test('X1 exercise logging untouched: no completion op reads or writes workout_log_entries; workout/workoutCorrect unchanged in dispatch', async () => {
  seed();
  const before = JSON.stringify(DBX.workout_log_entries);
  await complete('client_a', TOK.a); await undo('client_a', TOK.a, ref(1)); await list('client_a', TOK.a);
  eq(JSON.stringify(DBX.workout_log_entries), before, 'exercise logs byte-identical');
  const wc = SRC.slice(SRC.indexOf('const WC_REF_RE'), SRC.indexOf('async function doWrite'));
  assert(!/workout_log_entries/.test(wc.replace(/\/\/.*$/gm, '')), 'no completion code touches workout_log_entries');
  assert(/case 'workout':\s+return clientWrite\('workout', body\);/.test(SRC) && /case 'workoutCorrect':\s+return clientWrite\('workoutCorrect', body\);/.test(SRC), 'exercise-log dispatch unchanged');
  for (const op of ['workoutComplete', 'workoutCompleteUndo', 'workoutCompletionsGet']) assert(new RegExp(`case '${op}':\\s+return ${op}\\(body\\);`).test(SRC), op + ' dispatched');
});

test('X2 every completion handler authenticates then checks log_workout before any DB access', async () => {
  for (const fn of ['workoutComplete', 'workoutCompleteUndo', 'workoutCompletionsGet']) {
    const i = SRC.indexOf(`async function ${fn}(`), body = SRC.slice(i, SRC.indexOf('\n}\n', i));
    const iv = body.indexOf('verifyClientToken('), ic = body.indexOf("requireCapability(key, 'log_workout')"), idb = body.indexOf("admin.from('workout_completions')");
    assert(iv > 0 && ic > iv && idb > ic, fn + ': token → capability → database');
    assert(!/body\??\.client_?[iI]d/.test(body), fn + ': never reads a client id from the body');
  }
});

test('X3 migration: one new table, additive, RLS on, grants revoked, unique (client_id, completion_ref)', async () => {
  const live = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/\b(drop|delete|update|truncate)\b/i.test(live.replace(/on delete cascade/gi, '')), 'no destructive statement');
  assert(!/alter table public\.(?!workout_completions)/.test(live), 'no other table altered');
  assert(/enable row level security/.test(live) && /revoke all on public\.workout_completions from anon, authenticated/.test(live), 'locked down');
  assert(/unique \(client_id, completion_ref\)/.test(live), 'idempotency constraint');
  for (const c of ['phase_key', 'day_index', 'day_label', 'rx_fingerprint', 'session_kind', 'completed_at', 'recorded_at', 'local_date', 'timezone', 'status', 'revoked_at', 'revoked_by']) assert(WC_COLUMNS.has(c), 'column ' + c);
  const used = SRC.match(/const WC_COLS = '([^']+)'/)[1].split(',').map((s) => s.trim());
  for (const c of used) assert(WC_COLUMNS.has(c), 'api selects existing column ' + c);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + (e && e.message)); }
  }
  const leaked = LOGS.join('\n');
  for (const t of Object.values(TOK)) if (leaked.includes(t)) { fail++; console.log('  FAIL  a token reached a log'); }
  console.log(`\nworkout_completion: ${pass} passed, ${fail} failed, ${tests.length} total`);
  process.exit(fail ? 1 : 0);
})();
