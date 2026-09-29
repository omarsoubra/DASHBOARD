// LOCKED IN Notifications V2 — check-in adherence sequence + observation map.
//
// 0 production invocations. Real handler.ts / schedule.ts / adherence.ts source,
// strict in-memory Supabase stand-in, fake push service that decrypts every
// message (tests/push_harness.js).
//
// Usage (from the DASHBOARD repo root):   node tests/push_v2.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const {
  rd, SCH, H, ADH, test, assert, eq, run, REASONS,
  CANARY, OTHER, CANARY_TOKEN, OTHER_TOKEN, world, assertNoLeak,
} = require('./push_harness');

const TZ = 'Australia/Sydney';
const at = (date, hhmm, tz = TZ) => SCH.zonedTimeToUtc(date, SCH.parseTime(hhmm), tz);
const iso = (ms) => new Date(ms).toISOString();

// A normal (post-DST-start) week: Thursday 2026-10-08 .. Sunday 2026-10-11 .. Monday 2026-10-12.
const SUN = '2026-10-11', MON = '2026-10-12', SAT = '2026-10-10';
const NEXT_SUN = '2026-10-18';

const COPY = {
  due: 'Your weekly check-in is ready. Take a minute to get it done.',
  followup: 'Your check-in is still waiting. Get it done tonight so Omar can review your week.',
  final: 'You missed your weekly check-in. Get it done today so your coaching stays on track.',
};

/** The canary, opted in from one device, ON the V2 sequence (unless seq: false). */
async function seqWorld(opts = {}) {
  const w = await world({ now: opts.now ?? at(SUN, '09:05'), checkinSeq: opts.seq === false ? undefined : (opts.seqKeys ?? [CANARY]) });
  w.sub = w.newSub();
  const r = await w.subscribe(w.sub, { timezone: opts.tz ?? TZ });
  assert(r.j.ok, 'opt-in subscribe ok');
  const pr = w.db.T.push_preferences.find((p) => p.client_id === w.canaryId);
  Object.assign(pr, opts.prefs || {});
  return w;
}
/** A real (non-internal) entitled 1:1 client opted in — eligible by entitlement, no list entry. */
async function realClientWorld(opts = {}) {
  const w = await world({ now: opts.now ?? at(SUN, '09:05'), allowed: [], checkinSeq: ['*'] });
  w.db.T.client_entitlements.push({ id: w.db.uuid(), client_id: w.otherId, product_code: 'locked_in_1to1', status: 'active', starts_at: null, ends_at: null, source: 'manual' });
  w.sub = w.newSub();
  const r = await w.call({ type: 'pushSubscribe', storageKey: OTHER, token: OTHER_TOKEN, subscription: w.sub.json, timezone: TZ, standalone: true });
  assert(r.j.ok, 'real client opt-in ok');
  return w;
}
const ci = (w) => w.db.T.notification_events.filter((e) => e.kind === 'checkin_reminder');
const ciFor = (w, id) => ci(w).filter((e) => e.client_id === id);
const pushes = (w) => w.svc.received.filter((r) => r.payload.tag === 'li-checkin');
const logCheckin = (w, ms, id) => w.db.T.check_ins.push({ id: w.db.uuid(), client_id: id ?? w.canaryId, submitted_at: iso(ms) });
const tickAt = async (w, ms) => { w.clock.now = ms; return w.tick(); };
/** Run the real 15-minute scheduler over [from, to). */
async function scheduler(w, from, to, onTick) {
  for (let t = from; t < to; t += 15 * 60000) { if (onTick) await onTick(t); await tickAt(w, t); }
}
const stageOf = (e) => e.dedupe_key.split(':')[0];

