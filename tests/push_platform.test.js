// PUSH IN COACH PLATFORM MODE (PUSH_PLATFORM=1, the Drafted deployment only) - the real push handler on the strict harness DB.
//   every client belongs to a coach · a coach signs in with their own session and has their own phones · a client's
//   notification wears their coach's brand, never LOCKED IN's · a check-in reaches that client's coach and nobody else
//   · LOCKED IN's one coach token opens nothing here. With the flag off nothing changes (the other push suites prove that).
const nodeCrypto = require('crypto');
const { H, SCH, SCHEMA, test, assert, eq, run, COACH_HASH, CRON_SECRET, world, sha256hex } = require('./push_harness');

const TZ = 'Australia/Sydney';
const at = (date, hhmm) => SCH.zonedTimeToUtc(date, SCH.parseTime(hhmm), TZ);
const iso = (ms) => new Date(ms).toISOString();
const SUN = '2026-10-11';

// the tables and columns the platform adds (migration 20261124120000_coach_platform.sql)
SCHEMA.clients.add('coach_id'); SCHEMA.clients.add('profile_id');
SCHEMA.coaches = new Set(['id', 'slug', 'name', 'brand', 'status', 'accent']);
SCHEMA.coach_sessions = new Set(['id', 'coach_id', 'token_hash', 'expires_at', 'revoked_at']);
SCHEMA.profiles = new Set(['id', 'role', 'full_name']);

async function platform(opts = {}) {
  const w = await world({ now: opts.now ?? at(SUN, '09:05'), allowed: [] });
  const T = w.db.T;
  T.coaches = T.coaches || []; T.coach_sessions = T.coach_sessions || []; T.profiles = T.profiles || [];
  const mkCoach = (slug, name, brand, status = 'active') => {
    const id = w.db.uuid(), session = 'sess_' + slug + '_' + nodeCrypto.randomBytes(24).toString('hex');
    T.coaches.push({ id, slug, name, brand, status, accent: null });
    T.coach_sessions.push({ id: w.db.uuid(), coach_id: id, token_hash: sha256hex(session), expires_at: iso(w.clock.now + 30 * 86400000), revoked_at: null });
    return { id, slug, session };
  };
  const A = mkCoach('iron', 'Sam Stone', 'Iron Method'), B = mkCoach('other', 'Bea Other', 'Other Gym'), Z = mkCoach('gone', 'Zed Gone', 'Gone Gym', 'suspended');
  const mkClient = (key, name, coachId) => {
    const id = w.db.uuid(), token = 'tok_' + key + '_' + nodeCrypto.randomBytes(16).toString('hex'), salt = 's' + nodeCrypto.randomBytes(6).toString('hex');
    T.clients.push({ id, storage_key: key, display_name: name, is_paused: false, start_date: null, is_internal: true, entitlement_legacy: false, coach_id: coachId, profile_id: w.db.uuid() });
    T.client_sessions.push({ client_id: id, storage_key: key, token_hash: sha256hex(token + salt), salt, access_status: 'active' });
    return { id, key, token };
  };
  const a1 = mkClient('c_iron_ann_lee', 'Ann Lee', A.id), b1 = mkClient('c_other_bob_ray', 'Bob Ray', B.id), z1 = mkClient('c_gone_zoe_kay', 'Zoe Kay', Z.id);
  const logs = [];
  const handle = H.makePushHandler({ admin: w.db.admin, env: { ...w.env, platform: true, checkinSequence: undefined, dailyReminders: undefined },
    fetchImpl: w.svc.fetchImpl, now: () => w.clock.now, log: (...a) => logs.push(a.join(' | ')) });
  async function call(body, headers = {}) {
    const r = await handle(new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, j: JSON.parse(await r.text()) };
  }
  const tick = () => call({ type: 'pushTick' }, { 'x-push-cron-secret': CRON_SECRET });
  const coachSub = (coach, s) => call({ type: 'coachPushSubscribe', coachToken: coach.session, subscription: s.json, standalone: true });
  const clientSub = (c, s) => call({ type: 'pushSubscribe', storageKey: c.key, token: c.token, subscription: s.json, timezone: TZ, standalone: true });
  let rid = 0;
  const send = (coach, c) => call({ type: 'coachPushSend', coachToken: coach.session, storageKey: c.key, template: 'test', requestId: 'req_' + String(++rid).padStart(6, '0') + '_abc' });
  return Object.assign(w, { A, B, Z, a1, b1, z1, call, tick, coachSub, clientSub, send, logs });
}
const sentTo = (w, sub) => w.svc.received.filter((r) => r.url === sub.json.endpoint);

