// LOCKED IN Push — Daily Reminders V1, PLAN-SYNCED (training + meals).
//
// The approved plan owns the schedule (locked-in.schedule.v1 → LI_SCHEDULE in the
// served shell → planFactsSync → push_plan_facts). The client only switches each
// category on or off.
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
  rd, SCH, H, test, assert, eq, run, REASONS, KINDS, MIGRATION_SCHED, MIGRATION_DROP, SCHEMA,
  CANARY, OTHER, CANARY_TOKEN, OTHER_TOKEN, COACH_HASH, DEPLOY_SECRET, sha256hex, world, assertNoLeak,
} = require('./push_harness');

const TZ = 'Australia/Sydney';
const at = (date, hhmm, tz = TZ) => SCH.zonedTimeToUtc(date, SCH.parseTime(hhmm), tz);
const iso = (ms) => new Date(ms).toISOString();

// Week of Mon 2026-10-12 (AEDT).
const MON = '2026-10-12', TUE = '2026-10-13', WED = '2026-10-14', THU = '2026-10-15', SAT = '2026-10-17';

// ── plan schedules (what an approved plan would carry) ──────────────────────
const schedule = (training, meals) => ({ schema: 'locked-in.schedule.v1', training, meals });
const TRAIN_A = { status: 'confirmed', source: 'coach_confirmed', days: [
  { dow: 1, time: '18:30', session: 'Push' }, { dow: 2, time: '18:30', session: null },
  { dow: 4, time: '18:30', session: null }, { dow: 5, time: '18:30', session: null }] };
const TRAIN_B = { status: 'confirmed', source: 'coach_confirmed', days: [
  { dow: 1, time: '19:30', session: null }, { dow: 3, time: '19:30', session: null },
  { dow: 5, time: '19:30', session: null }, { dow: 6, time: '19:30', session: null }] };
const FEEDS4 = { status: 'confirmed', source: 'client_confirmed', feeds: [
  { slot: 1, time: '08:00' }, { slot: 2, time: '12:30' }, { slot: 3, time: '17:00' }, { slot: 4, time: '20:30' }] };
const FEEDS3 = { status: 'confirmed', source: 'client_confirmed', feeds: [
  { slot: 1, time: '08:00' }, { slot: 2, time: '12:30' }, { slot: 3, time: '17:00' }] };
const UNKNOWN = { status: 'unknown' };
const FULL = schedule(TRAIN_A, FEEDS4);

/** Facts exactly as the sync script would send them for a served shell. */
function facts({ sched = FULL, feeds = 4, wc = true, served = 'shell-a' } = {}) {
  return {
    served_sha256: sha256hex(served), meal_plan_sig: sha256hex('plan-' + feeds),
    meal_facts_status: feeds === null ? 'variable' : 'consistent', meal_slot_count: feeds,
    has_workout_completion: wc, schedule: sched, schedule_sig: sched === null ? null : sha256hex(JSON.stringify(sched)),
  };
}
const SYNC_HDR = { 'x-push-deploy-secret': DEPLOY_SECRET };
const sync = (w, f, key = CANARY) => w.call({ type: 'planFactsSync', storageKey: key, facts: f, commit: 'abcdef1' }, 'POST', SYNC_HDR);

/** The canary, opted in from one device, in the daily rollout, plan facts synced, categories ON. */
async function planWorld(opts = {}) {
  const w = await world({ now: opts.now ?? at(MON, '06:00'), daily: opts.daily === false ? undefined : (opts.dailyKeys ?? [CANARY]), checkinSeq: opts.checkinSeq });
  w.sub = w.newSub();
  const r = await w.subscribe(w.sub, { timezone: opts.tz ?? TZ });
  assert(r.j.ok, 'opt-in subscribe ok');
  const pr = w.db.T.push_preferences.find((p) => p.client_id === w.canaryId);
  Object.assign(pr, { quiet_start: '22:00:00', quiet_end: '06:00:00' }, opts.prefs || {});
  if (opts.facts !== null) {
    const s = await sync(w, opts.facts ?? facts());
    assert(s.j.ok, 'facts synced: ' + JSON.stringify(s.j));
  }
  if (opts.on !== false) {
    if (w.db.T.push_plan_facts[0]?.training_schedule_status === 'confirmed' && w.db.T.push_plan_facts[0]?.has_workout_completion) pr.training_enabled = true;
    if (w.db.T.push_plan_facts[0]?.meal_schedule_status === 'confirmed') pr.meals_enabled = true;
    Object.assign(pr, opts.prefsAfter || {});
  }
  return w;
}

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
    session_kind: 'mandatory', completed_at: iso(ms), recorded_at: iso(ms), local_date: opts.localDate ?? SCH.localParts(ms, TZ).date,
    timezone: TZ, status: 'completed', revoked_at: null, revoked_by: null,
  };
  w.db.T.workout_completions.push(row);
  return row;
}
const revoke = (row, ms) => Object.assign(row, { status: 'revoked', revoked_at: iso(ms), revoked_by: 'client' });
const explain = (w, extra = {}) => w.call({ type: 'coachPushExplain', coachToken: COACH_HASH, storageKey: CANARY, ...extra });
const prefs = async (w) => (await w.prefsGet()).j.prefs;