// ════════════════════════════════════════════════════════════════════════════
// SM. Sunday morning — due stage
// ════════════════════════════════════════════════════════════════════════════
test('SM1 due + incomplete → one reminder: approved copy, own key, opens the app', async () => {
  const w = await seqWorld();
  const r = await w.tick();
  eq(r.j.summary.sent, 1, 'sent'); eq(r.j.summary.checkinStages.due, 1, 'due stage counted');
  const e = ci(w); eq(e.length, 1, 'one event');
  eq(e[0].dedupe_key, `checkin_due:${w.canaryId}:${SUN}`, 'deterministic key'); eq(e[0].period_key, SUN, 'period');
  eq(e[0].eligible_at, iso(at(SUN, '09:00')), 'eligible_at = 09:00 local');
  const p = pushes(w); eq(p.length, 1, 'one push');
  eq(p[0].payload.title, 'LOCKED IN', 'title'); eq(p[0].payload.body, COPY.due, 'copy'); eq(p[0].payload.url, './', 'no invented deep link');
  eq(p[0].headers.TTL, String(6 * 3600), 'expires before the follow-up');
  assertNoLeak(w);
});

test('SM2 already completed (Saturday) → silent, recorded already_completed', async () => {
  const w = await seqWorld();
  logCheckin(w, at(SAT, '17:00'));
  await w.tick();
  eq(pushes(w).length, 0, 'silent'); eq(ci(w)[0].suppression_reason, 'already_completed', 'reason');
});

test('SM3 not yet eligible (programme < 6 days old) → nothing, for every stage', async () => {
  const w = await seqWorld();
  w.db.T.clients.find((c) => c.id === w.canaryId).start_date = '2026-10-07';
  for (const t of [at(SUN, '09:05'), at(SUN, '18:05'), at(MON, '10:05')]) await tickAt(w, t);
  eq(ci(w).length, 0, 'no events'); eq(pushes(w).length, 0, 'silent');
});

test('SM4 notifications off (master, or check-in toggle) → silent', async () => {
  for (const prefs of [{ notifications_enabled: false }, { checkin_enabled: false }]) {
    const w = await seqWorld({ prefs });
    await w.tick();
    eq(pushes(w).length, 0, 'silent'); eq(ci(w)[0].suppression_reason, 'disabled', 'reason');
  }
});

test('SM5 no active device → silent', async () => {
  const w = await seqWorld();
  await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: w.sub.json.endpoint });
  await w.tick();
  eq(pushes(w).length, 0, 'silent'); eq(ci(w)[0].suppression_reason, 'no_active_device', 'reason');
});

test('SM6 revoked / suspended → silent (real client: not even evaluated; canary exception: inactive)', async () => {
  for (const st of ['revoked', 'suspended']) {
    const w = await realClientWorld();
    w.db.T.client_sessions.find((s) => s.storage_key === OTHER).access_status = st;
    for (const t of [at(SUN, '09:05'), at(SUN, '18:05'), at(MON, '10:05')]) await tickAt(w, t);
    eq(ciFor(w, w.otherId).length, 0, `${st}: nothing recorded`); eq(pushes(w).length, 0, `${st}: silent`);
  }
  const w = await seqWorld();
  w.db.T.client_sessions.find((s) => s.storage_key === CANARY).access_status = 'revoked';
  await w.tick();
  eq(pushes(w).length, 0, 'silent'); eq(ci(w)[0].suppression_reason, 'inactive_client', 'reason');
});

test('SM7 real 1:1 client eligible by entitlement receives the sequence; paused client does not', async () => {
  let w = await realClientWorld();
  await w.tick();
  eq(ciFor(w, w.otherId)[0].status, 'sent', 'sent to entitled client');
  w = await realClientWorld();
  w.db.T.clients.find((c) => c.id === w.otherId).is_paused = true;
  await w.tick();
  eq(pushes(w).length, 0, 'paused → silent'); eq(ciFor(w, w.otherId)[0].suppression_reason, 'inactive_client', 'reason');
});

test('SM8 client NOT on the sequence keeps the V1 single reminder (key checkin:, V1 copy, no follow-ups)', async () => {
  const w = await seqWorld({ seq: false });
  for (const t of [at(SUN, '09:05'), at(SUN, '18:05'), at(MON, '10:05')]) await tickAt(w, t);
  eq(ci(w).length, 1, 'one event'); eq(ci(w)[0].dedupe_key, `checkin:${w.canaryId}:${SUN}`, 'V1 key');
  eq(pushes(w)[0].payload.body, 'Your weekly check-in is ready when you are.', 'V1 copy');
});

