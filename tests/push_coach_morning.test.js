// COACH MORNING REPORT PUSH (Omar 2026-10-13) — the real push handler against the strict harness DB.
//   coach-token-only subscribe/status · device stored under `_coach`, never a client · 07:00 Sydney once a day
//   (dedupe) · nothing claimed without a device · headline = the dashboard card's rules · client reminders untouched
const {
  H, SCH, CM, test, assert, eq, run, KINDS, COACH_HASH, CRON_SECRET, world, nodeDecrypt, rd, assertNoLeak,
} = require('./push_harness');

const TZ = 'Australia/Sydney';
const at = (date, hhmm) => SCH.zonedTimeToUtc(date, SCH.parseTime(hhmm), TZ);
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

// A world with the coach account, a roster and a page checker in front of the push service.
async function coachWorld(opts = {}) {
  const w = await world({ now: at('2026-10-13', '07:00') });
  const coachId = w.db.uuid();
  w.db.T.clients.push({ id: coachId, storage_key: '_coach', is_paused: false, start_date: null, is_internal: false, entitlement_legacy: false });
  const mk = (k, name, start) => ({ storageKey: k, displayName: name, startDate: start, programStatus: 'active', accessStatus: 'active' });
  const roster = opts.roster ?? [
    mk('bishoy_shaker', 'Bishoy Shaker', '2026-09-08'),     // week 6 on 13 Oct
    mk('zain_hussein', 'Zain Hussein', '2026-09-15'),       // week 5 -> unlock P2 now
    mk('hassan_x', 'Hassan X', '2026-09-22'),               // week 4 -> next week
    mk('quiet_q', 'Quinn Q', '2026-08-04'),                 // week 11
    mk('gone_g', 'Gary G', '2026-07-01'),
    mk('revoked_r', 'Rex R', '2026-09-15'),
    mk('omar', 'Omar Soubra', '2026-09-15'),                // the coach's own page: skipped
  ];
  roster.find((c) => c.storageKey === 'revoked_r') && (roster.find((c) => c.storageKey === 'revoked_r').accessStatus = 'revoked');
  w.db.T.roster_snapshots.push({ id: 1, snapshot_ts: iso(Date.UTC(2026, 9, 1)), roster_json: [mk('old', 'Old', '2026-01-01')], client_count: 1, author: 'coach' },
                               { id: 2, snapshot_ts: iso(Date.UTC(2026, 9, 12)), roster_json: roster, client_count: roster.length, author: 'coach' });
  const now = w.clock.now;
  const zainId = w.db.uuid(); w.db.T.clients.push({ id: zainId, storage_key: 'zain_hussein', is_paused: false, start_date: null, is_internal: false, entitlement_legacy: false });
  w.db.T.weight_logs.push({ id: 1, client_key: 'bishoy_shaker', logged_at: iso(now - 1 * DAY), weight_kg: 80 });
  w.db.T.meal_logs.push({ id: 1, client_id: zainId, logged_at: iso(now - 2 * DAY) });
  w.db.T.workout_log_entries.push({ id: 1, client_key: 'hassan_x', logged_at: iso(now - 0.5 * DAY) });
  w.db.T.check_ins.push({ id: 1, client_key: 'quiet_q', submitted_at: iso(now - 5 * DAY), week_number: 10 });
  w.db.T.weight_logs.push({ id: 2, client_key: 'gone_g', logged_at: iso(now - 30 * DAY), weight_kg: 90 });
  w.db.T.checkin_drafts.push(
    { id: 1, client_key: 'bishoy_shaker', checkin_ts: 'a', created_at: iso(now - 1 * DAY), sent_at: null },
    { id: 2, client_key: 'zain_hussein', checkin_ts: 'b', created_at: iso(now - 1 * DAY), sent_at: null },
    { id: 3, client_key: 'hassan_x', checkin_ts: 'c', created_at: iso(now - 1 * DAY), sent_at: iso(now - 3600e3) },
    { id: 4, client_key: 'quiet_q', checkin_ts: 'd', created_at: iso(now - 40 * DAY), sent_at: null });
  const pageHits = [];
  const down = new Set(opts.down ?? []);
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://omarsoubra.github.io/DASHBOARD/clients/')) {
      eq(init.method, 'HEAD', 'page check is HEAD');
      const k = String(url).split('/')[5]; pageHits.push(k);
      return new Response(null, { status: down.has(k) ? 404 : 200 });
    }
    return w.svc.fetchImpl(url, init);
  };
  const logs = [];
  const handle = H.makePushHandler({ admin: w.db.admin, env: w.env, fetchImpl, now: () => w.clock.now, log: (...a) => logs.push(a.join(' | ')) });
  const responses = [];
  async function call(body, headers = {}) {
    const r = await handle(new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: JSON.stringify(body) }));
    const text = await r.text(); responses.push(text);
    return { status: r.status, j: JSON.parse(text) };
  }
  const tick = () => call({ type: 'pushTick' }, { 'x-push-cron-secret': CRON_SECRET });
  const coachSub = (s, tok = COACH_HASH) => call({ type: 'coachPushSubscribe', coachToken: tok, subscription: s.json, standalone: true });
  return Object.assign(w, { coachId, call, tick, coachSub, pageHits, logs, responses, zainId });
}

