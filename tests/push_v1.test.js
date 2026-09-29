// LOCKED IN Push Notifications V1 — pilot test suite.
//
// 0 production invocations. Real handler.ts / schedule.ts / notifier source,
// strict in-memory Supabase stand-in, fake push service that decrypts every
// message (tests/push_harness.js).
//
// Usage (from the DASHBOARD repo root):   node tests/push_v1.test.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const nodeCrypto = require('crypto');
const {
  rd, SCH, H, test, assert, eq, run, sha256hex, REASONS,
  CANARY, OTHER, CANARY_TOKEN, OTHER_TOKEN, CRON_SECRET, DEPLOY_SECRET,
  world, assertNoLeak,
} = require('./push_harness');

const TZ = 'Australia/Sydney';
const at = (date, hhmm, tz = TZ) => SCH.zonedTimeToUtc(date, SCH.parseTime(hhmm), tz);
const iso = (ms) => new Date(ms).toISOString();

/** A world where the canary has opted in from one device. */
async function pilot(opts = {}) {
  const w = await world({ now: opts.now ?? at('2026-09-30', '07:40'), allowed: opts.allowed });
  w.sub = w.newSub();
  const r = await w.subscribe(w.sub, { timezone: opts.tz ?? TZ });
  assert(r.j.ok, 'opt-in subscribe ok');
  const pr = w.db.T.push_preferences.find((p) => p.client_id === w.canaryId);
  assert(pr, 'prefs row created by opt-in');
  Object.assign(pr, { weighin_available: opts.weighinAvailable ?? true, ...(opts.prefs || {}) });
  return w;
}
const events = (w, kind) => w.db.T.notification_events.filter((e) => !kind || e.kind === kind);
const pushes = (w, tag) => w.svc.received.filter((r) => !tag || r.payload.tag === tag);
const logWeight = (w, ms) => w.db.T.weight_logs.push({ id: w.db.uuid(), client_id: w.canaryId, logged_at: iso(ms), weight_kg: 80 });
const logCheckin = (w, ms) => w.db.T.check_ins.push({ id: w.db.uuid(), client_id: w.canaryId, submitted_at: iso(ms) });

// ════════════════════════════════════════════════════════════════════════════
// T. Timezone + window rules (pure)
// ════════════════════════════════════════════════════════════════════════════
test('T1 Sydney vs UTC wall clock for the same instant', async () => {
  const ms = Date.UTC(2026, 8, 29, 21, 30);                 // 2026-09-29 21:30Z
  const syd = SCH.localParts(ms, TZ), utc = SCH.localParts(ms, 'UTC');
  eq(syd.date, '2026-09-30', 'Sydney date'); eq(syd.minuteOfDay, 7 * 60 + 30, 'Sydney 07:30 (AEST +10)'); eq(syd.dow, 3, 'Wednesday');
  eq(utc.date, '2026-09-29', 'UTC date'); eq(utc.minuteOfDay, 21 * 60 + 30, 'UTC 21:30');
});

test('T2 DST start (Sydney 2026-10-04): 23 h day, reminder instants shift by an hour', async () => {
  const d = SCH.localDayBounds('2026-10-04', TZ);
  eq((d.end - d.start) / 3600000, 23, '23-hour day');
  eq(iso(d.start), '2026-10-03T14:00:00.000Z', 'midnight AEST (+10)');
  eq(iso(at('2026-10-04', '07:30')), '2026-10-03T20:30:00.000Z', '07:30 AEDT (+11)');
  eq(iso(at('2026-10-03', '07:30')), '2026-10-02T21:30:00.000Z', 'day before: 07:30 AEST (+10)');
});

test('T3 DST end (Sydney 2027-04-04): 25 h day', async () => {
  const d = SCH.localDayBounds('2027-04-04', TZ);
  eq((d.end - d.start) / 3600000, 25, '25-hour day');
});

test('T4 window: [time, time+60) only', async () => {
  const t = SCH.parseTime('07:30');
  const lp = (hhmm) => ({ date: '2026-09-30', dow: 3, minuteOfDay: SCH.parseTime(hhmm) });
  eq(SCH.windowDate(lp('07:29'), t), null, '07:29 before');
  eq(SCH.windowDate(lp('07:30'), t), '2026-09-30', '07:30 open');
  eq(SCH.windowDate(lp('08:29'), t), '2026-09-30', '08:29 open');
  eq(SCH.windowDate(lp('08:30'), t), null, '08:30 closed');
});

test('T5 reminder near midnight: 23:30 window belongs to the day it started', async () => {
  const t = SCH.parseTime('23:30');
  eq(SCH.windowDate({ date: '2026-10-01', dow: 4, minuteOfDay: SCH.parseTime('23:45') }, t), '2026-10-01', '23:45 same day');
  eq(SCH.windowDate({ date: '2026-10-02', dow: 5, minuteOfDay: SCH.parseTime('00:15') }, t), '2026-10-01', '00:15 → previous day');
  eq(SCH.windowDate({ date: '2026-10-02', dow: 5, minuteOfDay: SCH.parseTime('00:30') }, t), null, '00:30 closed');
});

test('T6 quiet hours, including wrap past midnight and "none"', async () => {
  const q = (m, s, e) => SCH.inQuietHours(SCH.parseTime(m), SCH.parseTime(s), SCH.parseTime(e));
  assert(q('22:00', '21:00', '07:00') && q('06:59', '21:00', '07:00'), 'inside wrapped quiet hours');
  assert(!q('07:00', '21:00', '07:00') && !q('20:59', '21:00', '07:00'), 'outside wrapped quiet hours');
  assert(q('13:00', '12:00', '14:00') && !q('14:00', '12:00', '14:00'), 'same-day quiet hours');
  assert(!q('03:00', '07:00', '07:00'), 'start == end means none');
});

test('T7 UTC client: evaluation uses the client\'s timezone, not the server\'s', async () => {
  const p = { ...H.DEFAULT_PREFS, notifications_enabled: true, timezone: 'UTC', weighin_available: true, weighin_time: '07:30' };
  assert(SCH.evaluateWeighin(p, Date.UTC(2026, 8, 30, 7, 45)).due, 'due at 07:45Z');
  assert(!SCH.evaluateWeighin(p, Date.UTC(2026, 8, 29, 21, 45)).due, 'not due at 21:45Z (07:45 Sydney)');
  const e = SCH.evaluateWeighin(p, Date.UTC(2026, 8, 30, 7, 45));
  eq(e.periodKey, '2026-09-30', 'UTC period'); eq(iso(e.stateFrom), '2026-09-30T00:00:00.000Z', 'UTC day start');
});