// ════════════════════════════════════════════════════════════════════════════
// SE. Sunday evening — follow-up stage
// ════════════════════════════════════════════════════════════════════════════
test('SE1 morning sent + still incomplete at 18:05 → exactly one follow-up', async () => {
  const w = await seqWorld();
  await w.tick();
  const r = await tickAt(w, at(SUN, '18:05'));
  eq(r.j.summary.checkinStages.followup, 1, 'follow-up stage sent');
  eq(pushes(w).length, 2, 'two pushes total'); eq(pushes(w)[1].payload.body, COPY.followup, 'copy');
  const f = ci(w).find((e) => stageOf(e) === 'checkin_followup');
  eq(f.dedupe_key, `checkin_followup:${w.canaryId}:${SUN}`, 'own key'); eq(f.eligible_at, iso(at(SUN, '18:00')), 'eligible_at');
});

test('SE2 completed after the morning reminder → follow-up silent', async () => {
  const w = await seqWorld();
  await w.tick();
  logCheckin(w, at(SUN, '14:10'));
  await tickAt(w, at(SUN, '18:05'));
  eq(pushes(w).length, 1, 'only the morning push');
  eq(ci(w).find((e) => stageOf(e) === 'checkin_followup').suppression_reason, 'already_completed', 'reason');
});

test('SE3 morning scheduler missed + still incomplete → follow-up sends (by design); morning is never back-filled', async () => {
  const w = await seqWorld({ now: at(SUN, '18:05') });
  await w.tick();
  eq(ci(w).length, 1, 'only one event'); eq(stageOf(ci(w)[0]), 'checkin_followup', 'follow-up');
  eq(pushes(w).length, 1, 'one push'); eq(pushes(w)[0].payload.body, COPY.followup, 'follow-up copy');
  await tickAt(w, at(SUN, '18:20'));
  eq(ci(w).filter((e) => stageOf(e) === 'checkin_due').length, 0, 'due stage never retro-claimed');
});

test('SE4 retries / re-runs inside the follow-up window → no duplicate', async () => {
  const w = await seqWorld();
  await w.tick();
  for (const hhmm of ['18:00', '18:05', '18:15', '18:30', '18:45', '18:59']) await tickAt(w, at(SUN, hhmm));
  eq(ci(w).filter((e) => stageOf(e) === 'checkin_followup').length, 1, 'one follow-up event'); eq(pushes(w).length, 2, 'two pushes');
});

test('SE5 follow-up window is [18:00, 19:00): 17:59 and 19:00 do nothing', async () => {
  const w = await seqWorld();
  await w.tick();
  await tickAt(w, at(SUN, '17:59')); await tickAt(w, at(SUN, '19:00'));
  eq(ci(w).length, 1, 'only the due event');
});

// ════════════════════════════════════════════════════════════════════════════
// MF. Monday — final stage
// ════════════════════════════════════════════════════════════════════════════
test('MF1 still incomplete Monday 10:05 → one final reminder', async () => {
  const w = await seqWorld();
  await w.tick(); await tickAt(w, at(SUN, '18:05'));
  const r = await tickAt(w, at(MON, '10:05'));
  eq(r.j.summary.checkinStages.final, 1, 'final sent');
  const f = ci(w).find((e) => stageOf(e) === 'checkin_final');
  eq(f.dedupe_key, `checkin_final:${w.canaryId}:${SUN}`, 'key belongs to the SUNDAY period'); eq(f.eligible_at, iso(at(MON, '10:00')), 'eligible_at Monday 10:00');
  eq(pushes(w).length, 3, 'three pushes'); eq(pushes(w)[2].payload.body, COPY.final, 'copy');
});

test('MF2 completed Sunday night → final silent', async () => {
  const w = await seqWorld();
  await w.tick(); await tickAt(w, at(SUN, '18:05'));
  logCheckin(w, at(SUN, '22:40'));
  await tickAt(w, at(MON, '10:05'));
  eq(pushes(w).length, 2, 'no final push'); eq(ci(w).find((e) => stageOf(e) === 'checkin_final').suppression_reason, 'already_completed', 'reason');
});