// ════════════════════════════════════════════════════════════════════════════
// AV. Availability + client control (the client toggles a category, never a schedule)
// ════════════════════════════════════════════════════════════════════════════
test('AV1 unknown training schedule → no training reminder offered or sent', async () => {
  const w = await planWorld({ facts: facts({ sched: schedule(UNKNOWN, FEEDS4) }) });
  const p = await prefs(w);
  eq(p.daily.trainingAvailable, false, 'training row hidden'); eq(p.daily.mealsAvailable, true, 'meals still offered');
  eq((await w.prefsSet({ trainingEnabled: true })).j.error, 'training_not_available', 'cannot be switched on');
  w.db.T.push_preferences[0].training_enabled = true;                     // even if forced on, nothing fires
  await scheduler(w, at(MON, '17:00'), at(TUE, '00:00'));
  eq(ev(w, 'training_reminder').length, 0, 'no training rows'); eq(pushes(w, 'li-training').length, 0, 'silent');
});

test('AV2 unknown meal schedule (or no LI_SCHEDULE at all) → no meal reminder offered or sent', async () => {
  for (const f of [facts({ sched: schedule(TRAIN_A, UNKNOWN) }), facts({ sched: null })]) {
    const w = await planWorld({ facts: f });
    const p = await prefs(w);
    eq(p.daily.mealsAvailable, false, 'meal row hidden');
    eq((await w.prefsSet({ mealsEnabled: true })).j.error, 'meals_not_available', 'cannot be switched on');
    w.db.T.push_preferences[0].meals_enabled = true;
    await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
    eq(ev(w, 'meal_reminder').length, 0, 'no meal rows');
  }
});

test('AV3 confirmed schedules → both toggles offered; default OFF until the client switches them on', async () => {
  const w = await planWorld({ on: false });
  const p = await prefs(w);
  eq(p.daily.trainingAvailable, true, 'training row'); eq(p.daily.mealsAvailable, true, 'meal row');
  eq(p.trainingEnabled, false, 'training off by default'); eq(p.mealsEnabled, false, 'meals off by default');
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(pushes(w).length, 0, 'nothing until switched on');
  assert((await w.prefsSet({ trainingEnabled: true })).j.ok && (await w.prefsSet({ mealsEnabled: true })).j.ok, 'switched on');
  await scheduler(w, at(TUE, '06:00'), at(WED, '00:00'));
  eq(pushes(w, 'li-meal').length, 4, 'meals now'); eq(pushes(w, 'li-training').length, 2, 'training now (Tue primary + follow-up)');
});

test('AV4 the client can only toggle categories: every schedule field is refused, the response carries no schedule', async () => {
  const w = await planWorld();
  for (const f of ['trainingDays', 'trainingTime', 'trainingFollowupEnabled', 'trainingFollowupTime', 'mealTimes', 'schedule', 'mealSlotCount'])
    eq((await w.prefsSet({ [f]: f === 'trainingDays' ? [1] : '18:00' })).j.error, 'unknown_field', `${f} is not a client field`);
  eq((await w.prefsSet({ trainingEnabled: 'yes' })).j.error, 'bad_trainingEnabled', 'boolean only');
  const p = await prefs(w);
  assert(!/18:30|20:30|12:30|feeds|days/.test(JSON.stringify(p)), 'no schedule data reaches the client');
  for (const c of ['training_days', 'training_time', 'training_followup_enabled', 'training_followup_time', 'meal_times'])
    assert(!SCHEMA.push_preferences.has(c), `push_preferences.${c} removed`);
  assert(SCHEMA.push_preferences.has('training_enabled') && SCHEMA.push_preferences.has('meals_enabled'), 'category switches kept');
});

test('AV5 rollout gate: unset → nothing for anyone; a real eligible client with a confirmed plan schedule but not listed gets nothing', async () => {
  const w = await planWorld({ daily: false });
  eq((await prefs(w)).daily.available, false, 'hidden');
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w, 'training_reminder').length + ev(w, 'meal_reminder').length, 0, 'nothing evaluated');
  // A real 1:1 client (eligible by entitlement) with a confirmed schedule, rollout = canary only.
  const w2 = await planWorld();
  w2.db.T.client_entitlements.push({ id: w2.db.uuid(), client_id: w2.otherId, product_code: 'locked_in_1to1', status: 'active', starts_at: null, ends_at: null, source: 'manual' });
  const s2 = w2.newSub(); w2.subs = s2;
  assert((await w2.call({ type: 'pushSubscribe', storageKey: OTHER, token: OTHER_TOKEN, subscription: s2.json, timezone: TZ, standalone: true })).j.ok, 'real client opted in');
  assert((await sync(w2, facts(), OTHER)).j.ok, 'real client has plan facts');
  Object.assign(w2.db.T.push_preferences.find((p) => p.client_id === w2.otherId), { training_enabled: true, meals_enabled: true });
  await scheduler(w2, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w2).filter((e) => e.client_id === w2.otherId && /training|meal/.test(e.kind)).length, 0, 'real client: nothing');
  eq(H.readPushEnv(() => undefined).dailyReminders.keys.size + Number(H.readPushEnv(() => undefined).dailyReminders.all), 0, 'unset env = nobody');
});

// ════════════════════════════════════════════════════════════════════════════
// TR. Training (plan time, Finish Workout, +2 h follow-up)
// ════════════════════════════════════════════════════════════════════════════
test('TR1 primary follows the plan time; plan-bound session named, unbound day generic; training deep link', async () => {
  const w = await planWorld();
  await scheduler(w, at(MON, '17:00'), at(MON, '20:00'));
  let p = pushes(w, 'li-training'); eq(p.length, 1, 'Monday primary');
  eq(p[0].payload.title, 'Push session today 💪', 'session named: the plan binds Push to Monday');
  eq(p[0].payload.url, './?li=training', 'deep link');
  const e = ev(w, 'training_reminder')[0];
  eq(e.eligible_at, iso(at(MON, '18:30')), 'at the plan time'); eq(e.dedupe_key, `training_primary:${w.canaryId}:${MON}`, 'key');
  eq(JSON.stringify(e.context), JSON.stringify({ stage: 'primary', session: 'Push' }), 'context');
  await scheduler(w, at(TUE, '17:00'), at(TUE, '20:00'));
  p = pushes(w, 'li-training'); eq(p.at(-1).payload.title, 'Training today 💪', 'Tuesday: no bound session → generic');
  assertNoLeak(w);
});