test('CM1 kind added by migration; template opens the coach dashboard; headline module is pure', async () => {
  assert(KINDS.includes('coach_morning'), 'coach_morning kind allowed');
  for (const k of ['test', 'weighin_reminder', 'checkin_reminder', 'program_update', 'training_reminder', 'meal_reminder']) assert(KINDS.includes(k), 'kept ' + k);
  eq(H.TEMPLATES.coach_morning.url, './coach_dashboard.html');
  const src = rd('supabase/functions/push/coach_morning.ts');
  assert(!/fetch\(|Deno\.|createClient/.test(src), 'coach_morning.ts does no I/O of its own');
});

test('CM2 coachPushSubscribe / coachPushStatus need the coach token; the device lands under _coach', async () => {
  const w = await coachWorld();
  const s = w.newSub('web.push.apple.com');
  eq((await w.coachSub(s, 'nope')).status, 401, 'bad coach token refused');
  eq((await w.call({ type: 'coachPushStatus', coachToken: 'nope' })).status, 401, 'status refused');
  const r = await w.coachSub(s);
  eq(r.status, 200); assert(r.j.created === true, 'created');
  const dev = w.db.T.push_devices.find((d) => d.client_id === w.coachId);
  assert(dev && dev.storage_key === '_coach' && dev.status === 'active', 'device under _coach');
  const st = await w.call({ type: 'coachPushStatus', coachToken: COACH_HASH, endpoint: s.json.endpoint });
  assert(st.j.registered === true && st.j.devices === 1 && typeof st.j.vapidPublicKey === 'string', 'status registered');
  eq((await w.coachSub(s)).j.created, false, 're-subscribe updates, no duplicate');
  eq(w.db.T.push_devices.filter((d) => d.client_id === w.coachId).length, 1);
  assert(!w.db.T.push_preferences.some((p) => p.client_id === w.coachId), 'no client preferences row: client reminders never target it');
  assertNoLeak(w);
});

test('CM3 a client endpoint is never moved to the coach', async () => {
  const w = await coachWorld();
  const s = w.newSub('web.push.apple.com');
  eq((await w.subscribe(s)).status, 200, 'canary subscribed as a client');
  eq((await w.coachSub(s)).status, 409, 'endpoint_conflict');
  assert(w.db.T.push_devices.every((d) => d.client_id !== w.coachId), 'nothing under _coach');
});

test('CM4 07:00 Sydney: one report with the card rules, delivered once; later ticks the same day are duplicates', async () => {
  const w = await coachWorld({ down: ['hassan_x'] });
  const s = w.newSub('web.push.apple.com');
  await w.coachSub(s);
  w.clock.now = at('2026-10-13', '06:45');
  eq((await w.tick()).j.summary.coachMorning, 'not_due', 'before 07:00');
  w.clock.now = at('2026-10-13', '07:00');
  const r = await w.tick();
  eq(r.j.summary.coachMorning, 'sent', JSON.stringify(r.j.summary));
  eq(w.svc.received.length, 1, 'one push');
  const p = w.svc.received[0].payload;
  eq(p.kind, 'coach_morning'); eq(p.title, 'This morning'); eq(p.url, './coach_dashboard.html');
  eq(p.body, 'PAGE DOWN: Hassan · unlock: Zain (P2) · 2 replies ready · 1 quiet (Quinn) · next wk unlock: 1 · 1 inactive 14d+');
  assert(!w.pageHits.includes('omar') && !w.pageHits.includes('revoked_r'), 'skipped accounts not checked');
  const ev = w.db.T.notification_events.find((e) => e.kind === 'coach_morning');
  eq(ev.dedupe_key, 'coach_morning:2026-10-13'); eq(ev.created_by, 'system'); eq(ev.status, 'sent');
  w.clock.now = at('2026-10-13', '07:15');
  eq((await w.tick()).j.summary.coachMorning, 'duplicate');
  w.clock.now = at('2026-10-13', '07:30');
  eq((await w.tick()).j.summary.coachMorning, 'not_due', 'window closed');
  eq(w.svc.received.length, 1, 'still one push');
  w.clock.now = at('2026-10-14', '07:00');
  eq((await w.tick()).j.summary.coachMorning, 'sent', 'next day sends again');
  assertNoLeak(w);
});

test('CM5 no device -> nothing claimed (a phone added at 07:10 still gets today\'s); no coach account -> silent', async () => {
  const w = await coachWorld();
  eq((await w.tick()).j.summary.coachMorning, 'no_device');
  eq(w.db.T.notification_events.filter((e) => e.kind === 'coach_morning').length, 0, 'nothing claimed');
  w.clock.now = at('2026-10-13', '07:10');
  await w.coachSub(w.newSub('fcm.googleapis.com'));
  eq((await w.tick()).j.summary.coachMorning, 'sent');
  const w2 = await coachWorld();
  w2.db.T.clients = w2.db.T.clients.filter((c) => c.storage_key !== '_coach');
  eq((await w2.tick()).j.summary.coachMorning, 'no_coach_account');
});

test('CM6 all clear; a failing read is contained (client reminders still run)', async () => {
  const w = await coachWorld({ roster: [{ storageKey: 'calm', displayName: 'Calm C', startDate: '2026-10-05' }] });
  await w.coachSub(w.newSub('web.push.apple.com'));
  w.db.T.weight_logs.push({ id: 9, client_key: 'calm', logged_at: iso(w.clock.now - 3600e3), weight_kg: 70 });
  w.db.T.checkin_drafts = [];
  await w.tick();
  eq(w.svc.received[0].payload.body, 'All clear - nothing extra today');
  const w2 = await coachWorld();
  await w2.coachSub(w2.newSub('web.push.apple.com'));
  w2.db.fail.on = 'roster_snapshots';
  const r = await w2.tick();
  eq(r.status, 200, 'tick still answers');
  eq(r.j.summary.coachMorning, 'error');
  eq(w2.svc.received.length, 0, 'nothing sent on a failed read');
});

test('CM7 headline rules (pure)', async () => {
  const M = CM;
  eq(M.programWeek('2026-10-12', '2026-10-12'), 1); eq(M.programWeek('2026-10-12', '2026-10-18'), 1); eq(M.programWeek('2026-10-12', '2026-10-19'), 2);
  eq(M.programWeek('2026-10-20', '2026-10-13'), null); eq(M.programWeek(null, '2026-10-13'), null);
  assert(!M.isActiveRosterClient({ storageKey: '_push_canary' }) && !M.isActiveRosterClient({ storageKey: 'omar' }), 'skips');
  assert(!M.isActiveRosterClient({ storageKey: 'a', programStatus: 'archived' }) && !M.isActiveRosterClient({ storageKey: 'a', isPaused: true }), 'inactive');
  const many = Array.from({ length: 6 }, (_, i) => ({ storageKey: 'k' + i, displayName: 'N' + i, startDate: '2026-09-15' }));
  const h = M.coachMorningHeadline({ roster: many, lastActivityMs: {}, repliesReady: 1, pagesDown: [], today: '2026-10-13', nowMs: 0 });
  eq(h.body, 'unlock: N0 (P2), N1 (P2), N2 (P2), N3 (P2)… · 1 reply ready');
  assert(h.body.length <= 220, 'bounded');
});

run('push_coach_morning');