test('MF3 completed Monday morning before evaluation → final silent', async () => {
  const w = await seqWorld();
  await w.tick(); await tickAt(w, at(SUN, '18:05'));
  logCheckin(w, at(MON, '09:58'));
  await tickAt(w, at(MON, '10:00'));
  eq(pushes(w).length, 2, 'no final push');
});

test('MF4 retry of the final stage → no duplicate', async () => {
  const w = await seqWorld({ now: at(MON, '10:05') });
  await w.tick(); await tickAt(w, at(MON, '10:05')); await tickAt(w, at(MON, '10:50'));
  eq(ci(w).length, 1, 'one event'); eq(pushes(w).length, 1, 'one push');
});

test('MF5 after the final stage → nothing more, all week (real 15-min scheduler Mon 10:00 → next Sun 08:45)', async () => {
  const w = await seqWorld();
  await scheduler(w, at(SUN, '09:00'), at(NEXT_SUN, '08:46'));
  eq(pushes(w).length, 3, 'exactly three pushes for the period');
  eq(ci(w).map(stageOf).sort().join(','), 'checkin_due,checkin_final,checkin_followup', 'one per stage');
  assert(ci(w).every((e) => e.period_key === SUN), 'all in the Sunday period');
  const last = Math.max(...w.db.T.notification_events.filter((e) => e.kind === 'checkin_reminder').map((e) => Date.parse(e.created_at)));
  assert(last < at(MON, '11:00'), 'nothing after Monday 11:00');
});

// ════════════════════════════════════════════════════════════════════════════
// PH. Periods, time, quiet hours, precedence, outages
// ════════════════════════════════════════════════════════════════════════════
test('PH1 next week gets new keys; last week\'s events never suppress it', async () => {
  const w = await seqWorld();
  await scheduler(w, at(SUN, '09:00'), at(MON, '11:00'));
  await tickAt(w, at(NEXT_SUN, '09:05'));
  const next = ci(w).filter((e) => e.period_key === NEXT_SUN);
  eq(next.length, 1, 'new period event'); eq(next[0].status, 'sent', 'sent'); eq(next[0].dedupe_key, `checkin_due:${w.canaryId}:${NEXT_SUN}`, 'new key');
});

test('PH2 completion window = the shell rule: D-6 (Monday) counts, D-7 (last Sunday) does not', async () => {
  let w = await seqWorld();
  logCheckin(w, at('2026-10-05', '00:05'));          // Monday D-6
  await w.tick(); eq(ci(w)[0].suppression_reason, 'already_completed', 'D-6 counts');
  w = await seqWorld();
  logCheckin(w, at('2026-10-04', '23:50'));          // Sunday D-7
  await w.tick(); eq(ci(w)[0].status, 'sent', 'D-7 does not count');
});

test('PH3 Sydney DST start (Sun 2026-10-04, 23 h day): stages at 09:00/18:00 AEDT, final Mon 10:00 AEDT', async () => {
  const D = '2026-10-04';
  const w = await seqWorld({ now: at(D, '09:05') });
  await scheduler(w, at(D, '00:00'), at('2026-10-05', '12:00'));
  const byStage = Object.fromEntries(ci(w).map((e) => [stageOf(e), e]));
  eq(byStage.checkin_due.eligible_at, '2026-10-03T22:00:00.000Z', 'due 09:00 AEDT (+11)');
  eq(byStage.checkin_followup.eligible_at, '2026-10-04T07:00:00.000Z', 'follow-up 18:00 AEDT');
  eq(byStage.checkin_final.eligible_at, '2026-10-04T23:00:00.000Z', 'final Mon 10:00 AEDT');
  eq(pushes(w).length, 3, 'three pushes, no DST duplicate');
});

test('PH4 Sydney DST end (Sun 2027-04-04, 25 h day): one push per stage', async () => {
  const D = '2027-04-04';
  const w = await seqWorld({ now: at(D, '00:00') });
  await scheduler(w, at('2027-04-03', '12:00'), at('2027-04-05', '12:00'));
  eq(pushes(w).length, 3, 'three pushes'); eq(new Set(ci(w).map((e) => e.dedupe_key)).size, 3, 'three distinct keys');
});