test('TR2 not a plan day (Wednesday) → nothing, no rows', async () => {
  const w = await planWorld();
  await scheduler(w, at(WED, '00:00'), at(THU, '00:00'));
  eq(ev(w, 'training_reminder').length, 0, 'no rest-day rows');
});

test('TR3 Finish Workout before the primary → primary and follow-up suppressed already_completed', async () => {
  const w = await planWorld();
  const done = finishWorkout(w, at(MON, '07:10'));
  await scheduler(w, at(MON, '17:00'), at(TUE, '00:00'));
  eq(pushes(w, 'li-training').length, 0, 'silent');
  const rows = ev(w, 'training_reminder');
  eq(rows.map((r) => r.suppression_reason).join(','), 'already_completed,already_completed', 'both stages');
  eq(rows[0].context.completionRef, done.completion_ref, 'which completion');
});

test('TR4 Finish Workout after the primary → +2 h follow-up suppressed', async () => {
  const w = await planWorld();
  await scheduler(w, at(MON, '17:00'), at(TUE, '00:00'), (t) => { if (t === at(MON, '19:45')) finishWorkout(w, t); });
  eq(pushes(w, 'li-training').length, 1, 'primary only');
  const fu = ev(w).find((e) => e.dedupe_key.startsWith('training_followup'));
  eq(fu.eligible_at, iso(at(MON, '20:30')), 'follow-up = plan time + 2 h'); eq(fu.suppression_reason, 'already_completed', 'suppressed');
});

test('TR5 no completion → one follow-up at plan time + 2 h, generic copy; never more than 2', async () => {
  const w = await planWorld();
  await scheduler(w, at(MON, '00:00'), at(TUE, '00:00'));
  const p = pushes(w, 'li-training'); eq(p.length, 2, 'primary + follow-up');
  eq(p[1].payload.title, 'Still training today?', 'follow-up copy'); eq(p[1].payload.url, './?li=training', 'deep link');
  eq(ev(w).find((e) => e.dedupe_key.startsWith('training_followup')).eligible_at, iso(at(MON, '20:30')), '20:30');
});

test('TR6 +2 h follow-up inside quiet hours → suppressed quiet_hours, never moved', async () => {
  const late = schedule({ status: 'confirmed', source: 'coach_confirmed', days: [{ dow: 1, time: '20:30', session: null }] }, FEEDS4);
  const w = await planWorld({ facts: facts({ sched: late }), prefs: { quiet_start: '22:00:00', quiet_end: '06:00:00' } });
  await scheduler(w, at(MON, '19:00'), at(TUE, '09:00'));
  eq(pushes(w, 'li-training').length, 1, 'primary only');
  const fu = ev(w).find((e) => e.dedupe_key.startsWith('training_followup'));
  eq(fu.suppression_reason, 'quiet_hours', 'follow-up at 22:30 silenced'); eq(fu.eligible_at, iso(at(MON, '22:30')), 'not shifted');
});