test('T8 invalid timezone / time → never due', async () => {
  const base = { ...H.DEFAULT_PREFS, notifications_enabled: true, weighin_available: true };
  assert(!SCH.evaluateWeighin({ ...base, timezone: null }, Date.now()).due, 'null tz');
  assert(!SCH.evaluateWeighin({ ...base, timezone: 'Mars/Base' }, Date.now()).due, 'bad tz');
  assert(!SCH.evaluateWeighin({ ...base, timezone: TZ, weighin_time: '25:00' }, Date.now()).due, 'bad time');
});

// ════════════════════════════════════════════════════════════════════════════
// W. Morning weigh-in reminder (through pushTick)
// ════════════════════════════════════════════════════════════════════════════
test('W1 no weight logged today → exactly one reminder, approved copy, deterministic key', async () => {
  const w = await pilot();
  const r = await w.tick();
  eq(r.j.ok, true, 'tick ok'); eq(r.j.summary.sent, 1, 'one sent');
  const ev = events(w, 'weighin_reminder');
  eq(ev.length, 1, 'one event'); eq(ev[0].status, 'sent', 'sent');
  eq(ev[0].dedupe_key, `weighin:${w.canaryId}:2026-09-30`, 'dedupe key');
  eq(ev[0].period_key, '2026-09-30', 'period'); eq(ev[0].eligible_at, iso(at('2026-09-30', '07:30')), 'eligible_at');
  const p = pushes(w, 'li-weighin');
  eq(p.length, 1, 'one push'); eq(p[0].payload.body, "Morning bro. Log your weight when you're up.", 'copy'); eq(p[0].payload.url, './', 'opens own scope');
  eq(p[0].headers.TTL, '7200', 'expires after 2 h if the phone is off');
  assertNoLeak(w);
});

test('W2 weight already logged today → suppressed already_logged, nothing sent', async () => {
  const w = await pilot();
  logWeight(w, at('2026-09-30', '06:10'));
  const r = await w.tick();
  eq(r.j.summary.sent, 0, 'nothing sent'); eq(pushes(w).length, 0, 'no push');
  eq(events(w, 'weighin_reminder')[0].suppression_reason, 'already_logged', 'reason');
});

test('W3 weight logged one minute before the scheduler run → suppressed', async () => {
  const w = await pilot({ now: at('2026-09-30', '07:45') });
  logWeight(w, at('2026-09-30', '07:44'));
  await w.tick();
  eq(pushes(w).length, 0, 'no push'); eq(events(w, 'weighin_reminder')[0].suppression_reason, 'already_logged', 'reason');
});

test('W4 scheduler retries / re-runs in the window → one event, one push', async () => {
  const w = await pilot();
  await w.tick(); const again = await w.tick();
  w.clock.now = at('2026-09-30', '08:10'); const later = await w.tick();
  eq(events(w, 'weighin_reminder').length, 1, 'one event'); eq(pushes(w).length, 1, 'one push');
  eq(again.j.summary.duplicates, 1, 'retry is a duplicate'); eq(later.j.summary.duplicates, 1, 'later run is a duplicate');
});

test('W5 next day → a new event is allowed', async () => {
  const w = await pilot();
  await w.tick();
  w.clock.now = at('2026-10-01', '07:40'); await w.tick();
  const keys = events(w, 'weighin_reminder').map((e) => e.period_key).sort();
  eq(keys.join(','), '2026-09-30,2026-10-01', 'one per day'); eq(pushes(w).length, 2, 'two pushes over two days');
});

test('W6 disabled (reminder off, or notifications off) → suppressed disabled', async () => {
  let w = await pilot({ prefs: { weighin_enabled: false } });
  await w.tick(); eq(events(w, 'weighin_reminder')[0].suppression_reason, 'disabled', 'reminder off'); eq(pushes(w).length, 0, 'silent');
  w = await pilot({ prefs: { notifications_enabled: false } });
  await w.tick(); eq(events(w, 'weighin_reminder')[0].suppression_reason, 'disabled', 'master off'); eq(pushes(w).length, 0, 'silent');
});

test('W7 reminder time inside quiet hours → suppressed quiet_hours', async () => {
  const w = await pilot({ now: at('2026-09-30', '06:40'), prefs: { weighin_time: '06:30' } });
  await w.tick();
  eq(events(w, 'weighin_reminder')[0].suppression_reason, 'quiet_hours', 'reason'); eq(pushes(w).length, 0, 'silent');
});

test('W8 no active device (client turned notifications off on the phone) → suppressed no_active_device', async () => {
  const w = await pilot();
  await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: w.sub.json.endpoint });
  await w.tick();
  eq(events(w, 'weighin_reminder')[0].suppression_reason, 'no_active_device', 'reason'); eq(pushes(w).length, 0, 'silent');
});

test('W9 app has no daily weight log (weighin_available=false, the default) → no event at all', async () => {
  const w = await pilot({ weighinAvailable: false });
  const r = await w.tick();
  eq(events(w, 'weighin_reminder').length, 0, 'not even recorded'); eq(r.j.summary.due, 0, 'nothing due');
});

test('W10 yesterday\'s late weigh-in does not count for today', async () => {
  const w = await pilot();
  logWeight(w, at('2026-09-29', '23:50'));
  await w.tick();
  eq(events(w, 'weighin_reminder')[0].status, 'sent', 'still reminded today');
});

test('W11 state unknown (weight query fails) → silence, no event; next run can still send', async () => {
  const w = await pilot();
  w.db.fail.on = 'weight_logs';
  const r = await w.tick();
  eq(r.j.summary.stateErrors, 1, 'error counted'); eq(events(w, 'weighin_reminder').length, 0, 'nothing claimed'); eq(pushes(w).length, 0, 'silent');
  w.db.fail.on = null; w.clock.now = at('2026-09-30', '07:55'); await w.tick();
  eq(pushes(w).length, 1, 'recovers on the next run');
});