test('PH5 UTC client: stages follow UTC wall clock, not the server or Sydney', async () => {
  const w = await seqWorld({ tz: 'UTC', now: Date.UTC(2026, 9, 11, 9, 5) });
  await w.tick();
  eq(ci(w)[0].eligible_at, '2026-10-11T09:00:00.000Z', 'due 09:00Z'); eq(ci(w)[0].period_key, SUN, 'period');
  await tickAt(w, at(SUN, '18:05'));                  // 07:05Z — no UTC stage open
  eq(ci(w).length, 1, 'Sydney evening is not a UTC stage');
});

test('PH6 quiet hours: a stage inside quiet hours is suppressed (never deferred, never delivered later)', async () => {
  const w = await seqWorld({ prefs: { quiet_start: '17:00', quiet_end: '09:30' } });
  await scheduler(w, at(SUN, '08:00'), at(MON, '12:00'));
  const s = Object.fromEntries(ci(w).map((e) => [stageOf(e), e]));
  eq(s.checkin_due.suppression_reason, 'quiet_hours', 'due 09:00 in quiet → suppressed');
  eq(s.checkin_followup.suppression_reason, 'quiet_hours', 'follow-up 18:00 in quiet → suppressed');
  eq(s.checkin_final.status, 'sent', 'final 10:00 outside quiet → sent');
  eq(pushes(w).length, 1, 'one push'); assert(ci(w).every((e) => e.status !== 'deferred'), 'no deferred check-in events');
});

test('PH7 obsolete stage: suppressed morning + completion by evening → nothing is ever sent', async () => {
  const w = await seqWorld({ prefs: { quiet_start: '21:00', quiet_end: '09:30' } });
  await scheduler(w, at(SUN, '08:00'), at(MON, '12:00'), async (t) => { if (t === at(SUN, '13:00')) logCheckin(w, t); });
  eq(pushes(w).length, 0, 'silent all period');
  eq(ci(w).find((e) => stageOf(e) === 'checkin_due').suppression_reason, 'quiet_hours', 'morning suppressed by quiet hours');
});

test('PH8 at most one stage is open at any instant (every minute, 4 days, several schedules)', async () => {
  const variants = [
    {}, { checkin_time: '17:00' }, { checkin_time: '19:00' }, { checkin_time: '23:30' },
    { checkin_followup_time: '09:10', checkin_time: '09:00' },
    { checkin_final_day_offset: 0, checkin_time: '14:00', checkin_followup_time: '14:15', checkin_final_time: '14:30' },
  ];
  for (const v of variants) {
    const p = { ...H.DEFAULT_PREFS, notifications_enabled: true, timezone: TZ, checkin_followup_time: '18:00', checkin_final_time: '10:00', checkin_final_day_offset: 1, ...v };
    const seen = new Map();
    for (let t = at('2026-10-09', '00:00'); t < at('2026-10-13', '00:00'); t += 60000) {
      const e = SCH.evaluateCheckinStage(p, t, null);
      if (e.due) { const k = e.stage + '@' + e.periodKey; if (!seen.has(k)) seen.set(k, t); }
    }
    const stages = [...seen.keys()];
    assert(stages.length >= 1 && stages.length <= 3, `1..3 stages (${JSON.stringify(v)}): ${stages}`);
    const times = [...seen.values()];
    for (let i = 1; i < times.length; i++) assert(times[i] > times[i - 1], 'stages strictly ordered in time');
  }
});

test('PH9 stage schedule rules: 19:00 check-in drops the 18:00 follow-up; 17:00 keeps it with a truncated window', async () => {
  const base = { ...H.DEFAULT_PREFS, checkin_followup_time: '18:00', checkin_final_time: '10:00', checkin_final_day_offset: 1 };
  eq(SCH.checkinStages({ ...base, checkin_time: '19:00' }).map((s) => s.stage).join(','), 'due,final', '19:00: no follow-up');
  eq(SCH.checkinStages({ ...base, checkin_time: '17:00' }).map((s) => s.stage).join(','), 'due,followup,final', '17:00: all three');
  const p = { ...base, notifications_enabled: true, timezone: TZ, checkin_time: '17:30' };
  eq(SCH.evaluateCheckinStage(p, at(SUN, '17:55')).stage, 'due', '17:55 due');
  eq(SCH.evaluateCheckinStage(p, at(SUN, '18:00')).stage, 'followup', '18:00 hands over to follow-up (no overlap)');
  eq(SCH.checkinStages({ ...base, checkin_final_day_offset: 5 }).length, 2, 'invalid offset → final dropped, never guessed');
});