test('TR7 +2 h follow-up that would cross local midnight → never exists', async () => {
  const late = schedule({ status: 'confirmed', source: 'coach_confirmed', days: [{ dow: 1, time: '22:15', session: null }] }, FEEDS4);
  const w = await planWorld({ facts: facts({ sched: late }), prefs: { quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await scheduler(w, at(MON, '21:00'), at(TUE, '04:00'));
  eq(pushes(w, 'li-training').length, 1, 'primary only'); eq(ev(w, 'training_reminder').length, 1, 'no follow-up row');
  eq(SCH.trainingStages({ time: '22:00' }).followup, null, '22:00 + 2 h = midnight → none');
  eq(SCH.trainingStages({ time: '21:45' }).followup, 23 * 60 + 45, '21:45 → 23:45');
  eq((await explain(w, { date: MON })).j.training.followupPolicy, 'suppressed_crosses_midnight', 'explained');
});

test('TR8 completion revoked before the follow-up → follow-up eligible again; primary never resent', async () => {
  const w = await planWorld();
  let row;
  await scheduler(w, at(MON, '17:00'), at(TUE, '00:00'), (t) => {
    if (t === at(MON, '19:00')) row = finishWorkout(w, t);
    if (t === at(MON, '19:30')) revoke(row, t);
  });
  eq(pushes(w, 'li-training').length, 2, 'primary + follow-up');
  eq(ev(w).filter((e) => e.dedupe_key.startsWith('training_primary')).length, 1, 'primary once');
});

test('TR9 completion state unreadable → silence, nothing claimed; retried inside the window only', async () => {
  const w = await planWorld();
  w.db.fail.on = 'workout_completions';
  await tickAt(w, at(MON, '18:30'));
  eq(ev(w, 'training_reminder').length, 0, 'nothing claimed');
  w.db.fail.on = null;
  await tickAt(w, at(MON, '18:45'));
  eq(pushes(w, 'li-training').length, 1, 'recovered in the window');
  const w2 = await planWorld();
  w2.db.fail.on = 'workout_completions';
  await scheduler(w2, at(MON, '18:30'), at(MON, '19:30'));
  w2.db.fail.on = null;
  await tickAt(w2, at(MON, '19:45'));
  eq(ev(w2, 'training_reminder').length, 0, 'window passed while unreadable → never sent late');
});

test('TR10 primary not delivered → follow-up primary_not_sent', async () => {
  const w = await planWorld();
  await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: w.sub.json.endpoint });
  await tickAt(w, at(MON, '18:30'));
  await w.subscribe(w.newSub());
  await tickAt(w, at(MON, '20:30'));
  eq(pushes(w, 'li-training').length, 0, 'no training push');
  eq(ev(w).find((e) => e.dedupe_key.startsWith('training_followup')).suppression_reason, 'primary_not_sent', 'reason');
});

test('TR11 no Finish Workout on the served shell → training unavailable even with a confirmed schedule', async () => {
  const w = await planWorld({ facts: facts({ wc: false }) });
  eq((await prefs(w)).daily.trainingAvailable, false, 'hidden');
  w.db.T.push_preferences[0].training_enabled = true;
  await scheduler(w, at(MON, '17:00'), at(TUE, '00:00'));
  eq(ev(w, 'training_reminder').length, 0, 'nothing');
});

test('TR12 copy is lock-screen safe and never accusatory; session only from the plan', async () => {
  for (const k of ['training_primary', 'training_followup']) {
    const t = H.TEMPLATES[k];
    assert(!/missed|forgot|skipp|behind|didn|haven/i.test(t.title + t.body), k);
  }
  eq(H.trainingTemplate('primary', null).title, 'Training today 💪', 'generic');
  eq(H.trainingTemplate('primary', 'Upper A').title, 'Upper A session today 💪', 'plan-bound');
  eq(H.trainingTemplate('followup', 'Upper A').title, 'Still training today?', 'follow-up stays generic');
});

// ════════════════════════════════════════════════════════════════════════════
// ME. Meals (plan feed times; no adherence inference)
// ════════════════════════════════════════════════════════════════════════════
test('ME1 meal reminders follow the plan feed times; ordinal neutral copy; nutrition deep link', async () => {
  const w = await planWorld();
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  const p = pushes(w, 'li-meal');
  eq(p.map((x) => x.payload.title).join('|'), 'Meal 1 time 🍽️|Meal 2 time 🍽️|Meal 3 time 🍽️|Meal 4 time 🍽️', 'titles');
  for (const x of p) { eq(x.payload.body, 'Your next planned meal is ready in LOCKED IN.', 'neutral'); eq(x.payload.url, './?li=nutrition', 'deep link'); }
  eq(ev(w, 'meal_reminder').map((e) => e.eligible_at).join(','), ['08:00', '12:30', '17:00', '20:30'].map((t) => iso(at(MON, t))).join(','), 'plan times');
  assert(!w.db.calls.some((c) => /meal_log/.test(c.t)), 'no meal log read'); assert(!rd('supabase/functions/push/handler.ts').includes('meal_logs'), 'handler never names meal_logs');
});

test('ME2 4 → 3 plan deploy: Meal 4 disappears (no row at all); Meals 1-3 continue', async () => {
  const w = await planWorld();
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(pushes(w, 'li-meal').length, 4, 'Monday 4');
  const s = await sync(w, facts({ sched: schedule(TRAIN_A, FEEDS3), feeds: 3, served: 'shell-3' }));
  assert(s.j.ok && s.j.changed && s.j.facts.mealSchedule === 'confirmed', 'new plan synced');
  await scheduler(w, at(TUE, '06:00'), at(WED, '00:00'));
  eq(pushes(w, 'li-meal').length, 7, 'Tuesday 3');
  eq(ev(w).filter((e) => e.dedupe_key === `meal:${w.canaryId}:${TUE}:4`).length, 0, 'Meal 4 not even evaluated');
});

test('ME3 a schedule whose feed count disagrees with the served plan is invalid → meals unavailable, never guessed', async () => {
  const w = await planWorld({ facts: facts({ sched: schedule(TRAIN_A, FEEDS4), feeds: 3 }) });
  eq(w.db.T.push_plan_facts[0].meal_schedule_status, 'invalid', 'recorded invalid');
  eq((await prefs(w)).daily.mealsAvailable, false, 'hidden'); eq((await prefs(w)).daily.trainingAvailable, true, 'training unaffected');
  w.db.T.push_preferences[0].meals_enabled = true;
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w, 'meal_reminder').length, 0, 'nothing');
});

test('ME4 fail-safe: trainer-mode meal edit that no longer matches the schedule → plan_out_of_sync; matching edit or reset → fine', async () => {
  const day = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: 'M' + i, cal: 500 })).concat([{ name: 'PREP', cal: 0 }]));
  const cases = [[day(3), 'plan_out_of_sync'], ['not json', 'plan_out_of_sync'], [day(4), null], ['', null]];
  for (const [value, want] of cases) {
    const w = await planWorld();
    w.db.T.client_overrides.push({ id: w.db.uuid(), client_id: w.canaryId, key: 'meal.w2.d3', value_text: value, value_number: null, valid_to: null });
    w.db.T.client_overrides.push({ id: w.db.uuid(), client_id: w.canaryId, key: 'meal.w1.d1', value_text: day(2), value_number: null, valid_to: '2026-10-01T00:00:00Z' });   // expired: ignored
    await tickAt(w, at(MON, '08:00'));
    const e = ev(w, 'meal_reminder')[0];
    eq(e.suppression_reason ?? null, want, `override ${value.slice(0, 12)} → ${want}`);
  }
  const w = await planWorld();
  w.db.fail.on = 'client_overrides';
  await tickAt(w, at(MON, '08:00'));
  eq(ev(w, 'meal_reminder').length, 0, 'overrides unreadable → silence, nothing claimed');
});