test('W12 inactive client (access revoked, or paused) → suppressed inactive_client', async () => {
  let w = await pilot();
  w.db.T.client_sessions.find((s) => s.storage_key === CANARY).access_status = 'revoked';
  await w.tick(); eq(events(w, 'weighin_reminder')[0].suppression_reason, 'inactive_client', 'revoked'); eq(pushes(w).length, 0, 'silent');
  w = await pilot();
  w.db.T.clients.find((c) => c.id === w.canaryId).is_paused = true;
  await w.tick(); eq(events(w, 'weighin_reminder')[0].suppression_reason, 'inactive_client', 'paused');
});

test('W13 outside the window → nothing evaluated, nothing recorded', async () => {
  const w = await pilot({ now: at('2026-09-30', '07:29') });
  await w.tick(); w.clock.now = at('2026-09-30', '08:30'); await w.tick();
  eq(events(w).filter((e) => e.kind !== 'test').length, 0, 'no events');
});

test('W14 410 during a reminder → device expired and scrubbed', async () => {
  const w = await pilot();
  w.svc.setStatus(() => 410);
  await w.tick();
  const d = w.db.T.push_devices[0];
  eq(d.status, 'expired', 'expired'); eq(d.endpoint + d.p256dh + d.auth_secret, '', 'endpoint + keys wiped');
  eq(events(w, 'weighin_reminder')[0].status, 'failed', 'event failed, not retried');
});

// ════════════════════════════════════════════════════════════════════════════
// C. Weekly check-in reminder
// ════════════════════════════════════════════════════════════════════════════
const SUN = '2026-10-11', SAT = '2026-10-10';

test('CK1 check-in due (Sunday 09:05) and incomplete → one reminder', async () => {
  const w = await pilot({ now: at(SUN, '09:05'), weighinAvailable: false });
  const r = await w.tick();
  eq(r.j.summary.sent, 1, 'sent');
  const ev = events(w, 'checkin_reminder')[0];
  eq(ev.dedupe_key, `checkin:${w.canaryId}:${SUN}`, 'dedupe key'); eq(ev.status, 'sent', 'status');
  eq(pushes(w, 'li-checkin')[0].payload.body, 'Your weekly check-in is ready when you are.', 'copy');
  eq(pushes(w, 'li-checkin')[0].payload.url, './', 'no invented deep link — opens the main app');
});

test('CK2 already completed (submitted Saturday) → suppressed already_completed', async () => {
  const w = await pilot({ now: at(SUN, '09:05'), weighinAvailable: false });
  logCheckin(w, at(SAT, '18:00'));
  await w.tick();
  eq(events(w, 'checkin_reminder')[0].suppression_reason, 'already_completed', 'reason'); eq(pushes(w).length, 0, 'silent');
});

test('CK3 already reminded this period → duplicate, no second push', async () => {
  const w = await pilot({ now: at(SUN, '09:05'), weighinAvailable: false });
  await w.tick(); w.clock.now = at(SUN, '09:50'); const r = await w.tick();
  eq(events(w, 'checkin_reminder').length, 1, 'one event'); eq(pushes(w).length, 1, 'one push'); eq(r.j.summary.duplicates, 1, 'duplicate');
});

test('CK4 not yet due (Saturday, or Sunday before 09:00) → nothing', async () => {
  const w = await pilot({ now: at(SAT, '09:05'), weighinAvailable: false });
  await w.tick(); w.clock.now = at(SUN, '08:55'); await w.tick();
  eq(events(w, 'checkin_reminder').length, 0, 'no events');
});

test('CK5 last check-in exactly a week ago does not count; one 6 days ago does', async () => {
  let w = await pilot({ now: at(SUN, '09:05'), weighinAvailable: false });
  logCheckin(w, at('2026-10-04', '10:00'));          // previous Sunday
  await w.tick(); eq(events(w, 'checkin_reminder')[0].status, 'sent', '7 days ago → due');
  w = await pilot({ now: at(SUN, '09:05'), weighinAvailable: false });
  logCheckin(w, at('2026-10-05', '08:00'));          // Monday = D-6
  await w.tick(); eq(events(w, 'checkin_reminder')[0].suppression_reason, 'already_completed', '6 days ago → complete');
});

test('CK6 first check-in: programme started < 6 days ago → not due', async () => {
  const w = await pilot({ now: at(SUN, '09:05'), weighinAvailable: false });
  w.db.T.clients.find((c) => c.id === w.canaryId).start_date = '2026-10-08';
  await w.tick(); eq(events(w, 'checkin_reminder').length, 0, 'not due');
});

test('CK7 DST Sunday (2026-10-04) 09:05 AEDT → due, period is that date', async () => {
  const w = await pilot({ now: at('2026-10-04', '09:05'), weighinAvailable: false });
  await w.tick(); eq(events(w, 'checkin_reminder')[0].period_key, '2026-10-04', 'period on DST day');
});

// ════════════════════════════════════════════════════════════════════════════
// P. Program updated (event-driven)
// ════════════════════════════════════════════════════════════════════════════
test('P1 verified deploy → one notification, keyed by the served-shell hash', async () => {
  const w = await pilot({ now: at('2026-09-30', '12:00') });
  const r = await w.programUpdated();
  eq(r.j.status, 'sent', 'sent');
  const ev = events(w, 'program_update')[0];
  eq(ev.dedupe_key, `program_update:${w.canaryId}:${sha256hex('shell-v1')}`, 'dedupe key');
  eq(pushes(w, 'li-program')[0].payload.body, 'Your program has been updated. Tap to view it.', 'copy');
});

test('P2 same deployment hash replayed → duplicate, no second push', async () => {
  const w = await pilot({ now: at('2026-09-30', '12:00') });
  await w.programUpdated(); const r = await w.programUpdated();
  eq(r.j.duplicate, true, 'duplicate'); eq(pushes(w).length, 1, 'one push');
  await w.programUpdated({ deployHash: sha256hex('shell-v2') });
  eq(pushes(w).length, 2, 'a genuinely new deploy notifies again');
});

test('P3 client opted out of program updates → suppressed disabled', async () => {
  const w = await pilot({ now: at('2026-09-30', '12:00'), prefs: { program_updates_enabled: false } });
  const r = await w.programUpdated();
  eq(r.j.status, 'suppressed', 'suppressed'); eq(r.j.reason, 'disabled', 'reason'); eq(pushes(w).length, 0, 'silent');
});