test('PH10 timezone change mid-period cannot duplicate a stage', async () => {
  const w = await seqWorld();
  await w.tick();                                        // due sent at 09:05 Sydney
  w.db.T.push_preferences.find((p) => p.client_id === w.canaryId).timezone = 'Australia/Perth';
  await tickAt(w, at(SUN, '11:05'));                     // 08:05 Perth — not yet
  await tickAt(w, at(SUN, '12:05'));                     // 09:05 Perth — same period, same key
  eq(ci(w).filter((e) => stageOf(e) === 'checkin_due').length, 1, 'one due event'); eq(pushes(w).length, 1, 'one push');
});

test('PH11 scheduler outage: recovery never releases a burst', async () => {
  let w = await seqWorld({ now: at(MON, '12:00') });     // down all Sunday + Monday morning
  await scheduler(w, at(MON, '12:00'), at(MON, '18:00'));
  eq(pushes(w).length, 0, 'recovery after the last window → nothing');
  w = await seqWorld();
  await scheduler(w, at(SUN, '18:30'), at(MON, '12:00')); // down 08:00–18:30
  eq(pushes(w).length, 2, 'only the follow-up (late in its window) and the final');
  eq(ci(w).map(stageOf).sort().join(','), 'checkin_final,checkin_followup', 'no back-filled morning');
});

test('PH12 migration mid-Sunday: a V1 reminder already claimed for the period counts as the due stage; rollback is symmetric', async () => {
  let w = await seqWorld({ seq: false });
  await w.tick();                                                    // V1 sends 09:05
  w.env.checkinSequence = { all: false, keys: new Set([CANARY]) };   // moved onto V2
  await tickAt(w, at(SUN, '09:35'));
  eq(pushes(w).length, 1, 'no second morning push');
  w = await seqWorld();
  await w.tick();                                                    // V2 due sent
  w.env.checkinSequence = undefined;                                 // rolled back to V1
  await tickAt(w, at(SUN, '09:35'));
  eq(pushes(w).length, 1, 'rollback does not re-send the morning reminder');
});

test('PH13 state unknown (check-in query fails) → silence, nothing claimed; next tick recovers', async () => {
  const w = await seqWorld();
  w.db.fail.on = 'check_ins';
  const r = await w.tick();
  eq(r.j.summary.stateErrors, 1, 'error counted'); eq(ci(w).length, 0, 'nothing claimed'); eq(pushes(w).length, 0, 'silent');
  w.db.fail.on = null; await tickAt(w, at(SUN, '09:20'));
  eq(pushes(w).length, 1, 'recovered');
});

test('PH14 property: for any completion instant, stages after it are silent; max 3 per period', async () => {
  const instants = [null, at(SAT, '12:00'), at(SUN, '09:30'), at(SUN, '17:59'), at(SUN, '18:30'), at(SUN, '23:59'), at(MON, '09:59'), at(MON, '10:10')];
  for (const done of instants) {
    const w = await seqWorld({ now: at(SUN, '00:00') });
    let logged = false;
    await scheduler(w, at(SUN, '00:00'), at(MON, '23:00'), async (t) => { if (done !== null && !logged && t >= done) { logCheckin(w, done); logged = true; } });
    const sentAt = ci(w).filter((e) => e.status === 'sent').map((e) => Date.parse(e.eligible_at));
    assert(sentAt.length <= 3, 'max 3');
    if (done !== null) assert(sentAt.every((t) => t < done), `nothing sent after completion (${iso(done)})`);
  }
});

test('PH15 deploying V2 on a non-check-in day sends nothing', async () => {
  const w = await realClientWorld({ now: at('2026-09-30', '12:00') });   // a Wednesday
  await scheduler(w, at('2026-09-30', '00:00'), at('2026-10-03', '23:59'));
  eq(pushes(w).length, 0, 'no notification merely because V2 deployed'); eq(ci(w).length, 0, 'nothing recorded');
});

