// LOCKED IN Push — Daily Reminders V1 (training + meals).
//
// 0 production invocations. Real handler.ts / schedule.ts source, strict
// in-memory Supabase stand-in built from the migrations, fake push service that
// decrypts every message (tests/push_harness.js), the real plan-facts parser
// (scripts/push/plan_facts.mjs) and the real sync script with stub git/fetch.
//
// Usage (from the DASHBOARD repo root):   node tests/push_daily.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const {
  rd, SCH, H, test, assert, eq, run, REASONS, KINDS, MIGRATION_DAILY,
  CANARY, OTHER, CANARY_TOKEN, OTHER_TOKEN, COACH_HASH, DEPLOY_SECRET, sha256hex, world, assertNoLeak,
} = require('./push_harness');

const TZ = 'Australia/Sydney';
const at = (date, hhmm, tz = TZ) => SCH.zonedTimeToUtc(date, SCH.parseTime(hhmm), tz);
const iso = (ms) => new Date(ms).toISOString();
const mask = (...days) => days.reduce((m, d) => m | (1 << d), 0);

// Week of Mon 2026-10-12 (AEDT, after the Oct 4 DST start).
const MON = '2026-10-12', TUE = '2026-10-13', WED = '2026-10-14';
const MON_DOW = 1, WED_DOW = 3;

const FACTS_4 = { meal_facts_status: 'consistent', meal_slot_count: 4, has_workout_completion: true, served_sha256: sha256hex('shell-4'), meal_plan_sig: sha256hex('plan-4') };

/** The canary, opted in from one device, in the daily rollout, with plan facts. */
async function dailyWorld(opts = {}) {
  const w = await world({ now: opts.now ?? at(MON, '06:00'), daily: opts.daily === false ? undefined : (opts.dailyKeys ?? [CANARY]), checkinSeq: opts.checkinSeq });
  w.sub = w.newSub();
  const r = await w.subscribe(w.sub, { timezone: opts.tz ?? TZ });
  assert(r.j.ok, 'opt-in subscribe ok');
  const pr = w.db.T.push_preferences.find((p) => p.client_id === w.canaryId);
  Object.assign(pr, { quiet_start: '22:00:00', quiet_end: '06:00:00' }, opts.prefs || {});
  if (opts.facts !== null) {
    w.db.T.push_plan_facts.push({ client_id: w.canaryId, storage_key: CANARY, meal_plan_sig: null, commit_sha: null, updated_at: iso(w.clock.now), ...FACTS_4, ...(opts.facts || {}) });
  }
  return w;
}
const TRAIN = { training_enabled: true, training_days: mask(MON_DOW, WED_DOW), training_time: '18:00:00' };
const TRAIN_FU = { ...TRAIN, training_followup_enabled: true, training_followup_time: '20:00:00' };
const MEALS4 = { meals_enabled: true, meal_times: ['08:00:00', '12:30:00', '17:00:00', '20:30:00'] };

const ev = (w, kind) => w.db.T.notification_events.filter((e) => !kind || e.kind === kind);
const pushes = (w, tag) => w.svc.received.filter((r) => !tag || r.payload.tag === tag);
const tickAt = async (w, ms) => { w.clock.now = ms; return w.tick(); };
async function scheduler(w, from, to, onTick) {
  for (let t = from; t < to; t += 15 * 60000) { if (onTick) await onTick(t); await tickAt(w, t); }
}
let refN = 0;
function finishWorkout(w, ms, opts = {}) {
  const row = {
    id: w.db.uuid(), client_id: opts.clientId ?? w.canaryId, storage_key: CANARY,
    completion_ref: 'cmp_' + String(++refN).padStart(16, '0'), phase_key: '1', day_index: 0, day_label: 'Day 1 — Push',
    session_kind: 'mandatory', completed_at: iso(ms), recorded_at: iso(opts.recordedAt ?? ms), local_date: opts.localDate ?? SCH.localParts(ms, TZ).date,
    timezone: opts.tz ?? TZ, status: 'completed', revoked_at: null, revoked_by: null,
  };
  w.db.T.workout_completions.push(row);
  return row;
}
const revoke = (w, row, ms) => Object.assign(row, { status: 'revoked', revoked_at: iso(ms), revoked_by: 'client' });
const explain = (w, extra = {}) => w.call({ type: 'coachPushExplain', coachToken: COACH_HASH, storageKey: CANARY, ...extra });

// ════════════════════════════════════════════════════════════════════════════
// TR. Training reminders
// ════════════════════════════════════════════════════════════════════════════
test('TR1 selected training day: primary sends once at the chosen time, generic copy, training deep link', async () => {
  const w = await dailyWorld({ prefs: TRAIN });
  await scheduler(w, at(MON, '17:00'), at(MON, '23:00'));
  const p = pushes(w, 'li-training'); eq(p.length, 1, 'one training push');
  eq(p[0].payload.title, 'Training today 💪', 'title'); eq(p[0].payload.body, 'Your session is ready when you are.', 'body');
  eq(p[0].payload.url, './?li=training', 'deep link to the training section');
  const e = ev(w, 'training_reminder'); eq(e.length, 1, 'one event');
  eq(e[0].dedupe_key, `training_primary:${w.canaryId}:${MON}`, 'deterministic key'); eq(e[0].period_key, MON, 'local date');
  eq(e[0].eligible_at, iso(at(MON, '18:00')), 'eligible_at = 18:00 local'); eq(e[0].status, 'sent', 'sent');
  eq(JSON.stringify(e[0].context), JSON.stringify({ stage: 'primary' }), 'context: stage only');
  assertNoLeak(w);
});

test('TR2 non-training day: nothing sent, nothing recorded', async () => {
  const w = await dailyWorld({ prefs: TRAIN });
  await scheduler(w, at(TUE, '00:00'), at(WED, '00:00'));
  eq(ev(w, 'training_reminder').length, 0, 'no rest-day rows'); eq(pushes(w).length, 0, 'silent');
});

test('TR3 duplicate primary blocked: re-runs, concurrent ticks and a restart in the window', async () => {
  const w = await dailyWorld({ prefs: TRAIN });
  await tickAt(w, at(MON, '18:00'));
  await tickAt(w, at(MON, '18:00'));                                        // same tick twice (duplicate cron)
  await Promise.all([tickAt(w, at(MON, '18:15')), tickAt(w, at(MON, '18:15'))]);   // two schedulers racing
  w.clock.now = at(MON, '18:45');
  const fresh = H.makePushHandler({ admin: w.db.admin, env: w.env, fetchImpl: w.svc.fetchImpl, now: () => w.clock.now });   // "restart": no memory
  await fresh(new Request('https://x/push', { method: 'POST', headers: { 'x-push-cron-secret': require('./push_harness').CRON_SECRET }, body: JSON.stringify({ type: 'pushTick' }) }));
  eq(pushes(w, 'li-training').length, 1, 'exactly one push'); eq(ev(w, 'training_reminder').length, 1, 'one row');
});