test('P4 deploy during quiet hours → deferred to quiet end, sent once by the scheduler', async () => {
  const w = await pilot({ now: at('2026-09-30', '23:10'), weighinAvailable: false });
  const r = await w.programUpdated();
  eq(r.j.status, 'deferred', 'deferred'); eq(r.j.eligibleAt, iso(at('2026-10-01', '07:00')), 'until 07:00 local');
  w.clock.now = at('2026-10-01', '06:45'); await w.tick(); eq(pushes(w).length, 0, 'still quiet');
  w.clock.now = at('2026-10-01', '07:00'); const t = await w.tick();
  eq(t.j.summary.deferredSent, 1, 'sent at quiet end'); eq(pushes(w).length, 1, 'one push');
  w.clock.now = at('2026-10-01', '07:15'); await w.tick(); eq(pushes(w).length, 1, 'not again');
});

test('P5 deferred, then client opts out before morning → suppressed, nothing sent', async () => {
  const w = await pilot({ now: at('2026-09-30', '23:10'), weighinAvailable: false });
  await w.programUpdated();
  w.db.T.push_preferences[0].program_updates_enabled = false;
  w.clock.now = at('2026-10-01', '07:05'); await w.tick();
  eq(pushes(w).length, 0, 'silent'); eq(events(w, 'program_update')[0].suppression_reason, 'disabled', 'reason');
});

test('P6 deploy notifier auth: missing / wrong secret → 401; no hash configured → 401', async () => {
  let w = await pilot();
  eq((await w.programUpdated({}, null)).status, 401, 'missing'); eq((await w.programUpdated({}, 'x'.repeat(64))).status, 401, 'wrong');
  eq((await w.programUpdated({}, CRON_SECRET)).status, 401, 'cron secret is not the deploy secret');
  w = await world({ internal: false });
  eq((await w.programUpdated()).status, 401, 'no push_internal_auth row → refused');
  eq(events(w).length, 0, 'nothing recorded');
});

test('P7 non-pilot client / bad input → refused, nothing recorded', async () => {
  const w = await pilot();
  eq((await w.programUpdated({ storageKey: OTHER })).j.error, 'push_not_enabled', 'not allow-listed');
  eq((await w.programUpdated({ deployHash: 'nothex' })).j.error, 'bad_deployHash', 'bad hash');
  eq(events(w, 'program_update').length, 0, 'nothing recorded');
});

// ── notifier script: observes deploys, never participates ───────────────────
async function loadNotifier() {
  return import(pathToFileURL(path.join(process.cwd(), 'scripts/push/notify_program_update.mjs')).href);
}
function fakeGit({ trailers = [], changed = [], shells = {} }) {
  return {
    commitTrailers: () => trailers.map((v, i) => ({ sha: 'c' + i, values: v })),
    changedShellKeys: () => changed,
    fileExists: (_s, p) => Object.keys(shells).some((k) => p === `clients/${k}/index.html`),
    show: (_s, p) => Buffer.from(shells[p.split('/')[1]]),
  };
}
const NOTIFIER_ENV = { PUSH_DEPLOY_SECRET: 'set', SUPABASE_PROJECT_REF: 'ref', SHA: 'a'.repeat(40), BEFORE: 'b'.repeat(40) };

test('P8 notifier: deployment never goes live (served bytes never match) → no notification', async () => {
  const N = await loadNotifier(); const posts = [];
  const rep = await N.main({ git: fakeGit({ trailers: [['zac']], changed: ['zac'], shells: { zac: 'NEW' } }),
    fetchServed: async () => Buffer.from('OLD'), post: async (e, b) => { posts.push(b); return { j: { ok: true } }; },
    sleep: async () => {}, env: NOTIFIER_ENV, log: () => {}, attempts: 5, delayMs: 0 });
  eq(posts.length, 0, 'no call'); eq(rep.skipped[0].reason, 'not_live', 'skipped as not live');
});

test('P9 notifier: served fetch keeps failing (Pages build errored) → no notification', async () => {
  const N = await loadNotifier(); const posts = [];
  await N.main({ git: fakeGit({ trailers: [['zac']], changed: ['zac'], shells: { zac: 'NEW' } }),
    fetchServed: async () => { throw new Error('http_404'); }, post: async (e, b) => { posts.push(b); return { j: {} }; },
    sleep: async () => {}, env: NOTIFIER_ENV, log: () => {}, attempts: 3, delayMs: 0 });
  eq(posts.length, 0, 'no call');
});

test('P10 notifier: live after a few checks → notifies with the served hash', async () => {
  const N = await loadNotifier(); const posts = []; let n = 0;
  await N.main({ git: fakeGit({ trailers: [['zac']], changed: ['zac'], shells: { zac: 'NEW' } }),
    fetchServed: async () => Buffer.from(++n < 3 ? 'OLD' : 'NEW'), post: async (e, b) => { posts.push(b); return { j: { ok: true, status: 'sent' } }; },
    sleep: async () => {}, env: NOTIFIER_ENV, log: () => {}, attempts: 5, delayMs: 0 });
  eq(posts.length, 1, 'one call'); eq(posts[0].type, 'programUpdated', 'op');
  eq(posts[0].deployHash, sha256hex('NEW'), 'hash of the live bytes'); eq(posts[0].storageKey, 'zac', 'key');
});

test('P11 notifier: fleet patch with no trailer, or trailer for an unchanged shell → silence', async () => {
  const N = await loadNotifier(); const posts = [];
  const post = async (e, b) => { posts.push(b); return { j: {} }; };
  const common = { fetchServed: async () => Buffer.from('NEW'), post, sleep: async () => {}, env: NOTIFIER_ENV, log: () => {}, attempts: 1, delayMs: 0 };
  await N.main({ git: fakeGit({ trailers: [[]], changed: ['zac', 'mohamad_taha', 'zain_hussein'], shells: { zac: 'NEW' } }), ...common });
  await N.main({ git: fakeGit({ trailers: [['zain_hussein']], changed: ['zac'], shells: { zac: 'NEW' } }), ...common });
  eq(posts.length, 0, 'no calls');
});