test('ME5 meals disabled by the client / master off / quiet hours', async () => {
  let w = await planWorld({ prefsAfter: { meals_enabled: false } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w, 'meal_reminder').length, 0, 'off → nothing');
  w = await planWorld({ prefsAfter: { notifications_enabled: false } });
  await tickAt(w, at(MON, '08:00'));
  eq(ev(w, 'meal_reminder')[0].suppression_reason, 'disabled', 'master off');
  w = await planWorld({ prefs: { quiet_start: '20:00:00', quiet_end: '06:00:00' } });
  await scheduler(w, at(MON, '06:00'), at(TUE, '07:00'));
  eq(ev(w).find((e) => e.dedupe_key.endsWith(`${MON}:4`)).suppression_reason, 'quiet_hours', 'Meal 4 at 20:30 silenced, never deferred');
});

// ════════════════════════════════════════════════════════════════════════════
// SC. Plan changes, sync, timezone, idempotency, DST
// ════════════════════════════════════════════════════════════════════════════
test('SC1 training schedule change Mon/Tue/Thu/Fri 18:30 → Mon/Wed/Fri/Sat 19:30 replaces the old schedule', async () => {
  const w = await planWorld({ prefs: { quiet_start: '23:00:00', quiet_end: '06:00:00' } });
  const s = await sync(w, facts({ sched: schedule(TRAIN_B, FEEDS4), served: 'shell-b' }));
  assert(s.j.ok && s.j.changed, 'new plan synced');
  await scheduler(w, at(MON, '00:00'), at('2026-10-18', '00:00'));
  const prim = ev(w).filter((e) => e.dedupe_key.startsWith('training_primary'));
  eq(prim.map((e) => e.period_key).join(','), [MON, WED, '2026-10-16', SAT].join(','), 'Mon/Wed/Fri/Sat only (no Tue/Thu)');
  assert(prim.every((e) => SCH.localParts(Date.parse(e.eligible_at), TZ).minuteOfDay === 19 * 60 + 30), 'all at 19:30, none at 18:30');
});

test('SC2 sync is verified-live only: older served bytes cannot replace newer (script) + a client cannot write facts', async () => {
  const w = await planWorld();
  eq((await w.call({ type: 'planFactsSync', storageKey: CANARY, facts: facts() })).status, 401, 'no secret');
  eq((await w.prefsSet({ schedule: FULL })).j.error, 'unknown_field', 'client cannot write a schedule');
  const { main } = await import(path.join(process.cwd(), 'scripts/push/sync_plan_facts.mjs'));
  const newer = Buffer.from('<script>const LI_SCHEDULE = ' + JSON.stringify(schedule(TRAIN_B, UNKNOWN)) + ';</script>');
  const older = Buffer.from('<script>const LI_SCHEDULE = ' + JSON.stringify(schedule(TRAIN_A, UNKNOWN)) + ';</script>');
  const posts = [];
  // An OLD run (commit with `older`) while Pages already serves `newer` → never matches → not synced.
  await main({ git: { shellKeys: () => [CANARY], show: () => older }, env: { PUSH_DEPLOY_SECRET: 'x', SUPABASE_PROJECT_REF: 'r', SHA: 'a'.repeat(40) },
    fetchServed: async () => newer, sleep: async () => {}, attempts: 3, delayMs: 0, log: () => {},
    post: async (e, b) => { posts.push(b); return { status: 200, j: { ok: true } }; } });
  eq(posts.length, 0, 'stale run synced nothing');
  await main({ git: { shellKeys: () => [CANARY], show: () => newer }, env: { PUSH_DEPLOY_SECRET: 'x', SUPABASE_PROJECT_REF: 'r', SHA: 'b'.repeat(40) },
    fetchServed: async () => newer, sleep: async () => {}, attempts: 1, delayMs: 0, log: () => {},
    post: async (e, b) => { posts.push(b); return { status: 200, j: { ok: true } }; } });
  eq(posts.length, 1, 'live run synced'); eq(JSON.stringify(posts[0].facts.schedule.training), JSON.stringify(TRAIN_B), 'schedule from the served bytes');
});

test('SC3 ONE runtime timezone: schedule times are wall-clock in push_preferences.timezone; a schedule timezone is rejected', async () => {
  const w = await planWorld({ tz: 'Asia/Makassar' });                     // Bali
  await scheduler(w, Date.UTC(2026, 9, 12, 0, 0), Date.UTC(2026, 9, 12, 16, 0));
  eq(ev(w, 'training_reminder')[0].eligible_at, iso(at(MON, '18:30', 'Asia/Makassar')), '18:30 Bali time, not Sydney');
  const withTz = { ...FULL, timezone: 'Australia/Sydney' };
  const v = SCH.validateSchedule(withTz, 4);
  eq(v.training + v.meals, 'invalidinvalid', 'a second timezone authority is refused'); assert(v.errors[0].includes('timezone'), 'reason');
  const w2 = await planWorld({ facts: facts({ sched: withTz }) });
  eq((await prefs(w2)).daily.trainingAvailable, false, 'invalid → unavailable');
});