test('PL1 LOCKED IN\'s coach token and junk open nothing in platform mode', async () => {
  const w = await platform();
  const s = w.newSub();
  for (const tok of [COACH_HASH, 'x'.repeat(60), '', null]) {
    eq((await w.call({ type: 'coachPushStatus', coachToken: tok })).status, 401, 'status refused');
    eq((await w.call({ type: 'coachPushSubscribe', coachToken: tok, subscription: s.json })).status, 401, 'subscribe refused');
    eq((await w.call({ type: 'coachPushSend', coachToken: tok, storageKey: w.a1.key, template: 'test', requestId: 'req_000001_abc' })).status, 401, 'send refused');
    eq((await w.call({ type: 'coachAlert', coachToken: tok, kind: 'handoff', requestId: 'req_000002_abc' })).status, 401, 'alert refused');
  }
  eq(w.db.T.push_devices.length, 0, 'no device stored');
});

test('PL2 each coach has their own device account: made on first subscribe, never a client of anyone', async () => {
  const w = await platform();
  const st0 = await w.call({ type: 'coachPushStatus', coachToken: w.A.session });
  assert(st0.j.ok && st0.j.registered === false && st0.j.devices === 0 && st0.j.vapidPublicKey, 'status before any phone');
  assert(!w.db.T.clients.some((c) => c.storage_key === '_coach_iron'), 'looking does not create the account');
  const sa = w.newSub(), sb = w.newSub();
  assert((await w.coachSub(w.A, sa)).j.ok, 'coach A subscribes');
  assert((await w.coachSub(w.B, sb)).j.ok, 'coach B subscribes');
  const accA = w.db.T.clients.find((c) => c.storage_key === '_coach_iron'), accB = w.db.T.clients.find((c) => c.storage_key === '_coach_other');
  assert(accA && accB && accA.id !== accB.id, 'two accounts');
  assert(!accA.coach_id && accA.is_internal === true, 'the account is nobody\'s client');
  eq(w.db.T.push_devices.filter((d) => d.client_id === accA.id).length, 1, 'A has one phone');
  eq(w.db.T.push_devices.find((d) => d.client_id === accA.id).storage_key, '_coach_iron', 'stored under A\'s account');
  const st = await w.call({ type: 'coachPushStatus', coachToken: w.A.session, endpoint: sa.json.endpoint });
  assert(st.j.registered === true && st.j.devices === 1, 'A sees their phone');
  const cross = await w.call({ type: 'coachPushStatus', coachToken: w.B.session, endpoint: sa.json.endpoint });
  assert(cross.j.registered === false, 'B does not see A\'s phone as theirs');
  eq((await w.coachSub(w.B, sa)).status, 409, 'B cannot take over A\'s phone');
  eq((await w.coachSub(w.Z, w.newSub())).status, 401, 'a suspended coach cannot subscribe');
});