test('TR4 completed before the primary → primary suppressed already_completed (completion ref in context)', async () => {
  const w = await dailyWorld({ prefs: TRAIN_FU });
  const done = finishWorkout(w, at(MON, '07:10'));
  await scheduler(w, at(MON, '17:00'), at(MON, '23:00'));
  eq(pushes(w).length, 0, 'silent all day');
  const p = ev(w).find((e) => e.dedupe_key.startsWith('training_primary'));
  eq(p.suppression_reason, 'already_completed', 'primary reason'); eq(p.context.completionRef, done.completion_ref, 'which completion');
  const f = ev(w).find((e) => e.dedupe_key.startsWith('training_followup'));
  eq(f.suppression_reason, 'already_completed', 'follow-up also suppressed');
});

test('TR5 completed after the primary → follow-up suppressed', async () => {
  const w = await dailyWorld({ prefs: TRAIN_FU });
  await scheduler(w, at(MON, '17:00'), at(MON, '23:00'), (t) => { if (t === at(MON, '18:30')) finishWorkout(w, at(MON, '18:30')); });
  eq(pushes(w, 'li-training').length, 1, 'only the primary');
  eq(ev(w).find((e) => e.dedupe_key.startsWith('training_followup')).suppression_reason, 'already_completed', 'follow-up suppressed');
});

test('TR6 no completion → exactly one follow-up (at most 2 training pushes per day)', async () => {
  const w = await dailyWorld({ prefs: TRAIN_FU });
  await scheduler(w, at(MON, '00:00'), at(TUE, '00:00'));
  const p = pushes(w, 'li-training'); eq(p.length, 2, 'primary + follow-up');
  eq(p[1].payload.title, 'Still training today?', 'follow-up copy'); eq(p[1].payload.url, './?li=training', 'deep link');
  eq(ev(w, 'training_reminder').find((e) => e.dedupe_key.startsWith('training_followup')).eligible_at, iso(at(MON, '20:00')), 'follow-up at 20:00');
});

test('TR7 follow-up disabled (default) → primary only', async () => {
  const w = await dailyWorld({ prefs: TRAIN });
  await scheduler(w, at(MON, '00:00'), at(TUE, '00:00'));
  eq(pushes(w, 'li-training').length, 1, 'primary only'); eq(ev(w, 'training_reminder').length, 1, 'no follow-up row');
});

test('TR8 completion revoked before the follow-up → follow-up becomes eligible again; primary never resent', async () => {
  const w = await dailyWorld({ prefs: TRAIN_FU });
  let row;
  await scheduler(w, at(MON, '17:00'), at(MON, '23:00'), (t) => {
    if (t === at(MON, '18:30')) row = finishWorkout(w, at(MON, '18:30'));
    if (t === at(MON, '19:00')) revoke(w, row, t);
  });
  const p = pushes(w, 'li-training'); eq(p.length, 2, 'primary + follow-up');
  eq(ev(w, 'training_reminder').filter((e) => e.dedupe_key.startsWith('training_primary')).length, 1, 'primary once');
});

test('TR9 completion query fails → silence, nothing claimed; next tick in the window recovers', async () => {
  const w = await dailyWorld({ prefs: TRAIN });
  w.db.fail.on = 'workout_completions';
  const r = await tickAt(w, at(MON, '18:00'));
  assert(r.j.summary.stateErrors >= 1, 'state error counted'); eq(ev(w, 'training_reminder').length, 0, 'nothing claimed'); eq(pushes(w).length, 0, 'silent');
  w.db.fail.on = null;
  await tickAt(w, at(MON, '18:15'));
  eq(pushes(w, 'li-training').length, 1, 'recovered inside the window');
});

test('TR10 no Finish Workout on the served shell → unsupported_workout_completion, never sent; not offered in settings', async () => {
  const w = await dailyWorld({ prefs: TRAIN, facts: { has_workout_completion: false } });
  await scheduler(w, at(MON, '17:00'), at(MON, '20:00'));
  eq(pushes(w).length, 0, 'silent'); eq(ev(w, 'training_reminder')[0].suppression_reason, 'unsupported_workout_completion', 'reason');
  const g = await w.prefsGet(); eq(g.j.prefs.daily.trainingAvailable, false, 'not offered');
  const r = await w.prefsSet({ trainingEnabled: true }); eq(r.j.error, 'training_not_available', 'cannot be switched on');
});

test('TR11 no plan facts row at all → training unsupported (cannot be suppressed by anything)', async () => {
  const w = await dailyWorld({ prefs: TRAIN, facts: null });
  await tickAt(w, at(MON, '18:00'));
  eq(pushes(w).length, 0, 'silent'); eq(ev(w, 'training_reminder')[0].suppression_reason, 'unsupported_workout_completion', 'reason');
});

test('TR12 quiet hours → suppressed quiet_hours, never delivered later', async () => {
  const w = await dailyWorld({ prefs: { ...TRAIN, training_time: '22:30:00' } });
  await scheduler(w, at(MON, '22:00'), at(TUE, '08:00'));
  eq(pushes(w).length, 0, 'silent'); eq(ev(w, 'training_reminder')[0].suppression_reason, 'quiet_hours', 'reason');
});

test('TR13 no active device → suppressed no_active_device', async () => {
  const w = await dailyWorld({ prefs: TRAIN });
  await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: w.sub.json.endpoint });
  await tickAt(w, at(MON, '18:00'));
  eq(pushes(w).length, 0, 'silent'); eq(ev(w, 'training_reminder')[0].suppression_reason, 'no_active_device', 'reason');
});

test('TR14 master switch off → disabled; training off / incomplete settings → not evaluated at all', async () => {
  let w = await dailyWorld({ prefs: { ...TRAIN, notifications_enabled: false } });
  await tickAt(w, at(MON, '18:00'));
  eq(ev(w, 'training_reminder')[0].suppression_reason, 'disabled', 'master off recorded once');
  for (const prefs of [{ training_enabled: false, training_days: mask(1), training_time: '18:00:00' }, { training_enabled: false }]) {
    w = await dailyWorld({ prefs });
    await scheduler(w, at(MON, '00:00'), at(TUE, '00:00'));
    eq(ev(w, 'training_reminder').length, 0, 'off → no rows'); eq(pushes(w).length, 0, 'silent');
  }
});