// ════════════════════════════════════════════════════════════════════════════
// DR. The adherence decision pattern (pure)
// ════════════════════════════════════════════════════════════════════════════
test('DR1 decideReminder: default silence; send only with every positive answer; unknown never sends', async () => {
  const ok = { due: true, observation: 'incomplete', eligible: true, active: true, enabled: true, quiet: false, hasDevice: true };
  eq(SCH.decideReminder(ok).send, true, 'all positive → send');
  const flips = { due: false, eligible: false, active: false, enabled: false, quiet: true, hasDevice: false };
  for (const [k, v] of Object.entries(flips)) eq(SCH.decideReminder({ ...ok, [k]: v }).send, false, `${k} → silent`);
  for (const o of ['completed', 'unknown']) eq(SCH.decideReminder({ ...ok, observation: o }).send, false, `${o} → silent`);
  eq(SCH.decideReminder({ ...ok, observation: 'unknown' }).record, false, 'unknown is not recorded (retry)');
  eq(SCH.decideReminder({ ...ok, observation: 'completed', quiet: true }).reason, 'already_completed', 'completion outranks quiet hours');
  for (const k of Object.keys(flips)) {
    const d = SCH.decideReminder({ ...ok, [k]: flips[k] });
    if (d.record) assert(REASONS.includes(d.reason), `recorded reason ${d.reason} is in the schema vocabulary`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// WO. Workout observation — must refuse to infer a missed workout
// ════════════════════════════════════════════════════════════════════════════
const fixedProg = { sessionWeekdays: [1, 3, 5], optional: [false, false, false] };
const done = (dayIndex, localDate) => ({ dayIndex, localDate, sessionComplete: true });

test('WO1 flexible programme (sequential days, no weekdays) → refuses', async () => {
  eq(ADH.observeWorkout({ sessionWeekdays: [null, null, null, null] }, [done(0, '2026-10-12')], '2026-10-12', 1).reason, 'flexible_schedule', 'flexible');
});

test('WO2 session moved to another day → refuses (shift is not a skip)', async () => {
  eq(ADH.observeWorkout(fixedProg, [done(0, '2026-10-13')], '2026-10-12', 1).reason, 'session_moved', 'moved');
});

test('WO3 completion data absent → refuses', async () => {
  eq(ADH.observeWorkout(fixedProg, null, '2026-10-12', 1).reason, 'no_completion_data', 'null');
  eq(ADH.observeWorkout(fixedProg, [], '2026-10-12', 1).reason, 'no_completion_data', 'empty');
  eq(ADH.observeWorkout(fixedProg, [{ dayIndex: null, localDate: null }], '2026-10-12', 1).reason, 'no_completion_data', 'unusable rows');
});

test('WO4 expected session cannot be determined → refuses', async () => {
  eq(ADH.observeWorkout(null, [], '2026-10-12', 1).reason, 'expected_session_unknown', 'no programme');
  eq(ADH.observeWorkout(fixedProg, [done(0, '2026-10-12')], '2026-10-13', 2).reason, 'expected_session_unknown', 'rest day');
  eq(ADH.observeWorkout({ sessionWeekdays: [1, 1] }, [done(0, '2026-10-12')], '2026-10-12', 1).reason, 'expected_session_unknown', 'two sessions same weekday');
});

test('WO5 production-shaped logs (per-exercise rows, no session marker) → refuses; optional day → refuses', async () => {
  eq(ADH.observeWorkout(fixedProg, [{ dayIndex: 0, localDate: '2026-10-12' }], '2026-10-12', 1).reason, 'no_session_marker', 'no marker');
  eq(ADH.observeWorkout({ sessionWeekdays: [1], optional: [true] }, [done(0, '2026-10-12')], '2026-10-12', 1).reason, 'optional_session', 'optional');
  const ok = ADH.observeWorkout(fixedProg, [done(0, '2026-10-12')], '2026-10-12', 1);
  eq(ok.canInferMissed, true, 'only a fixed schedule + session marker is inferable'); eq(ok.completed, true, 'completed');
});

test('WO6 fleet fact: no live 1:1 programme schedules sessions on weekdays → every real programme is "flexible"', async () => {
  const dir = path.join(process.cwd(), 'clients');
  const WEEKDAY = /\b(mon|tue|wed|thu|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b/i;
  let labels = 0, weekday = 0;
  for (const k of fs.readdirSync(dir)) {
    const f = path.join(dir, k, 'index.html');
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('LOCKED-IN-PUSH:v1')) continue;
    for (const m of src.matchAll(/label:\s*['"](Day \d+[^'"]{0,80})/g)) { labels++; if (WEEKDAY.test(m[1])) weekday++; }
  }
  assert(labels > 100, 'session labels found in the fleet'); eq(weekday, 0, 'no weekday-scheduled sessions');
});

test('WO7 signal map: only the weekly check-in is RELIABLE; the handler reads no partial/unavailable signal', async () => {
  const rel = Object.entries(ADH.SIGNALS).filter(([, s]) => s.reliability === 'reliable').map(([k]) => k);
  eq(rel.join(','), 'weekly_checkin', 'reliable signals');
  const src = rd('supabase/functions/push/handler.ts');
  for (const t of ['workout_log_entries', 'meal_logs', 'adherence.ts']) assert(!src.includes(t), `handler does not use ${t}`);
  eq(H.DEFAULT_PREFS.weighin_available, false, 'weigh-in stays unavailable by default');
});

// ════════════════════════════════════════════════════════════════════════════
// AS. Anti-spam / lock-screen / schema
// ════════════════════════════════════════════════════════════════════════════
test('AS1 check-in copy is lock-screen safe (no numbers, weights, calories or macros)', async () => {
  for (const k of ['checkin_due', 'checkin_followup', 'checkin_final']) {
    const t = H.TEMPLATES[k];
    eq(t.kind, 'checkin_reminder', `${k} kind`); eq(t.tag, 'li-checkin', `${k} replaces earlier stages on the lock screen`);
    assert(!/\d|kg|lb|calor|kcal|macro|protein|carb|fat|weight/i.test(t.body), `${k} has no sensitive content`);
  }
  eq(H.TEMPLATES.checkin_due.body, COPY.due, 'due copy'); eq(H.TEMPLATES.checkin_followup.body, COPY.followup, 'follow-up copy'); eq(H.TEMPLATES.checkin_final.body, COPY.final, 'final copy');
});

test('AS2 program-update behaviour untouched (V1 template + verified-live requirement in place)', async () => {
  eq(H.TEMPLATES.program_update.body, 'Your program has been updated. Tap to view it.', 'copy unchanged');
  const src = rd('supabase/functions/push/handler.ts');
  assert(/Called ONLY by the deploy notifier after the served shell bytes equal the/.test(src), 'programUpdated contract unchanged');
  assert(rd('.github/workflows/push-program-updated.yml').length > 0, 'notifier workflow present');
});

test('AS3 migration V2 is additive, push_preferences only, and clients cannot write the stage schedule', async () => {
  const H2 = require('./push_harness');
  const live = H2.MIGRATION_V2.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/\bdrop\s+(table|column)\b/i.test(live), 'no drops outside the DOWN block');
  assert(!/\b(update|delete|insert)\b\s/i.test(live.replace(/comment on column[\s\S]*?;/g, '')), 'no data writes');
  const tables = [...live.matchAll(/alter table public\.([a-z_]+)/g)].map((m) => m[1]);
  assert(tables.length && tables.every((t) => t === 'push_preferences'), 'push_preferences only');
  const w = await seqWorld({ now: at('2026-09-30', '12:00') });
  for (const f of ['checkinFollowupTime', 'checkinFinalTime', 'checkinFinalDayOffset', 'checkin_final_time']) {
    const r = await w.prefsSet({ [f]: '12:00' });
    eq(r.j.error, 'unknown_field', `${f} is coach-owned`);
  }
});

test('AS4 no secret, token, endpoint or key in any response or log across a full sequence', async () => {
  const w = await seqWorld();
  await scheduler(w, at(SUN, '08:00'), at(MON, '12:00'));
  assertNoLeak(w);
});

run('push_v2');