test('PL3 a coach\'s client can turn reminders on; a client with no coach, or a suspended coach, cannot', async () => {
  const w = await platform();
  assert((await w.call({ type: 'pushStatus', storageKey: w.a1.key, token: w.a1.token })).j.ok, 'coach A\'s client is eligible');
  eq((await w.call({ type: 'pushStatus', storageKey: w.z1.key, token: w.z1.token })).status, 403, 'suspended coach: no push');
  eq((await w.call({ type: 'pushStatus', storageKey: 'zac', token: 'nope' })).j.ok, false, 'a row with no coach is not a platform client');
  eq((await w.call({ type: 'pushStatus', storageKey: w.a1.key, token: w.b1.token })).j.ok, false, 'another client\'s token opens nothing');
  w.db.T.client_sessions.find((s) => s.storage_key === w.a1.key).access_status = 'suspended';
  eq((await w.call({ type: 'pushStatus', storageKey: w.a1.key, token: w.a1.token })).j.ok, false, 'paused access: no push');
});

test('PL4 a test notification wears the coach\'s brand, and a coach cannot send to another coach\'s client', async () => {
  const w = await platform();
  const s = w.newSub();
  assert((await w.clientSub(w.a1, s)).j.ok, 'client subscribes');
  const r = await w.send(w.A, w.a1);
  assert(r.j.ok && r.j.status === 'sent', 'A sends to their own client: ' + JSON.stringify(r.j));
  const got = sentTo(w, s);
  eq(got.length, 1, 'one push');
  eq(got[0].payload.title, 'Iron Method', 'the coach\'s brand is the title');
  assert(!/LOCKED IN|Omar|\bbro\b/.test(JSON.stringify(got[0].payload)), 'nothing of LOCKED IN in the payload');
  eq((await w.send(w.B, w.a1)).status, 404, 'B cannot reach A\'s client');
  eq(sentTo(w, s).length, 1, 'and nothing more was sent');
});

test('PL5 the weekly check-in reminder goes out in the coach\'s brand', async () => {
  const w = await platform({ now: at(SUN, '09:05') });
  const s = w.newSub();
  assert((await w.clientSub(w.a1, s)).j.ok, 'client subscribes');
  const r = await w.tick();
  assert(r.j.ok, 'tick ok: ' + JSON.stringify(r.j));
  const got = sentTo(w, s).filter((x) => x.payload.tag === 'li-checkin');
  eq(got.length, 1, 'one check-in reminder');
  eq(got[0].payload.title, 'Iron Method', 'brand title');
  assert(!/LOCKED IN|Omar|\bbro\b/.test(JSON.stringify(got[0].payload)), 'no LOCKED IN wording');
  eq(r.j.summary.coachMorning, 'off', 'no morning report in platform mode');
  await w.tick();
  eq(sentTo(w, s).filter((x) => x.payload.tag === 'li-checkin').length, 1, 'never twice');
});

test('PL6 a new check-in reaches that client\'s coach only', async () => {
  const w = await platform({ now: at('2026-10-13', '12:00') });
  const sa = w.newSub(), sb = w.newSub();
  await w.coachSub(w.A, sa); await w.coachSub(w.B, sb);
  w.db.T.check_ins.push({ id: w.db.uuid(), client_id: w.a1.id, client_key: w.a1.key, submitted_at: iso(w.clock.now - 20 * 60000), week_number: 2 });
  const r = await w.tick();
  eq(r.j.summary.coachCheckins, 'sent:1', 'one alert');
  const toA = sentTo(w, sa), toB = sentTo(w, sb);
  eq(toA.length, 1, 'coach A is told'); eq(toB.length, 0, 'coach B is not');
  eq(toA[0].payload.title, 'Ann just checked in', 'a first name and nothing else');
  eq(toA[0].payload.url, './dashboard.html', 'opens the coach\'s dashboard');
  await w.tick();
  eq(sentTo(w, sa).length, 1, 'once per client per day');
  w.db.T.check_ins.push({ id: w.db.uuid(), client_id: w.z1.id, client_key: w.z1.key, submitted_at: iso(w.clock.now - 5 * 60000), week_number: 1 });
  eq((await w.tick()).j.summary.coachCheckins, 'sent:0', 'a suspended coach gets nothing');
});