test('TR15 follow-up only after a primary that reached a device (primary suppressed → primary_not_sent)', async () => {
  const w = await dailyWorld({ prefs: TRAIN_FU });
  await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: w.sub.json.endpoint });
  await tickAt(w, at(MON, '18:00'));                                   // primary: no device
  const s2 = w.newSub(); await w.subscribe(s2);                          // device back before 20:00
  await tickAt(w, at(MON, '20:00'));
  eq(pushes(w).length, 0, 'no follow-up after an undelivered primary');
  eq(ev(w).find((e) => e.dedupe_key.startsWith('training_followup')).suppression_reason, 'primary_not_sent', 'reason');
});

test('TR16 completion judged in the notification timezone, not by device local_date', async () => {
  // Completed 23:30 Sunday Sydney → device stamped local_date Monday (travelling, UTC+11 vs its own clock)
  const w = await dailyWorld({ prefs: TRAIN });
  finishWorkout(w, at('2026-10-11', '23:30'), { localDate: MON });
  await tickAt(w, at(MON, '18:00'));
  eq(pushes(w, 'li-training').length, 1, 'Sunday-night completion does not cover Monday');
  // …and an after-midnight Monday completion does.
  const w2 = await dailyWorld({ prefs: TRAIN });
  finishWorkout(w2, at(MON, '00:20'), { localDate: '2026-10-11' });
  await tickAt(w2, at(MON, '18:00'));
  eq(pushes(w2).length, 0, 'counted for Monday');
});