test('P12 notifier: inert without its secret; manual run needs NOTIFY', async () => {
  const N = await loadNotifier(); const posts = [];
  const common = { git: fakeGit({ trailers: [['zac']], changed: ['zac'], shells: { zac: 'NEW' } }), fetchServed: async () => Buffer.from('NEW'),
    post: async (e, b) => { posts.push(b); return { j: {} }; }, sleep: async () => {}, log: () => {}, attempts: 1, delayMs: 0 };
  await N.main({ ...common, env: { ...NOTIFIER_ENV, PUSH_DEPLOY_SECRET: '' } });
  await N.main({ ...common, env: { ...NOTIFIER_ENV, DISPATCH_KEY: 'zac', CONFIRM: 'yes' } });
  eq(posts.length, 0, 'no calls');
  await N.main({ ...common, env: { ...NOTIFIER_ENV, DISPATCH_KEY: 'zac', CONFIRM: 'NOTIFY' } });
  eq(posts.length, 1, 'confirmed manual run notifies (after the same live check)');
});

// ════════════════════════════════════════════════════════════════════════════
// S. Settings + security
// ════════════════════════════════════════════════════════════════════════════
test('S1 opt-in creates settings with conservative defaults; nothing exists before the tap', async () => {
  const w = await world();
  const before = await w.prefsGet();
  eq(before.j.prefs.optedIn, false, 'not opted in'); eq(before.j.prefs.notificationsEnabled, false, 'off by default');
  eq((await w.prefsSet({ weighinEnabled: false })).j.error, 'not_opted_in', 'cannot configure before opting in');
  eq(w.db.T.push_preferences.length, 0, 'no row');
  await w.subscribe(w.newSub());
  const p = (await w.prefsGet()).j.prefs;
  eq(p.optedIn, true, 'opted in'); eq(p.notificationsEnabled, true, 'enabled by the tap'); eq(p.timezone, TZ, 'device timezone');
  eq(p.weighinTime, '07:30', 'approved default'); eq(p.checkinTime, '09:00', 'approved default');
  eq(p.quietStart + '-' + p.quietEnd, '21:00-07:00', 'approved quiet hours'); eq(p.weighinAvailable, false, 'weigh-in unavailable by default');
});

test('S2 client can change only client-owned settings, validated', async () => {
  const w = await pilot();
  const r = await w.prefsSet({ weighinTime: '08:00', quietStart: '22:00', checkinEnabled: false, timezone: 'Europe/London' });
  eq(r.j.ok, true, 'ok'); eq(r.j.prefs.weighinTime, '08:00', 'time'); eq(r.j.prefs.timezone, 'Europe/London', 'tz');
  for (const bad of [{ weighinTime: '08:07' }, { weighinTime: '25:00' }, { timezone: 'Mars/Base' }, { checkinEnabled: 'yes' },
                     { weighinAvailable: true }, { checkinDow: 3 }, { client_id: 'x' }]) {
    eq((await w.prefsSet(bad)).j.ok, false, 'rejected ' + JSON.stringify(bad));
  }
  eq(w.db.T.push_preferences[0].weighin_available, true, 'coach-owned field untouched');
});

test('S3 non-pilot real client refused for every client op', async () => {
  const w = await world();
  for (const type of ['pushStatus', 'pushSubscribe', 'pushPrefsGet', 'pushPrefsSet', 'pushUnsubscribe']) {
    const r = await w.call({ type, storageKey: OTHER, token: OTHER_TOKEN, prefs: {}, endpoint: 'x', subscription: w.newSub().json });
    eq(r.j.error, 'push_not_enabled', type);
  }
});

test('S4 one client\'s token cannot read or change another client\'s settings or devices', async () => {
  const w = await pilot({ allowed: [CANARY, OTHER] });
  eq((await w.prefsGet({ storageKey: OTHER })).j.error, 'bad_token', 'read other');
  eq((await w.prefsSet({ quietStart: '20:00' }, { storageKey: OTHER })).j.error, 'bad_token', 'write other');
  eq((await w.call({ type: 'pushSubscribe', storageKey: OTHER, token: CANARY_TOKEN, subscription: w.newSub().json })).j.error, 'bad_token', 'subscribe as other');
  const r = await w.call({ type: 'pushSubscribe', storageKey: CANARY, token: CANARY_TOKEN, subscription: w.newSub().json, client_id: w.otherId });
  eq(w.db.T.push_devices.find((d) => d.id === r.j.deviceId).client_id, w.canaryId, 'body client_id ignored');
});

test('S5 scheduler cannot be invoked anonymously or with the wrong secret', async () => {
  const w = await pilot();
  const writesBefore = w.db.calls.filter((c) => c.mode !== 'select').length;
  eq((await w.tick(null)).status, 401, 'anonymous'); eq((await w.tick('x'.repeat(64))).status, 401, 'wrong');
  eq((await w.tick(DEPLOY_SECRET)).status, 401, 'deploy secret is not the cron secret');
  eq(w.db.calls.filter((c) => c.mode !== 'select').length, writesBefore, 'no writes'); eq(pushes(w).length, 0, 'no push');
  const w2 = await world({ internal: false });
  eq((await w2.tick()).status, 401, 'no hash configured → refused (fail closed)');
});

test('S6 only allow-listed clients are ever evaluated by the scheduler', async () => {
  const w = await pilot({ allowed: [CANARY] });
  // A non-allow-listed real client with an old prefs row and a device is ignored.
  w.db.T.push_preferences.push({ client_id: w.otherId, storage_key: OTHER, notifications_enabled: true, consent_at: iso(0), timezone: TZ,
    weighin_available: true, weighin_enabled: true, weighin_time: '07:30', checkin_enabled: true, checkin_dow: 0, checkin_time: '09:00',
    program_updates_enabled: true, quiet_start: '21:00', quiet_end: '07:00' });
  await w.tick();
  eq(events(w).filter((e) => e.client_id === w.otherId).length, 0, 'never evaluated');
});

test('S7 suppression vocabulary: every recorded reason is in the schema list', async () => {
  const w = await pilot();
  logWeight(w, at('2026-09-30', '06:00'));
  await w.tick();
  for (const e of events(w)) if (e.suppression_reason) assert(REASONS.includes(e.suppression_reason), 'known reason ' + e.suppression_reason);
});