test('SC4 duplicate cron, racing schedulers and a restart never double-send', async () => {
  const w = await planWorld();
  await tickAt(w, at(MON, '18:30')); await tickAt(w, at(MON, '18:30'));
  await Promise.all([tickAt(w, at(MON, '18:45')), tickAt(w, at(MON, '18:45'))]);
  w.clock.now = at(MON, '19:00');
  const fresh = H.makePushHandler({ admin: w.db.admin, env: w.env, fetchImpl: w.svc.fetchImpl, now: () => w.clock.now });
  await fresh(new Request('https://x/push', { method: 'POST', headers: { 'x-push-cron-secret': require('./push_harness').CRON_SECRET }, body: JSON.stringify({ type: 'pushTick' }) }));
  eq(pushes(w, 'li-training').length, 1, 'one primary'); eq(ev(w, 'training_reminder').length, 1, 'one row');
  await Promise.all([tickAt(w, at(MON, '12:30')), tickAt(w, at(MON, '12:30')), tickAt(w, at(MON, '12:45'))]);
  eq(pushes(w, 'li-meal').length, 1, 'Meal 2 once');
});

test('SC5 DST: spring-forward plan time 02:30 fires once at 03:00; fall-back repeated 02:30 once; others at wall time', async () => {
  const one = (dow, time) => schedule({ status: 'confirmed', source: 'coach_confirmed', days: [{ dow, time, session: null }] }, UNKNOWN);
  let w = await planWorld({ now: at('2026-10-04', '00:00'), facts: facts({ sched: one(0, '02:30') }), prefs: { quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await scheduler(w, Date.UTC(2026, 9, 3, 13, 0), Date.UTC(2026, 9, 4, 13, 0));
  const t = ev(w, 'training_reminder').filter((e) => e.dedupe_key.startsWith('training_primary'));
  eq(t.length, 1, 'spring-forward: once'); eq(SCH.localParts(Date.parse(t[0].created_at), TZ).minuteOfDay, 180, 'at 03:00');
  w = await planWorld({ now: at('2027-04-04', '00:00'), facts: facts({ sched: one(0, '02:30') }), prefs: { quiet_start: '00:00:00', quiet_end: '00:00:00' } });
  await scheduler(w, Date.UTC(2027, 3, 3, 12, 0), Date.UTC(2027, 3, 4, 14, 0));
  eq(ev(w, 'training_reminder').filter((e) => e.dedupe_key.startsWith('training_primary')).length, 1, 'fall-back: once');
  w = await planWorld({ now: at('2026-10-04', '00:00'), facts: facts({ sched: one(0, '18:30') }) });
  await scheduler(w, Date.UTC(2026, 9, 3, 13, 0), Date.UTC(2026, 9, 4, 13, 0));
  eq(ev(w, 'training_reminder')[0].eligible_at, iso(at('2026-10-04', '18:30')), '18:30 AEDT on the 23 h day');
});

test('SC6 compile-equivalent validation (server re-validates every sync)', async () => {
  const v = (s, n = 4) => { const r = SCH.validateSchedule(s, n); return r.training + '/' + r.meals; };
  eq(v(null), 'unknown/unknown', 'absent → unknown (valid, unavailable)');
  eq(v(schedule(UNKNOWN, UNKNOWN)), 'unknown/unknown', 'declared unknown is valid');
  eq(v(FULL), 'confirmed/confirmed', 'full');
  const T = (days) => schedule({ status: 'confirmed', source: 'coach_confirmed', days }, UNKNOWN);
  eq(v(T([{ dow: 1, time: '18:30', session: null }, { dow: 1, time: '19:00', session: null }])).split('/')[0], 'invalid', 'duplicate weekday');
  eq(v(T([{ dow: 7, time: '18:30', session: null }])).split('/')[0], 'invalid', 'weekday range');
  eq(v(T([{ dow: 1, time: '18:10', session: null }])).split('/')[0], 'invalid', '15-minute steps');
  eq(v(T([{ dow: 1, time: '6:30pm', session: null }])).split('/')[0], 'invalid', 'HH:MM only');
  eq(v(T([{ dow: 1, time: '18:30', session: 'Push<script>' }])).split('/')[0], 'invalid', 'session charset');
  eq(v(T([{ dow: 1, time: '18:30' }])).split('/')[0], 'invalid', 'session must be explicit (null or a name)');
  eq(v(schedule({ status: 'confirmed', source: 'guessed', days: [{ dow: 1, time: '18:30', session: null }] }, UNKNOWN)).split('/')[0], 'invalid', 'source must be confirmed by client or coach');
  const M = (feeds) => schedule(UNKNOWN, { status: 'confirmed', source: 'client_confirmed', feeds });
  eq(v(M([{ slot: 1, time: '08:00' }, { slot: 3, time: '12:00' }]), 2).split('/')[1], 'invalid', 'sequential slots');
  eq(v(M([{ slot: 1, time: '12:00' }, { slot: 2, time: '08:00' }]), 2).split('/')[1], 'invalid', 'increasing times');
  eq(v(M([{ slot: 1, time: '08:00' }, { slot: 2, time: '12:00' }]), 3).split('/')[1], 'invalid', 'must match the plan feed count');
  eq(v(M([{ slot: 1, time: '08:00' }, { slot: 2, time: '12:00' }]), null).split('/')[1], 'invalid', 'variable plan → no meal schedule');
  eq(v(schedule(UNKNOWN, FEEDS4)), 'unknown/confirmed', 'unknown training never blocks a confirmed meal schedule');
});

test('SC7 daily cap: never more than 10 automatic pushes per local day; the extra one is recorded daily_cap', async () => {
  const eight = { status: 'confirmed', source: 'coach_confirmed', feeds: ['07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00'].map((t, i) => ({ slot: i + 1, time: t })) };
  const w = await planWorld({ facts: facts({ sched: schedule(TRAIN_A, eight), feeds: 8 }) });
  w.db.T.notification_events.push({ id: w.db.uuid(), client_id: w.canaryId, storage_key: CANARY, kind: 'meal_reminder', dedupe_key: 'meal:x:pre', status: 'sent', title: 't', body: 'b', url: './', created_by: 'system', period_key: MON });
  await scheduler(w, at(MON, '06:00'), at(TUE, '00:00'));
  eq(ev(w).filter((e) => e.period_key === MON && ['sent', 'partial', 'claimed'].includes(e.status)).length, 10, 'capped at 10');
  eq(ev(w).filter((e) => e.suppression_reason === 'daily_cap').length, 1, 'observable');
});

// ════════════════════════════════════════════════════════════════════════════
// RG. Regressions: weekly check-in, program update
// ════════════════════════════════════════════════════════════════════════════
test('RG1 weekly check-in unchanged on a training + meal day (copy, url, stages, independent of the daily cap)', async () => {
  const SUN = '2026-10-11';
  const sun = schedule({ status: 'confirmed', source: 'coach_confirmed', days: [{ dow: 0, time: '07:15', session: null }] }, FEEDS4);
  const w = await planWorld({ now: at(SUN, '06:00'), checkinSeq: [CANARY], facts: facts({ sched: sun }) });
  await scheduler(w, at(SUN, '06:00'), at(SUN, '20:00'));
  const ci = pushes(w, 'li-checkin'); eq(ci.length, 2, 'due 09:00 + follow-up 18:00');
  eq(ci[0].payload.body, 'Your weekly check-in is ready. Take a minute to get it done.', 'copy'); eq(ci[0].payload.url, './', 'url');
  eq(pushes(w, 'li-training').length, 2, 'training alongside'); eq(pushes(w, 'li-meal').length, 3, 'meals alongside (Meal 4 at 20:30 after the window)');
});

test('RG2 program-update notifications unchanged with daily reminders on', async () => {
  const w = await planWorld({ now: at(MON, '10:00') });
  const r = await w.programUpdated();
  assert(r.j.ok && r.j.status === 'sent', 'sent'); eq(pushes(w, 'li-program')[0].payload.body, 'Your program has been updated. Tap to view it.', 'copy');
  eq(pushes(w, 'li-program')[0].payload.url, './', 'url');
});

// ════════════════════════════════════════════════════════════════════════════
// OB. Observability
// ════════════════════════════════════════════════════════════════════════════
test('OB1 coachPushExplain shows the plan-owned schedule and each outcome, read-only, no secrets', async () => {
  const w = await planWorld();
  finishWorkout(w, at(MON, '07:00'));
  await scheduler(w, at(MON, '06:00'), at(MON, '21:00'));
  const r = await explain(w, { date: MON });
  eq(r.j.training.status, 'scheduled', 'plan day'); eq(r.j.training.session, 'Push', 'session'); eq(r.j.training.followupPolicy, 'primary_plus_2h', 'policy');
  eq(r.j.training.stages.map((s) => s.time + ':' + s.outcome).join(','), '18:30:already_completed,20:30:already_completed', 'outcomes');
  eq(r.j.meals.slots.map((s) => s.time + ':' + s.outcome).join(','), '08:00:sent,12:30:sent,17:00:sent,20:30:sent', 'meals');
  eq(r.j.planFacts.trainingSchedule + '/' + r.j.planFacts.mealSchedule, 'confirmed/confirmed', 'facts');
  w.clock.now = at(WED, '12:00');
  eq((await explain(w)).j.training.status, 'not_training_day', 'Wednesday');
  const before = JSON.stringify(w.db.T); await explain(w, { date: MON }); eq(JSON.stringify(w.db.T), before, 'writes nothing');
  eq((await w.call({ type: 'coachPushExplain', storageKey: CANARY, coachToken: CANARY_TOKEN })).status, 401, 'coach token only');
  assertNoLeak(w);
  const w2 = await planWorld({ facts: facts({ sched: null }) });
  const r2 = await explain(w2);
  eq(r2.j.training.status + '/' + r2.j.meals.status, 'no_confirmed_schedule/no_confirmed_schedule', 'unknown plan explained');
});

// ════════════════════════════════════════════════════════════════════════════
// PF. Plan facts parser + sync wiring
// ════════════════════════════════════════════════════════════════════════════
const pf = () => import(path.join(process.cwd(), 'scripts/push/plan_facts.mjs'));

test('PF1 LI_SCHEDULE is read as data, never executed; absent → null; malformed → invalid at the server', async () => {
  const { planFactsFromShell, parseSchedule } = await pf();
  const lit = JSON.stringify(FULL);
  const f = planFactsFromShell(Buffer.from(`<script>const LI_SCHEDULE = ${lit};\n</script>`));
  eq(JSON.stringify(f.schedule), lit, 'parsed'); eq(f.schedule_sig, sha256hex(lit), 'sig');
  eq(planFactsFromShell(Buffer.from('<html></html>')).schedule, null, 'absent → null');
  const evil = planFactsFromShell(Buffer.from('<script>const LI_SCHEDULE = {"a": (globalThis.pwned = 1)};</script>'));
  assert(!globalThis.pwned, 'nothing executed'); eq(evil.schedule.schema, 'unparseable', 'marked unparseable');
  eq(parseSchedule('const LI_SCHEDULE = {"s": "};"};').schedule.s, '};', 'string-aware bracket match');
  const w = await planWorld({ facts: { ...facts(), schedule: evil.schedule, schedule_sig: evil.schedule_sig } });
  eq(w.db.T.push_plan_facts[0].training_schedule_status + '/' + w.db.T.push_plan_facts[0].meal_schedule_status, 'invalid/invalid', 'recorded invalid');
});

test('PF2 real fleet: no live client shell carries an LI_SCHEDULE (nobody is migrated by default)', async () => {
  const { planFactsFromShell } = await pf();
  const dir = path.join(process.cwd(), 'clients');
  for (const k of fs.readdirSync(dir)) {
    const f = path.join(dir, k, 'index.html');
    if (!fs.existsSync(f) || k.startsWith('_')) continue;
    eq(planFactsFromShell(fs.readFileSync(f)).schedule, null, `${k}: no schedule`);
  }
});

test('PF3 sync script: verified-live only; inert without secret; manual run needs SYNC', async () => {
  const { main } = await import(path.join(process.cwd(), 'scripts/push/sync_plan_facts.mjs'));
  const live = Buffer.from('<script>const mealPlan = {};\nmealPlan[1] = [' + Array(7).fill("mkday([mkm('8am','A','x',500,1,1,1)])").join(',') + '];</script>');
  const git = { shellKeys: () => ['zac', 'other_one'], show: (sha, p) => (p.includes('zac') ? live : Buffer.from('old')) };
  const posts = [];
  const env = { PUSH_DEPLOY_SECRET: 'x', SUPABASE_PROJECT_REF: 'ref', SHA: 'a'.repeat(40) };
  const rep = await main({ git, env, fetchServed: async (k) => (k === 'zac' ? live : Buffer.from('new')), sleep: async () => {}, attempts: 2, delayMs: 0, log: () => {},
    post: async (e, b) => { posts.push(b); return { status: 200, j: { ok: true, changed: true } }; } });
  eq(posts.map((p) => p.storageKey).join(','), 'zac', 'only live'); eq(rep.skipped[0].reason, 'not_live', 'stale skipped');
  eq((await main({ git, env: {}, fetchServed: async () => live, sleep: async () => {}, post: async () => { throw new Error('x'); }, log: () => {} })).synced.length, 0, 'inert');
  eq((await main({ git, env: { ...env, DISPATCH: '1', CONFIRM: 'DEPLOY' }, fetchServed: async () => live, sleep: async () => {}, post: async () => { throw new Error('x'); }, log: () => {} })).synced.length, 0, 'needs SYNC');
});

test('PF4 workflow wiring: plan-facts workflow separate from the notifier; deploy runs this suite', async () => {
  const wf = rd('.github/workflows/push-plan-facts.yml');
  assert(/node scripts\/push\/sync_plan_facts\.mjs/.test(wf) && /clients\/\*\/index\.html/.test(wf), 'runs on shell pushes');
  assert(!/programUpdated|notify_program_update\.mjs/.test(wf.replace(/#.*$/gm, '')), 'does not notify');
  assert(/node tests\/push_daily\.test\.js/.test(rd('.github/workflows/deploy-edge-push.yml')), 'deploy runs push_daily');
});

test('PF5 migrations: additive schedule columns; the drop migration removes exactly the 5 client schedule columns', async () => {
  const live = (m) => m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/drop column/i.test(live(MIGRATION_SCHED)), 'schedule migration is additive');
  const dropped = [...live(MIGRATION_DROP).matchAll(/drop column if exists ([a-z_]+)/g)].map((m) => m[1]).sort();
  eq(dropped.join(','), 'meal_times,training_days,training_followup_enabled,training_followup_time,training_time', 'exactly the client schedule');
  assert(!/drop (table|column if exists (training_enabled|meals_enabled))/i.test(live(MIGRATION_DROP)), 'category switches kept');
  for (const c of ['schedule', 'schedule_sig', 'training_schedule_status', 'meal_schedule_status']) assert(SCHEMA.push_plan_facts.has(c), c);
  assert(REASONS.includes('plan_out_of_sync') && KINDS.includes('training_reminder') && KINDS.includes('meal_reminder'), 'vocab');
});

// ════════════════════════════════════════════════════════════════════════════
// DL. Deep links (service worker half; the page half is scripts/push/deeplink_e2e.js)
// ════════════════════════════════════════════════════════════════════════════
test('DL1 sw.js: closed app opens the deep link; open app is focused + told the section; invalid → scope home', async () => {
  const vm = require('vm');
  const listeners = {}, opened = [], messages = [], focused = [];
  const mkClient = (url) => ({ url, focus: async function () { focused.push(url); return this; }, postMessage: (m) => messages.push(m) });
  let windows = [];
  const self = {
    location: { href: 'https://omarsoubra.github.io/DASHBOARD/sw.js' },
    registration: { scope: 'https://omarsoubra.github.io/DASHBOARD/clients/zac/', showNotification: async () => {} },
    clients: { matchAll: async () => windows, openWindow: async (u) => { opened.push(u); }, claim: async () => {} },
    addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: () => {},
  };
  vm.runInNewContext(rd('sw.js'), { self, caches: { open: async () => ({}), keys: async () => [] }, URL, fetch: async () => {}, Promise });
  const click = async (url) => { let p; listeners.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (x) => { p = x; } }); await p; };
  const scope = self.registration.scope;
  await click(scope + '?li=training'); eq(opened.at(-1), scope + '?li=training', 'closed app');
  windows = [mkClient(scope)];
  await click(scope + '?li=nutrition'); eq(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'li-open', section: 'nutrition' }), 'open app');
  await click(scope + '?li=../../x'); eq(messages.length, 1, 'invalid → no message'); eq(focused.length, 2, 'focused');
  windows = [];
  await click('https://evil.example/?li=training'); eq(opened.at(-1), scope, 'other origin → home');
});

run('push_daily');