test('TR17 timezone boundary: UTC client gets its own wall clock; window never crosses midnight', async () => {
  const w = await dailyWorld({ tz: 'UTC', prefs: { ...TRAIN, training_time: '23:45:00', quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await scheduler(w, Date.UTC(2026, 9, 12, 22, 0), Date.UTC(2026, 9, 13, 3, 0));
  eq(pushes(w).length, 1, 'one push'); eq(ev(w, 'training_reminder')[0].eligible_at, '2026-10-12T23:45:00.000Z', 'UTC wall clock');
  const w2 = await dailyWorld({ tz: 'UTC', prefs: { ...TRAIN, training_time: '23:45:00', quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await tickAt(w2, Date.UTC(2026, 9, 13, 0, 0));                     // 00:00 Tuesday: Monday's window is closed
  eq(ev(w2).length, 0, 'not carried into the next day');
});

test('TR18 spring-forward (Sydney 2026-10-04, 02:00→03:00): a 02:30 reminder fires once at 03:00, others at their wall time', async () => {
  const SUN = '2026-10-04';
  const w = await dailyWorld({ now: at(SUN, '00:00'), prefs: { training_enabled: true, training_days: mask(0), training_time: '02:30:00', quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await scheduler(w, Date.UTC(2026, 9, 3, 13, 0), Date.UTC(2026, 9, 4, 13, 0));
  eq(pushes(w, 'li-training').length, 1, 'once');
  eq(SCH.localParts(Date.parse(ev(w, 'training_reminder')[0].created_at), TZ).minuteOfDay, 180, 'sent when the clock jumped to 03:00');
  const w2 = await dailyWorld({ now: at(SUN, '00:00'), prefs: { training_enabled: true, training_days: mask(0), training_time: '18:00:00' } });
  await scheduler(w2, Date.UTC(2026, 9, 3, 13, 0), Date.UTC(2026, 9, 4, 13, 0));
  eq(ev(w2, 'training_reminder')[0].eligible_at, iso(at(SUN, '18:00')), '18:00 AEDT on the 23 h day'); eq(pushes(w2, 'li-training').length, 1, 'once');
});

test('TR19 fall-back (Sydney 2027-04-04, 03:00→02:00): repeated 02:30 → one push, one row', async () => {
  const SUN = '2027-04-04';
  const w = await dailyWorld({ now: at(SUN, '00:00'), prefs: { training_enabled: true, training_days: mask(0), training_time: '02:30:00', quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await scheduler(w, Date.UTC(2027, 3, 3, 12, 0), Date.UTC(2027, 3, 4, 14, 0));
  eq(pushes(w, 'li-training').length, 1, 'once across both 02:30s'); eq(ev(w, 'training_reminder').length, 1, 'one row');
});

test('TR20 reminder time changed after the primary → no second primary that day; new time applies tomorrow', async () => {
  const w = await dailyWorld({ prefs: { ...TRAIN, training_days: mask(1, 2) } });
  await tickAt(w, at(MON, '18:00'));
  const r = await w.prefsSet({ trainingTime: '20:00' }); assert(r.j.ok, 'time change saved');
  await scheduler(w, at(MON, '18:15'), at(TUE, '00:00'));
  eq(pushes(w).length, 1, 'still one on Monday');
  await scheduler(w, at(TUE, '17:00'), at(TUE, '21:00'));
  eq(pushes(w).length, 2, 'Tuesday at the new time'); eq(ev(w).at(-1).eligible_at, iso(at(TUE, '20:00')), '20:00');
});

test('TR21 copy never names a session or claims a miss', async () => {
  for (const k of ['training_primary', 'training_followup']) {
    const t = H.TEMPLATES[k]; const text = t.title + ' ' + t.body;
    assert(!/\b(push|pull|legs|upper|lower|day \d|missed|forgot|skipp|behind|didn)/i.test(text), `${k}: generic, non-accusatory`);
    eq(t.kind, 'training_reminder', 'kind'); eq(t.tag, 'li-training', 'follow-up replaces an unread primary');
  }
});

test('TR22 property: a completion at any instant of the day silences every later stage; never > 2 per day', async () => {
  for (const hhmm of ['00:05', '17:59', '18:10', '19:59', '20:10', '23:50']) {
    const w = await dailyWorld({ prefs: TRAIN_FU });
    const c = at(MON, hhmm);
    await scheduler(w, at(MON, '00:00'), at(TUE, '00:00'), (t) => { if (t >= c && !w.db.T.workout_completions.length) finishWorkout(w, c); });
    const sent = ev(w, 'training_reminder').filter((e) => e.status === 'sent');
    assert(sent.length <= 2, 'max 2');
    for (const e of sent) assert(Date.parse(e.created_at) < c, `${hhmm}: nothing sent after the completion`);
  }
});

test('TR23 evaluator defence in depth: a stored follow-up < 60 min after the primary is dropped, never sent', async () => {
  const p = { training_enabled: true, training_days: mask(MON_DOW), training_time: '18:00', training_followup_enabled: true };
  eq(SCH.trainingSchedule({ ...p, training_followup_time: '18:45' }).followup, null, '45 min → dropped');
  eq(SCH.trainingSchedule({ ...p, training_followup_time: '17:00' }).followup, null, 'earlier → dropped');
  eq(SCH.trainingSchedule({ ...p, training_followup_time: '19:00' }).followup, 19 * 60, '60 min → kept');
  const full = { ...p, training_followup_time: '18:30', notifications_enabled: true, timezone: TZ, quiet_start: '22:00', quiet_end: '06:00' };
  for (let m = 18 * 60; m < 20 * 60; m += 5) {
    const e = SCH.evaluateTrainingStage(full, at(MON, SCH.formatTime(m)), FACTS_4);
    assert(!e.due || e.stage === 'primary', 'no follow-up stage ever opens');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ME. Meal reminders
// ════════════════════════════════════════════════════════════════════════════
test('ME1 4-feed plan: Meal 1..4 each send once at the client\'s times, ordinal copy, nutrition deep link', async () => {
  const w = await dailyWorld({ prefs: MEALS4 });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  const p = pushes(w, 'li-meal'); eq(p.length, 4, 'four pushes');
  eq(p.map((x) => x.payload.title).join('|'), 'Meal 1 time 🍽️|Meal 2 time 🍽️|Meal 3 time 🍽️|Meal 4 time 🍽️', 'ordinal titles');
  for (const x of p) { eq(x.payload.body, 'Your next planned meal is ready in LOCKED IN.', 'neutral body'); eq(x.payload.url, './?li=nutrition', 'deep link'); }
  const e = ev(w, 'meal_reminder');
  eq(e.map((x) => x.dedupe_key).join(','), [1, 2, 3, 4].map((k) => `meal:${w.canaryId}:${MON}:${k}`).join(','), 'keys');
  eq(e.map((x) => x.eligible_at).join(','), ['08:00', '12:30', '17:00', '20:30'].map((t) => iso(at(MON, t))).join(','), 'at the configured times');
  eq(JSON.stringify(e[1].context), JSON.stringify({ slot: 2 }), 'context: slot only');
  assertNoLeak(w);
});

test('ME2 3-feed plan: three slots, and only three can be configured', async () => {
  const w = await dailyWorld({ facts: { meal_slot_count: 3 }, prefs: { meals_enabled: true, meal_times: ['08:00:00', '13:00:00', '19:00:00'] } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(pushes(w, 'li-meal').length, 3, 'three');
  const r = await w.prefsSet({ mealTimes: ['08:00', '12:00', '16:00', '20:00'] }); eq(r.j.error, 'bad_mealTimes', 'a 4th slot is refused');
});

test('ME3 4 → 3 served-plan change: the stale Meal 4 stops (no_current_meal_slot), Meals 1-3 continue', async () => {
  const w = await dailyWorld({ prefs: MEALS4 });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(pushes(w, 'li-meal').length, 4, 'Monday: 4');
  // The coach ships a 3-feed plan; the deploy-time sync records it (real op, deploy secret).
  const s = await w.call({ type: 'planFactsSync', storageKey: CANARY, commit: 'abcdef1', facts: { ...FACTS_4, meal_slot_count: 3, served_sha256: sha256hex('shell-3') } }, 'POST', { 'x-push-deploy-secret': DEPLOY_SECRET });
  assert(s.j.ok && s.j.changed, 'facts synced'); eq(s.j.previous.mealSlotCount, 4, 'was 4');
  await scheduler(w, at(TUE, '06:00'), at(WED, '00:00'));
  eq(pushes(w, 'li-meal').length, 7, 'Tuesday: only 3 more');
  const m4 = ev(w).find((e) => e.dedupe_key === `meal:${w.canaryId}:${TUE}:4`);
  eq(m4.status, 'suppressed', 'Meal 4 recorded'); eq(m4.suppression_reason, 'no_current_meal_slot', 'reason');
  eq(w.db.T.push_preferences[0].meal_times.length, 4, 'client settings untouched by the sync');
  const g = await w.prefsGet(); eq(g.j.prefs.daily.mealSlotCount, 3, 'settings now show 3 slots');
});

test('ME4 variable / unreadable plan → meal reminders unavailable: nothing evaluated, not offered', async () => {
  for (const st of ['variable', 'unreadable', 'unsupported']) {
    const w = await dailyWorld({ facts: { meal_facts_status: st, meal_slot_count: null }, prefs: MEALS4 });
    await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
    eq(ev(w, 'meal_reminder').length, 0, `${st}: no rows`); eq(pushes(w).length, 0, `${st}: silent`);
    const g = await w.prefsGet(); eq(g.j.prefs.daily.mealsAvailable, false, `${st}: not offered`); eq(g.j.prefs.daily.mealSlotCount, null, 'no count');
    eq((await w.prefsSet({ mealsEnabled: true })).j.error, 'meals_not_available', `${st}: cannot enable`);
  }
});

test('ME5 disabled meals / blank times → nothing; blank slot skipped, others fire', async () => {
  let w = await dailyWorld({ prefs: { ...MEALS4, meals_enabled: false } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w, 'meal_reminder').length, 0, 'off → nothing');
  w = await dailyWorld({ prefs: { meals_enabled: true, meal_times: ['08:00:00', null, '17:00:00'] } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(pushes(w, 'li-meal').map((p) => p.payload.title).join('|'), 'Meal 1 time 🍽️|Meal 3 time 🍽️', 'blank Meal 2 skipped');
  w = await dailyWorld({ prefs: { ...MEALS4, notifications_enabled: false } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  assert(ev(w, 'meal_reminder').every((e) => e.suppression_reason === 'disabled'), 'master off → disabled'); eq(pushes(w).length, 0, 'silent');
});

test('ME6 quiet hours: a meal time inside quiet hours is suppressed quiet_hours (never deferred)', async () => {
  const w = await dailyWorld({ prefs: { meals_enabled: true, meal_times: ['08:00:00', '22:30:00'] } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '07:45'));      // through the end of quiet hours (06:00), before Tuesday's Meal 1
  eq(pushes(w, 'li-meal').length, 1, 'only Meal 1'); eq(ev(w).find((e) => e.dedupe_key.endsWith(`${MON}:2`)).suppression_reason, 'quiet_hours', 'Meal 2 silenced');
  eq(ev(w, 'meal_reminder').length, 2, 'Meal 2 never re-attempted after quiet hours end');
});

test('ME7 duplicate cron / racing schedulers → each slot once', async () => {
  const w = await dailyWorld({ prefs: MEALS4 });
  for (const t of [at(MON, '12:30'), at(MON, '12:30'), at(MON, '12:45')]) await tickAt(w, t);
  await Promise.all([tickAt(w, at(MON, '13:00')), tickAt(w, at(MON, '13:00'))]);
  eq(pushes(w, 'li-meal').length, 1, 'Meal 2 once');
});

test('ME8 no meal-completion inference: meal logs are never read and never change the outcome', async () => {
  const src = rd('supabase/functions/push/handler.ts');
  assert(!src.includes('meal_logs'), 'handler never names meal_logs');
  const w = await dailyWorld({ prefs: MEALS4 });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  assert(!w.db.calls.some((c) => /meal_log/.test(c.t)), 'no meal-log table touched');
  for (const k of ['meal_slot']) assert(!/\b(miss|skip|forg|haven|didn|eat)/i.test(H.TEMPLATES[k].title + H.TEMPLATES[k].body), 'neutral timing language');
  eq(H.mealTemplate(2).body, H.TEMPLATES.meal_slot.body, 'every slot shares the neutral body');
});

test('ME9 timezone / DST: meals follow the client wall clock across the Sydney DST start', async () => {
  const SUN = '2026-10-04';
  const w = await dailyWorld({ now: at(SUN, '00:00'), prefs: { meals_enabled: true, meal_times: ['08:00:00', '19:00:00'] } });
  await scheduler(w, Date.UTC(2026, 9, 3, 13, 0), Date.UTC(2026, 9, 4, 13, 0));
  eq(ev(w, 'meal_reminder').map((e) => e.eligible_at).join(','), [iso(at(SUN, '08:00')), iso(at(SUN, '19:00'))].join(','), 'AEDT wall times');
  eq(pushes(w, 'li-meal').length, 2, 'two');
});

test('ME10 slot order: times must increase; at most one meal slot is open per tick', async () => {
  const w = await dailyWorld({ prefs: { meals_enabled: true, meal_times: ['08:00:00'] } });
  eq((await w.prefsSet({ mealTimes: ['12:00', '08:00'] })).j.error, 'meal_times_order', 'decreasing refused');
  eq(SCH.mealSlotTimes({ meals_enabled: true, meal_times: ['12:00', '08:00', '18:00'] }).map((s) => s.slot).join(','), '1,3', 'a stored out-of-order slot is dropped, never reordered');
  const p = { ...MEALS4, notifications_enabled: true, timezone: TZ, quiet_start: '00:00', quiet_end: '00:00', meal_times: ['08:00', '08:15', '08:30', '08:45'] };
  for (let m = 0; m < 24 * 60; m += 5) assert(SCH.evaluateMealSlots(p, at(MON, SCH.formatTime(m)), FACTS_4).length <= 1, 'one slot at a time');
});

// ════════════════════════════════════════════════════════════════════════════
// CP. Safety cap
// ════════════════════════════════════════════════════════════════════════════
test('CP1 daily cap: the 11th automatic push of a local day is suppressed daily_cap (observable)', async () => {
  const w = await dailyWorld({ facts: { meal_slot_count: 8 }, prefs: { ...TRAIN_FU, meals_enabled: true,
    meal_times: ['07:00:00', '09:00:00', '11:00:00', '13:00:00', '15:00:00', '17:00:00', '19:00:00', '21:00:00'] } });
  // Pre-existing in-flight daily event for Monday (e.g. a coach-side test of the rollout) brings the day to the cap.
  w.db.T.notification_events.push({ id: w.db.uuid(), client_id: w.canaryId, storage_key: CANARY, kind: 'meal_reminder', dedupe_key: 'meal:x:pre', status: 'sent', title: 't', body: 'b', url: './', created_by: 'system', period_key: MON });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  const daily = ev(w).filter((e) => e.period_key === MON && ['sent', 'partial', 'claimed'].includes(e.status));
  eq(daily.length, 10, 'never more than 10 automatic pushes in the day');
  const capped = ev(w).filter((e) => e.suppression_reason === 'daily_cap');
  eq(capped.length, 1, 'the extra one is recorded daily_cap');
  eq(SCH.DAILY_CAP, 10, 'cap'); eq(SCH.MAX_MEAL_SLOTS + 2, 10, 'by construction: 8 meals + 2 training');
});

test('CP2 weekly check-in is independent of the daily cap and unchanged', async () => {
  const SUN = '2026-10-11';
  const w = await dailyWorld({ now: at(SUN, '06:00'), checkinSeq: [CANARY], facts: { meal_slot_count: 8 },
    prefs: { meals_enabled: true, meal_times: ['07:00:00', '08:00:00', '08:30:00', '09:30:00', '11:00:00', '13:00:00', '15:00:00', '17:00:00'],
             training_enabled: true, training_days: mask(0), training_time: '07:15:00', training_followup_enabled: true, training_followup_time: '19:00:00' } });
  await scheduler(w, at(SUN, '06:00'), at(SUN, '20:00'));
  const ci = pushes(w, 'li-checkin'); eq(ci.length, 2, 'check-in due 09:00 + follow-up 18:00 still sent');
  eq(ci[0].payload.body, 'Your weekly check-in is ready. Take a minute to get it done.', 'check-in copy unchanged');
  eq(ci[0].payload.url, './', 'check-in url unchanged');
});

// ════════════════════════════════════════════════════════════════════════════
// RO. Rollout gate, settings, ownership
// ════════════════════════════════════════════════════════════════════════════
test('RO1 PUSH_DAILY_V1_CLIENTS unset → nothing evaluated, settings hidden, fields refused', async () => {
  const w = await dailyWorld({ daily: false, prefs: { ...TRAIN_FU, ...MEALS4 } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w, 'training_reminder').length + ev(w, 'meal_reminder').length, 0, 'nothing'); eq(pushes(w).length, 0, 'silent');
  const g = await w.prefsGet(); eq(g.j.prefs.daily.available, false, 'hidden');
  eq((await w.prefsSet({ trainingTime: '18:00' })).j.error, 'daily_not_available', 'refused');
  eq(H.readPushEnv(() => undefined).dailyReminders.all, false, 'unset env = nobody');
  eq(H.readPushEnv(() => undefined).dailyReminders.keys.size, 0, 'unset env = nobody');
});

test('RO2 rollout list is exact: a listed key gets reminders, an unlisted eligible client does not', async () => {
  const w = await dailyWorld({ dailyKeys: ['_push_canary2'], prefs: TRAIN });
  await tickAt(w, at(MON, '18:00'));
  eq(ev(w, 'training_reminder').length, 0, 'canary not listed → nothing');
});

test('RO3 defaults: everything OFF and blank; nothing is pre-filled', async () => {
  const w = await dailyWorld();
  const p = (await w.prefsGet()).j.prefs;
  eq(p.trainingEnabled, false, 'training off'); eq(p.trainingDays.length, 0, 'no days'); eq(p.trainingTime, null, 'no time');
  eq(p.trainingFollowupEnabled, false, 'follow-up off'); eq(p.trainingFollowupTime, null, 'no follow-up time');
  eq(p.mealsEnabled, false, 'meals off'); eq(p.mealTimes.length, 0, 'no meal times');
  eq(p.daily.mealSlotCount, 4, 'slot count from served facts'); eq(p.daily.trainingAvailable, true, 'training offered');
  assert(/meal_times time\[\] not null default '\{\}'/.test(MIGRATION_DAILY), 'meal_times default empty');
  assert(/training_time time;/.test(MIGRATION_DAILY) && /training_followup_time time;/.test(MIGRATION_DAILY), 'times nullable, no default');
});

test('RO4 settings validation: days+time required, follow-up >= 60 min same day, 15-min steps, cascade off', async () => {
  const w = await dailyWorld();
  eq((await w.prefsSet({ trainingEnabled: true })).j.error, 'training_needs_days_and_time', 'needs days+time');
  assert((await w.prefsSet({ trainingDays: [1, 3] })).j.ok, 'days'); assert((await w.prefsSet({ trainingTime: '18:00' })).j.ok, 'time');
  assert((await w.prefsSet({ trainingEnabled: true })).j.ok, 'on');
  eq((await w.prefsSet({ trainingFollowupEnabled: true })).j.error, 'followup_needs_time', 'needs a follow-up time');
  eq((await w.prefsSet({ trainingFollowupTime: '18:45' })).j.ok, true, 'time stored');
  eq((await w.prefsSet({ trainingFollowupEnabled: true })).j.error, 'followup_too_close', '< 60 min refused');
  assert((await w.prefsSet({ trainingFollowupTime: '19:00' })).j.ok, '60 min ok');
  assert((await w.prefsSet({ trainingFollowupEnabled: true })).j.ok, 'follow-up on');
  eq((await w.prefsSet({ trainingTime: '18:30' })).j.error, 'followup_too_close', 'moving the primary too close is refused');
  eq((await w.prefsSet({ trainingFollowupTime: '17:00' })).j.error, 'followup_too_close', 'earlier than primary refused (same day)');
  eq((await w.prefsSet({ trainingTime: '18:10' })).j.error, 'bad_trainingTime', '15-min steps');
  eq((await w.prefsSet({ trainingDays: [7] })).j.error, 'bad_trainingDays', 'weekday range');
  eq((await w.prefsSet({ trainingDays: [] })).j.error, 'training_needs_days_and_time', 'cannot drop the last day while on');
  const off = await w.prefsSet({ trainingEnabled: false });
  eq(off.j.prefs.trainingFollowupEnabled, false, 'follow-up switched off with training');
  eq(off.j.prefs.trainingTime, '18:00', 'the client\'s time is kept');
  eq((await w.prefsSet({ mealsEnabled: true })).j.error, 'meals_need_a_time', 'meals need a time');
  assert((await w.prefsSet({ mealTimes: ['08:00', null, '17:00'] })).j.ok, 'partial meal times');
  assert((await w.prefsSet({ mealsEnabled: true })).j.ok, 'meals on');
  eq((await w.prefsSet({ mealTimes: [null, null] })).j.error, 'meals_need_a_time', 'cannot blank every time while on');
  eq((await w.prefsSet({ mealTimes: ['08:07'] })).j.error, 'bad_mealTimes', '15-min steps');
});

test('RO5 clients cannot write served facts; planFactsSync needs the deploy secret and validates', async () => {
  const w = await dailyWorld();
  eq((await w.prefsSet({ mealSlotCount: 6 })).j.error, 'unknown_field', 'facts are not client fields');
  eq((await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: FACTS_4 })).status, 401, 'no secret');
  eq((await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: FACTS_4 }, 'POST', { 'x-push-deploy-secret': 'x'.repeat(40) })).status, 401, 'wrong secret');
  const S = { 'x-push-deploy-secret': DEPLOY_SECRET };
  eq((await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: { ...FACTS_4, meal_slot_count: 9 } }, 'POST', S)).j.error, 'bad_meal_slot_count', '> 8');
  eq((await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: { ...FACTS_4, meal_facts_status: 'variable' } }, 'POST', S)).j.error, 'bad_meal_slot_count', 'variable must carry null');
  eq((await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: { ...FACTS_4, served_sha256: 'nope' } }, 'POST', S)).j.error, 'bad_served_sha256', 'hash');
  eq((await w.call({ type: 'planFactsSync', storageKey: 'nobody_here', facts: FACTS_4 }, 'POST', S)).status, 404, 'unknown client');
  const ok = await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: { ...FACTS_4, meal_facts_status: 'variable', meal_slot_count: null } }, 'POST', S);
  assert(ok.j.ok, 'variable stored'); eq(w.db.T.push_plan_facts[0].meal_slot_count, null, 'null count');
  eq(ev(w).length, 0, 'a sync never sends'); assertNoLeak(w);
});

test('RO6 schema: additive; new table locked down; constraints mirror the rules; check-in columns untouched', async () => {
  const live = MIGRATION_DAILY.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/\bdrop\s+(table|column)\b/i.test(live), 'no drops outside DOWN');
  assert(!/\b(update|delete|insert)\s+(into\s+)?public\./i.test(live), 'no data writes');
  assert(/alter table public\.push_plan_facts enable row level security/.test(live) && /revoke all on public\.push_plan_facts from anon, authenticated/.test(live), 'RLS + revoke');
  assert(!/create policy/i.test(live), 'default deny');
  assert(!/checkin_/i.test(live.replace(/'checkin_reminder'/g, '')), 'check-in columns untouched');
  for (const k of ['test', 'weighin_reminder', 'checkin_reminder', 'program_update', 'training_reminder', 'meal_reminder']) assert(KINDS.includes(k), 'kind ' + k);
  for (const r of ['already_completed', 'quiet_hours', 'no_active_device', 'disabled', 'duplicate', 'unsupported_workout_completion', 'primary_not_sent', 'no_current_meal_slot', 'daily_cap']) assert(REASONS.includes(r), 'reason ' + r);
});

// ════════════════════════════════════════════════════════════════════════════
// OB. Observability (coachPushExplain)
// ════════════════════════════════════════════════════════════════════════════
test('OB1 explain answers "why no training push today?" for each case, read-only', async () => {
  const w = await dailyWorld({ prefs: { ...TRAIN_FU, ...MEALS4 } });
  // rest day
  w.clock.now = at(TUE, '19:00');
  let r = await explain(w); eq(r.j.training.status, 'not_training_day', 'rest day'); eq(r.j.date, TUE, 'client-local date');
  // completed
  finishWorkout(w, at(MON, '07:00'));
  await scheduler(w, at(MON, '17:00'), at(MON, '21:00'));
  r = await explain(w, { date: MON });
  eq(r.j.training.status, 'scheduled', 'training day'); eq(r.j.training.completedToday, true, 'completion seen');
  eq(r.j.training.stages.map((s) => s.outcome).join(','), 'already_completed,already_completed', 'both suppressed by completion');
  eq(r.j.meals.slots.map((s) => s.outcome).join(','), 'not_evaluated,not_evaluated,sent,sent', 'meals: morning windows passed without a tick in this test');
  const before = JSON.stringify(w.db.T);
  await explain(w, { date: MON }); eq(JSON.stringify(w.db.T), before, 'explain writes nothing');
  assertNoLeak(w); assert(!JSON.stringify(r.j).includes(w.sub.json.endpoint), 'no endpoint');
});

test('OB2 explain statuses: disabled, no day/time, unsupported, no plan facts, variable, quiet, no device', async () => {
  let w = await dailyWorld({ prefs: { training_enabled: false } });
  eq((await explain(w)).j.training.status, 'disabled', 'disabled');
  w = await dailyWorld({ facts: { has_workout_completion: false, meal_facts_status: 'variable', meal_slot_count: null }, prefs: TRAIN });
  let r = await explain(w, { date: MON }); eq(r.j.training.status, 'unsupported_workout_completion', 'unsupported'); eq(r.j.meals.status, 'variable_feed_count', 'variable');
  w = await dailyWorld({ facts: null, prefs: { ...TRAIN, training_time: '22:30:00' } });
  r = await explain(w, { date: MON }); eq(r.j.meals.status, 'no_plan_facts', 'no facts');
  await tickAt(w, at(MON, '22:30')); r = await explain(w, { date: MON });
  eq(r.j.training.stages[0].outcome, 'unsupported_workout_completion', 'recorded outcome');
  w = await dailyWorld({ prefs: { ...TRAIN, training_time: '22:30:00' } });
  await tickAt(w, at(MON, '22:30')); eq((await explain(w, { date: MON })).j.training.stages[0].outcome, 'quiet_hours', 'quiet');
  w = await dailyWorld({ prefs: TRAIN });
  await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: w.sub.json.endpoint });
  await tickAt(w, at(MON, '18:00')); r = await explain(w, { date: MON });
  eq(r.j.training.stages[0].outcome, 'no_active_device', 'no device'); eq(r.j.activeDevices, 0, 'device count');
  w = await dailyWorld({ prefs: { meals_enabled: false } });
  eq((await explain(w)).j.meals.status, 'disabled', 'meals disabled');
});

test('OB3 explain requires the coach token; clients and strangers are refused', async () => {
  const w = await dailyWorld();
  eq((await w.call({ type: 'coachPushExplain', storageKey: CANARY })).status, 401, 'no token');
  eq((await w.call({ type: 'coachPushExplain', storageKey: CANARY, coachToken: CANARY_TOKEN })).status, 401, 'client token');
  eq((await w.call({ type: 'coachPushExplain', storageKey: CANARY, token: CANARY_TOKEN })).status, 401, 'client creds');
});

test('OB4 tick summary exposes duplicate_prevented and per-stage counters', async () => {
  const w = await dailyWorld({ prefs: { ...TRAIN, ...MEALS4 } });
  let r = await tickAt(w, at(MON, '18:00')); eq(r.j.summary.training.primary, 1, 'primary counted');
  r = await tickAt(w, at(MON, '18:00')); eq(r.j.summary.duplicates, 1, 'duplicate prevented counted');
  r = await tickAt(w, at(MON, '20:30')); eq(r.j.summary.meals, 1, 'meal counted');
});

// ════════════════════════════════════════════════════════════════════════════
// PF. Plan facts (real parser on the real fleet) + sync script
// ════════════════════════════════════════════════════════════════════════════
const pf = () => import(path.join(process.cwd(), 'scripts/push/plan_facts.mjs'));

test('PF1 parser: consistent N, variable → null, unreadable → null, Finish Workout detected; never executes shell code', async () => {
  const { planFactsFromShell } = await pf();
  const shell = (weeks, extra = '') => `<script>const mealPlan = {};\nfunction mkday(meals){return{meals};}\nfunction mkm(time,name,desc,cal,p,c,f){return{time,name,desc,cal,p,c,f};}\n` +
    weeks.map((w, i) => `mealPlan[${i + 1}] = [${w.map((n) => `mkday([${Array.from({ length: n }, (_, k) => `mkm('8:00am','M${k}','d, with (commas) & \\'quotes\\'',${400 + k},30,40,10)`).concat(`mkm('','MEAL PREP','prep',0,0,0,0)`).join(',')}])`).join(',')}];`).join('\n') + `\n${extra}</script>`;
  const seven = (n) => Array(7).fill(n);
  let f = planFactsFromShell(Buffer.from(shell([seven(4), seven(4)])));
  eq(f.meal_facts_status, 'consistent', 'consistent'); eq(f.meal_slot_count, 4, 'prep notes are not feeds');
  eq(f.served_sha256, sha256hex(Buffer.from(shell([seven(4), seven(4)]))), 'hash of the exact bytes');
  f = planFactsFromShell(Buffer.from(shell([seven(4), [4, 4, 4, 4, 5, 4, 4]]))); eq(f.meal_facts_status, 'variable', 'variable'); eq(f.meal_slot_count, null, 'null');
  f = planFactsFromShell(Buffer.from(shell([seven(9)]))); eq(f.meal_facts_status, 'unsupported', '> 8'); eq(f.meal_slot_count, null, 'null');
  f = planFactsFromShell(Buffer.from(shell([seven(4)]).replace("mkm('8:00am'", "mkm(globalThis.pwned='x'")));
  eq(f.meal_facts_status, 'unreadable', 'an expression is refused, not run'); assert(!globalThis.pwned, 'nothing executed');
  f = planFactsFromShell(Buffer.from('<html>no plan</html>')); eq(f.meal_facts_status, 'unreadable', 'no plan'); eq(f.has_workout_completion, false, 'no hooks');
});

test('PF2 real fleet: parser agrees with the shells; zain_hussein variable; legacy shells lack Finish Workout', async () => {
  const { planFactsFromShell } = await pf();
  const dir = path.join(process.cwd(), 'clients');
  const out = {};
  for (const k of fs.readdirSync(dir)) {
    const f = path.join(dir, k, 'index.html');
    if (fs.existsSync(f)) out[k] = planFactsFromShell(fs.readFileSync(f));
  }
  if (out.zain_hussein) eq(out.zain_hussein.meal_facts_status, 'variable', 'zain variable 4/5');
  if (out.zac) { eq(out.zac.meal_slot_count, 4, 'zac 4 feeds'); eq(out.zac.has_workout_completion, true, 'zac has Finish Workout'); }
  if (out._workout_canary) { eq(out._workout_canary.meal_slot_count, 4, 'canary 4 feeds'); eq(out._workout_canary.has_workout_completion, true, 'canary Finish Workout'); }
  for (const k of ['ali', 'amir', 'hamza', 'sarah']) if (out[k]) eq(out[k].has_workout_completion, false, `${k}: legacy, no Finish Workout`);
  for (const f of Object.values(out)) assert(!/[a-z]{3,}/i.test(JSON.stringify({ ...f, meal_facts_status: '', served_sha256: '', meal_plan_sig: '' }).replace(/meal_facts_status|meal_slot_count|served_sha256|meal_plan_sig|has_workout_completion|true|false|null/g, '')), 'facts carry no food text');
});

test('PF3 sync script: only verified-live shells are synced; served bytes never matching → not synced; inert without secret', async () => {
  const { main } = await import(path.join(process.cwd(), 'scripts/push/sync_plan_facts.mjs'));
  const live = Buffer.from('<script>const mealPlan = {};\nmealPlan[1] = [' + Array(7).fill("mkday([mkm('8am','A','x',500,1,1,1)])").join(',') + '];</script>');
  const stale = Buffer.from('old bytes');
  const git = { shellKeys: () => ['zac', 'other_one', '_workout_canary'], show: (sha, p) => (p.includes('zac') || p.includes('canary') ? live : stale) };
  const served = { zac: live, other_one: Buffer.from('different'), _workout_canary: live };
  const posts = [];
  const env = { PUSH_DEPLOY_SECRET: 'x', SUPABASE_PROJECT_REF: 'ref', SHA: 'a'.repeat(40) };
  const rep = await main({ git, env, fetchServed: async (k) => served[k], sleep: async () => {}, attempts: 2, delayMs: 0, log: () => {},
    post: async (e, b) => { posts.push(b); return { status: 200, j: { ok: true, changed: true } }; } });
  eq(posts.map((p) => p.storageKey).join(','), '_workout_canary,zac', 'only live shells');
  eq(posts[0].facts.meal_slot_count, 1, 'facts from the served bytes'); eq(posts[0].type, 'planFactsSync', 'op');
  eq(rep.skipped[0].reason, 'not_live', 'stale shell skipped');
  const inert = await main({ git, env: {}, fetchServed: async () => live, sleep: async () => {}, post: async () => { throw new Error('must not post'); }, log: () => {} });
  eq(inert.synced.length, 0, 'inert');
  const refused = await main({ git, env: { ...env, DISPATCH: '1', CONFIRM: 'nope' }, fetchServed: async () => live, sleep: async () => {}, post: async () => { throw new Error('must not post'); }, log: () => {} });
  eq(refused.synced.length, 0, 'manual run needs SYNC');
});

test('PF4 workflow wiring: plan-facts workflow is separate; notifier workflow untouched; deploy runs this suite', async () => {
  const wf = rd('.github/workflows/push-plan-facts.yml');
  assert(/node scripts\/push\/sync_plan_facts\.mjs/.test(wf) && /clients\/\*\/index\.html/.test(wf), 'runs on shell pushes');
  assert(!/programUpdated|notify_program_update\.mjs/.test(wf.replace(/#.*$/gm, '')), 'does not notify');
  assert(/node tests\/push_daily\.test\.js/.test(rd('.github/workflows/deploy-edge-push.yml')), 'deploy runs push_daily');
});

// ════════════════════════════════════════════════════════════════════════════
// DL. Deep links (service worker routing — the browser half is in scripts/push/deeplink_e2e.js)
// ════════════════════════════════════════════════════════════════════════════
test('DL1 sw.js: closed app opens the deep link; open app is focused + told the section; invalid → scope home', async () => {
  const vm = require('vm');
  const src = rd('sw.js');
  const listeners = {};
  const opened = [], messages = [], focused = [];
  const mkClient = (url) => ({ url, focus: async function () { focused.push(url); return this; }, postMessage: (m) => messages.push({ url, m }) });
  let windows = [];
  const self = {
    location: { href: 'https://omarsoubra.github.io/DASHBOARD/sw.js' },
    registration: { scope: 'https://omarsoubra.github.io/DASHBOARD/clients/zac/', showNotification: async () => {} },
    clients: { matchAll: async () => windows, openWindow: async (u) => { opened.push(u); }, claim: async () => {} },
    addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {},
  };
  vm.runInNewContext(src, { self, caches: { open: async () => ({}), keys: async () => [] }, URL, fetch: async () => {}, Promise });
  const click = async (url) => {
    let p; listeners.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (x) => { p = x; } }); await p;
  };
  const scope = self.registration.scope;
  windows = [];
  await click(scope + '?li=training');
  eq(opened.at(-1), scope + '?li=training', 'closed app → open the deep link');
  windows = [mkClient(scope)];
  await click(scope + '?li=nutrition');
  eq(focused.length, 1, 'open app focused'); eq(JSON.stringify(messages.at(-1).m), JSON.stringify({ type: 'li-open', section: 'nutrition' }), 'section message');
  windows = [mkClient(scope)];
  await click(scope + '?li=../../evil');
  eq(messages.length, 1, 'invalid li → no section message'); eq(focused.length, 2, 'still just focuses the app');
  windows = [];
  await click('https://evil.example/x?li=training');
  eq(opened.at(-1), scope, 'other origin → scope home');
  await click(scope.replace('/zac/', '/someone_else/') + '?li=training');
  eq(opened.at(-1), scope, 'other client folder → scope home');
});

run('push_daily');