test('S8 no secret, token, endpoint or key in any response or log across a full run', async () => {
  const w = await pilot({ now: at(SUN, '07:40'), prefs: { weighin_time: '07:30' } });
  await w.tick(); await w.prefsGet(); await w.prefsSet({ quietEnd: '06:00' });
  w.clock.now = at(SUN, '09:05'); await w.tick(); await w.programUpdated();
  assert(pushes(w).length === 3, 'weigh-in + check-in + program update delivered');
  assertNoLeak(w);
  assert(!JSON.stringify(w.db.T.notification_events).includes(w.sub.json.endpoint), 'events never store endpoints');
});

test('S9 pushPrefs responses expose no internal fields', async () => {
  const w = await pilot();
  const keys = Object.keys((await w.prefsGet()).j.prefs).sort().join(',');
  eq(keys, 'checkinDow,checkinEnabled,checkinTime,notificationsEnabled,optedIn,programUpdatesEnabled,quietEnd,quietStart,timezone,weighinAvailable,weighinEnabled,weighinTime', 'public shape');
});

test('S10 migration V1 is additive and locked down', async () => {
  const live = require('./push_harness').MIGRATION_V1.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/\bdrop table\b/i.test(live), 'no DROP TABLE outside DOWN');
  assert(!/alter table public\.(clients|client_sessions|programs|weight_logs|check_ins|profiles)\b/i.test(live), 'no existing non-push table altered');
  for (const t of ['push_preferences', 'push_internal_auth']) {
    assert(new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(live), t + ' RLS');
    assert(new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`).test(live), t + ' revoke');
  }
  assert(!/create policy/i.test(live), 'no policies (default deny)');
  const sched = rd('supabase/manual/push_scheduler_enable.sql');
  assert(/gen_random_bytes\(32\)/.test(sched) && /vault\.create_secret/.test(sched), 'cron secret minted in-database');
  assert(/'\*\/15 \* \* \* \*'/.test(sched), 'every 15 minutes, not every minute');
  assert(!/[0-9a-f]{64}/.test(sched), 'no secret or hash literal in the scheduler SQL');
});

// ════════════════════════════════════════════════════════════════════════════
// EL. Automatic push eligibility from trusted server state (no manual list)
// ════════════════════════════════════════════════════════════════════════════
const grant = (w, clientId, product = 'locked_in_1to1', extra = {}) =>
  w.db.T.client_entitlements.push({ id: w.db.uuid(), client_id: clientId, product_code: product, status: 'active', starts_at: null, ends_at: null, source: 'manual', ...extra });
const asZac = (w, type, extra = {}) => w.call({ type, storageKey: OTHER, token: OTHER_TOKEN, ...extra });

test('EL1 normal 1:1 client (active locked_in_1to1, active access, not internal) is eligible with NO list entry', async () => {
  const w = await world({ allowed: [CANARY], now: at(SUN, '09:05') });
  grant(w, w.otherId);
  const sub = w.newSub();
  const r = await asZac(w, 'pushSubscribe', { subscription: sub.json, timezone: TZ });
  eq(r.j.ok, true, 'subscribe'); eq((await asZac(w, 'pushPrefsGet')).j.prefs.optedIn, true, 'prefs');
  await w.tick();
  eq(w.svc.received.filter((x) => x.url === sub.json.endpoint).length, 1, 'scheduler reminded the auto-eligible client');
  eq((await w.programUpdated({ storageKey: OTHER, deployHash: sha256hex('zac-v2') })).j.status, 'sent', 'program update');
  eq((await w.send({ storageKey: OTHER })).j.status, 'sent', 'coach test send');
});

test('EL2 self-guided-only client is never eligible (client ops, scheduler, deploy, coach)', async () => {
  const w = await world({ allowed: [CANARY], now: at(SUN, '09:05') });
  grant(w, w.otherId, 'locked_in_self_guided_12w');
  for (const type of ['pushStatus', 'pushSubscribe', 'pushPrefsGet']) eq((await asZac(w, type, { subscription: w.newSub().json })).j.error, 'push_not_enabled', type);
  w.db.T.push_preferences.push({ client_id: w.otherId, storage_key: OTHER, notifications_enabled: true, consent_at: iso(0), timezone: TZ, weighin_available: false,
    weighin_enabled: true, weighin_time: '07:30', checkin_enabled: true, checkin_dow: 0, checkin_time: '09:00', program_updates_enabled: true, quiet_start: '21:00', quiet_end: '07:00' });
  await w.tick();
  eq(events(w).filter((e) => e.client_id === w.otherId).length, 0, 'scheduler never evaluated');
  eq((await w.programUpdated({ storageKey: OTHER })).j.error, 'push_not_enabled', 'deploy notifier');
  eq((await w.send({ storageKey: OTHER })).j.error, 'push_not_enabled', 'coach');
});

test('EL3 internal account with a locked_in_1to1 grant is still not automatically eligible', async () => {
  const w = await world({ allowed: [] });
  grant(w, w.canaryId);
  eq((await w.subscribe(w.newSub())).j.error, 'push_not_enabled', 'internal refused');
  w.db.T.clients.find((c) => c.id === w.otherId).is_internal = true; grant(w, w.otherId);
  eq((await asZac(w, 'pushStatus')).j.error, 'push_not_enabled', 'internal real-looking key refused');
});

test('EL4 inactive grants never count (paused / expired / revoked / pending / future start / past end)', async () => {
  for (const extra of [{ status: 'paused' }, { status: 'expired' }, { status: 'revoked' }, { status: 'pending' },
                       { starts_at: iso(Date.UTC(2027, 0, 1)) }, { ends_at: iso(Date.UTC(2026, 0, 1)) }]) {
    const w = await world({ allowed: [] });
    grant(w, w.otherId, 'locked_in_1to1', extra);
    eq((await asZac(w, 'pushStatus')).j.error, 'push_not_enabled', JSON.stringify(extra));
  }
});

test('EL5 pre-cutover legacy marker counts as 1:1 (same as the api); no grant + no marker = refused', async () => {
  let w = await world({ allowed: [] });
  w.db.T.clients.find((c) => c.id === w.otherId).entitlement_legacy = true;
  eq((await asZac(w, 'pushStatus')).j.ok, true, 'legacy marker → eligible');
  w = await world({ allowed: [] });
  eq((await asZac(w, 'pushStatus')).j.error, 'push_not_enabled', 'unprovisioned → refused');
  w = await world({ allowed: [OTHER] });
  eq((await asZac(w, 'pushStatus')).j.ok, true, 'explicit exception list still admits an unprovisioned client');
});

test('EL6 access revoked or suspended → refused; access is re-read, never trusted from the caller', async () => {
  for (const st of ['revoked', 'suspended']) {
    const w = await world({ allowed: [] });
    grant(w, w.otherId);
    w.db.T.client_sessions.find((x) => x.storage_key === OTHER).access_status = st;
    eq((await asZac(w, 'pushStatus')).j.error, 'access_' + st, st);
    eq((await w.send({ storageKey: OTHER })).j.error, 'push_not_enabled', st + ' (coach path)');
  }
});

test('EL7 a newly-created 1:1 client becomes eligible automatically — and stops when the grant ends', async () => {
  const w = await world({ allowed: [CANARY] });
  const id = w.db.uuid(), token = 'newclient_' + nodeCrypto.randomBytes(16).toString('hex'), salt = 'sn' + nodeCrypto.randomBytes(8).toString('hex');
  w.db.T.clients.push({ id, storage_key: 'new_client', is_paused: false, start_date: null, is_internal: false, entitlement_legacy: false });
  w.db.T.client_sessions.push({ client_id: id, storage_key: 'new_client', token_hash: sha256hex(token + salt), salt, access_status: 'active' });
  const ask = () => w.call({ type: 'pushStatus', storageKey: 'new_client', token });
  eq((await ask()).j.error, 'push_not_enabled', 'before provisioning: refused');
  grant(w, id);
  eq((await ask()).j.ok, true, 'after the locked_in_1to1 grant: eligible, no list or env change');
  w.db.T.client_entitlements.find((e) => e.client_id === id).status = 'revoked';
  eq((await ask()).j.error, 'push_not_enabled', 'grant revoked: refused again');
});

test('EL8 caller-supplied eligibility hints are ignored', async () => {
  const w = await world({ allowed: [] });
  const r = await asZac(w, 'pushSubscribe', { subscription: w.newSub().json, eligible: true, productCode: 'locked_in_1to1', is_internal: false, entitlement: 'locked_in_1to1', allowed: true });
  eq(r.j.error, 'push_not_enabled', 'still refused'); eq(w.db.T.push_devices.length, 0, 'nothing stored');
});

test('EL9 client holding both self-guided and 1:1 grants is eligible (1:1 present)', async () => {
  const w = await world({ allowed: [] });
  grant(w, w.otherId, 'locked_in_self_guided_12w'); grant(w, w.otherId);
  eq((await asZac(w, 'pushStatus')).j.ok, true, 'eligible');
});

test('EL10 entitlement state unreadable → fail closed everywhere', async () => {
  const w = await world({ allowed: [CANARY], now: at(SUN, '09:05') });
  grant(w, w.otherId);
  const sub = w.newSub(); eq((await asZac(w, 'pushSubscribe', { subscription: sub.json, timezone: TZ })).j.ok, true, 'opted in while healthy');
  w.db.fail.on = 'client_entitlements';
  eq((await asZac(w, 'pushStatus')).j.error, 'push_not_enabled', 'client op refused');
  const t = await w.tick();
  eq(t.j.summary.clients, 0, 'scheduler evaluates nobody'); eq(w.svc.received.length, 0, 'nothing sent');
  eq((await w.programUpdated({ storageKey: OTHER })).j.error, 'push_not_enabled', 'deploy notifier refused');
  // A pre-cutover (legacy-marker) client must NOT fall back to the marker when grants are unreadable (api denies too).
  const w2 = await world({ allowed: [] });
  w2.db.T.clients.find((c) => c.id === w2.otherId).entitlement_legacy = true;
  eq((await asZac(w2, 'pushStatus')).j.ok, true, 'legacy client eligible while healthy');
  w2.db.fail.on = 'client_entitlements';
  eq((await asZac(w2, 'pushStatus')).j.error, 'push_not_enabled', 'legacy client refused when grants are unreadable');
});

test('EL11 entitlementRowIsActive is a verbatim copy of the api implementation', async () => {
  const grabFn = (src) => {
    const i = src.indexOf('function entitlementRowIsActive'); assert(i >= 0, 'present');
    const j = src.indexOf('\n}', i); return src.slice(i, j + 2).replace(/\s+/g, ' ');
  };
  eq(grabFn(rd('supabase/functions/push/handler.ts')), grabFn(rd('supabase/functions/api/index.ts')), 'identical');
});

test('EL12 scheduler evaluates only eligible opted-in clients; the explicit list is exceptions only', async () => {
  const w = await pilot({ allowed: [CANARY], now: at(SUN, '09:05'), weighinAvailable: false });
  grant(w, w.otherId);
  const zs = w.newSub(); await asZac(w, 'pushSubscribe', { subscription: zs.json, timezone: TZ });
  const t = await w.tick();
  eq(t.j.summary.clients, 2, 'canary (exception) + auto-eligible zac');
  w.db.T.client_entitlements.forEach((e) => { e.status = 'expired'; });
  w.clock.now = at(SUN, '09:20');
  eq((await w.tick()).j.summary.clients, 1, 'zac drops out the moment the grant lapses; canary remains');
});

// ════════════════════════════════════════════════════════════════════════════
// U. Pilot shell integration tool (throwaway copies only — never a live shell)
// ════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');
const PILOT_CANDIDATES = ['zac', 'mohamad_taha', 'zain_hussein'];
// Live shells are integrated since the 1:1 fleet rollout; the tool is exercised on
// their PRE-ROLLOUT bytes from the baseline commit (full history in CI).
const PRE_ROLLOUT = 'e29d69b';
function origShell(key) {
  try { return execFileSync('git', ['show', `${PRE_ROLLOUT}:clients/${key}/index.html`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

function tmpRepoWith(key, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-shell-'));
  fs.mkdirSync(path.join(dir, 'clients', key), { recursive: true });
  fs.writeFileSync(path.join(dir, 'clients', key, 'index.html'), html);
  return dir;
}
function tool(args) {
  try { return { code: 0, out: execFileSync('python3', ['scripts/push/patch_pilot_shell.py', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('U1 real 1:1 shells: patched copy compiles, legacy prompt gone, four edits only, block inside Tracker', async () => {
  for (const key of PILOT_CANDIDATES) {
    const orig = origShell(key);
    assert(orig, key + ': pre-rollout baseline readable (needs git history)');
    const dir = tmpRepoWith(key, orig);
    const r = tool([key, '--repo', dir]);
    eq(r.code, 0, key + ' patched: ' + r.out.slice(0, 200));
    const out = fs.readFileSync(path.join(dir, 'clients', key, 'index.html'), 'utf8');
    assert(!/requestPermission|new Notification\(/.test(out), key + ': no automatic prompt / in-page notification');
    eq((out.match(/LOCKED-IN-PUSH:v1/g) || []).length, 3, key + ': 2 legacy stubs + 1 mount block');
    const tr0 = out.indexOf('id="section-tracker"'), tr1 = out.indexOf('</section>', tr0), mp = out.indexOf('id="li-push-settings"');
    assert(tr0 > 0 && mp > tr0 && mp < tr1, key + ': mount block inside the Tracker section');
    assert(/<script src="\.\.\/\.\.\/push-client\.js" defer><\/script>/.test(out.slice(tr0, tr1)), key + ': push-client.js deferred, inside Tracker');
    assert(/addEventListener\('DOMContentLoaded'/.test(out.slice(tr0, tr1)), key + ': mounts after the shell scripts have run');
    eq(out.slice(out.lastIndexOf('</body>') - 200), orig.slice(orig.lastIndexOf('</body>') - 200), key + ': nothing added at </body>');
    eq((out.match(/register\('\.\.\/\.\.\/sw\.js', \{ scope: '\.\/' \}\)/g) || []).length, 1, key + ': shared worker, own scope');
    eq((out.match(/id="li-push-settings"/g) || []).length, 1, key + ': one mount point');
    for (const [i, js] of inlineScripts(out).entries()) new vm.Script(js, { filename: `${key}-inline-${i}.js` });   // throws on syntax error
    const cfg = (s) => (s.match(/const CLIENT_CONFIG = [\s\S]*?\n\};?\n/) || [''])[0];
    eq(cfg(out), cfg(orig), key + ': CLIENT_CONFIG byte-identical');
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'clients', key, 'manifest.json'), 'utf8'));
    eq(man.display + man.scope + man.start_url, 'standalone././', key + ': standalone manifest scoped to the client');
    const again = tool([key, '--repo', dir]);
    assert(/already_patched/.test(again.out), key + ': idempotent');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U2 tool refuses: canary / invalid keys, missing anchors, and never writes on refusal', async () => {
  assert(/refusing/.test(tool(['_push_canary', '--check']).out), 'underscore keys refused');
  assert(/refusing/.test(tool(['../zac', '--check']).out), 'path-like key refused');
  const orig = origShell('zac');
  assert(orig, 'pre-rollout baseline readable');
  for (const [label, mutate] of [
    ['no legacy block', (s) => s.replace(/Notification\.requestPermission/g, 'x')],
    ['two sw registrations', (s) => s + "\n<script>navigator.serviceWorker.register('sw.js')</script>"],
    ['no tracker', (s) => s.replace('id="section-tracker"', 'id="section-x"')],
  ]) {
    const html = mutate(orig);
    const dir = tmpRepoWith('zac', html);
    const r = tool(['zac', '--repo', dir]);
    assert(r.code !== 0 && /refusing/.test(r.out), label + ' → refused');
    eq(fs.readFileSync(path.join(dir, 'clients', 'zac', 'index.html'), 'utf8'), html, label + ' → shell untouched');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U3 --check never writes; live 1:1 shells are already integrated (idempotent)', async () => {
  const before = PILOT_CANDIDATES.map((k) => sha256hex(rd(`clients/${k}/index.html`)));
  for (const k of PILOT_CANDIDATES) assert(/already_patched/.test(tool([k, '--check']).out), k + ' already integrated');
  eq(PILOT_CANDIDATES.map((k) => sha256hex(rd(`clients/${k}/index.html`))).join(), before.join(), 'bytes unchanged');
});

test('U5 fleet invariant: every eligible 1:1 shell carries the integration, and nothing else prompts', async () => {
  const API = /sheetsWebhookUrl:\s*'https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/api'/;
  let eligible = 0;
  for (const key of fs.readdirSync('clients').sort()) {
    const f = `clients/${key}/index.html`;
    if (key.startsWith('_') || !fs.existsSync(f)) continue;
    const html = rd(f);
    if (html.includes('x-registry-skip') || !API.test(html) || !html.includes('const CLIENT_TOKEN')) continue;   // shims / legacy non-Supabase shells
    eligible++;
    eq((html.match(/LOCKED-IN-PUSH:v1/g) || []).length, 3, key + ': integration markers');
    assert(!/requestPermission|new Notification\(/.test(html), key + ': no automatic prompt or in-page notification');
    eq((html.match(/register\('\.\.\/\.\.\/sw\.js', \{ scope: '\.\/' \}\)/g) || []).length, 1, key + ': shared worker, own scope');
    assert(!/navigator\.serviceWorker\.register\('sw\.js'\)/.test(html), key + ': no per-folder worker registration');
    const man = JSON.parse(rd(`clients/${key}/manifest.json`));
    eq(man.display + man.scope, 'standalone./', key + ': standalone manifest scoped to the client');
  }
  assert(eligible >= 51, 'at least the 51 rolled-out 1:1 shells were checked (got ' + eligible + ')');
});

test('U4 --file mode on a copy of master_template.html: same four edits, reversal-proven, idempotent', async () => {
  const tpl = path.join(process.env.HOME, 'Desktop/client_template/master_template.html');
  if (!fs.existsSync(tpl)) return;   // CI checkout has no client_template; covered locally
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-tpl-'));
  const copy = path.join(dir, 'master_template.html');
  fs.copyFileSync(tpl, copy);
  const r = tool(['--file', copy]);
  eq(r.code, 0, 'template patched: ' + r.out.slice(0, 200));
  const out = fs.readFileSync(copy, 'utf8');
  eq((out.match(/LOCKED-IN-PUSH:v1/g) || []).length, 3, 'markers');
  assert(!/requestPermission|new Notification\(/.test(out), 'no automatic prompt in the template');
  assert(/already_patched/.test(tool(['--file', copy]).out), 'idempotent');
  eq(fs.existsSync(path.join(dir, 'manifest.json')), false, '--file never writes a manifest');
  fs.rmSync(dir, { recursive: true, force: true });
});

run('push_v1');