test('PL7 the wording rules: brand for LOCKED IN, the coach\'s first name for Omar, no slang', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'supabase', 'functions', 'push', 'handler.ts'), 'utf8');
  const m = src.match(/const say = \(t: string\) => ([\s\S]*?);\n/);
  assert(m, 'the wording function is where the test expects it');
  const say = new Function('brand', 'first', 't', 'return ' + m[1].replace(/^t\./, 't.') + ';');
  for (const [k, tpl] of Object.entries(H.TEMPLATES)) {
    const out = say('Iron Method', 'Sam', tpl.title) + ' | ' + say('Iron Method', 'Sam', tpl.body);
    assert(!/LOCKED IN|Omar|\bbro\b/.test(out), k + ' still has LOCKED IN wording: ' + out);
  }
  eq(say('Iron Method', 'Sam', H.TEMPLATES.weighin_reminder.body), "Morning. Log your weight when you're up.", 'weigh-in copy');
  eq(say('Iron Method', 'Sam', H.TEMPLATES.checkin_followup.body), 'Your check-in is still waiting. Get it done tonight so Sam can review your week.', 'follow-up copy');
  eq(say('Iron Method', 'Sam', H.TEMPLATES.meal_slot.body), 'Your planned meal is ready in your app.', 'meal copy');
});

test('PL8 the plan builder can report a page\'s facts and announce an update with its own key; nobody else can', async () => {
  const BK = 'builder_' + nodeCrypto.randomBytes(24).toString('hex');
  const w = await platform({ now: at('2026-10-13', '12:00') });
  const handle = H.makePushHandler({ admin: w.db.admin, env: { ...w.env, platform: true, builderKeySha256: sha256hex(BK), dailyReminders: { all: true, keys: new Set() } },
    fetchImpl: w.svc.fetchImpl, now: () => w.clock.now, log: () => {} });
  const post = async (body, headers) => { const r = await handle(new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: JSON.stringify(body) })); return { status: r.status, j: JSON.parse(await r.text()) }; };
  const facts = { meal_facts_status: 'consistent', meal_slot_count: 4, served_sha256: 'a'.repeat(64), meal_plan_sig: 'b'.repeat(64), has_workout_completion: true, schedule: null, schedule_sig: null,
                  training_days_per_week: 4, meal_lunch_time: '12:30', meal_dinner_time: '18:30' };
  const body = { type: 'planFactsSync', storageKey: w.a1.key, facts, commit: null };
  eq((await post(body, {})).status, 401, 'no key');
  eq((await post(body, { 'x-builder-key': 'x'.repeat(48) })).status, 401, 'wrong key');
  const ok = await post(body, { 'x-builder-key': BK });
  assert(ok.j.ok, 'the builder syncs facts: ' + JSON.stringify(ok.j));
  eq(w.db.T.push_plan_facts.filter((f) => f.storage_key === w.a1.key).length, 1, 'facts stored for the client');
  const s = w.newSub();
  const sub = await post({ type: 'pushSubscribe', storageKey: w.a1.key, token: w.a1.token, subscription: s.json, timezone: TZ, standalone: true }, {});
  assert(sub.j.ok, 'client subscribes');
  const up = await post({ type: 'programUpdated', storageKey: w.a1.key, deployHash: 'c'.repeat(64), commit: null }, { 'x-builder-key': BK });
  assert(up.j.ok, 'the builder announces an update: ' + JSON.stringify(up.j));
  const got = sentTo(w, s).filter((x) => x.payload.tag === 'li-program');
  eq(got.length, 1, 'the client is told once'); eq(got[0].payload.title, 'Iron Method', 'in the coach\'s brand');
  // and without platform mode the builder key opens nothing
  const plain = H.makePushHandler({ admin: w.db.admin, env: { ...w.env, builderKeySha256: sha256hex(BK) }, fetchImpl: w.svc.fetchImpl, now: () => w.clock.now, log: () => {} });
  const r = await plain(new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-builder-key': BK }, body: JSON.stringify(body) }));
  eq(r.status, 401, 'LOCKED IN mode ignores the builder key');
});

run('push_platform');
