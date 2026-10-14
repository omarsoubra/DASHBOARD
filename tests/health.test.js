// APPLE HEALTH V1 (Omar 2026-10-14) — the real api source for the health actions against an in-memory DB.
//   coach issues a key (only its hash stored) · nothing uploads before consent · the key writes only its own client's
//   day · a missing value never erases one · junk / out-of-range values refused · rate limit · a replaced key dies ·
//   client switch-off revokes + deletes; coach revoke keeps data · only the coach reads
const ts = require('typescript');
const fs = require('fs');
const nodeCrypto = require('crypto');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const i = SRC.indexOf('const HEALTH_CONSENT_VERSION'), j = SRC.indexOf('async function registryGetPrivate');
if (i < 0 || j < 0) throw new Error('locate health handlers');
const js = ts.transpileModule(SRC.slice(i, j), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const T = { clients: [{ id: 'c1', storage_key: 'bishoy_shaker', display_name: 'Bishoy Shaker' }, { id: 'c2', storage_key: 'zain_hussein', display_name: 'Zain Hussein' }],
            health_keys: [], health_daily: [], workout_completions: [], workout_log_entries: [], weight_logs: [], meal_logs: [], checkin_drafts: [], check_ins: [] };
let seq = 0;
function from(t) {
  const q = { f: [], isn: [], gte: null, mode: 'select', payload: null, single: false, order: null, lim: null, ret: false };
  const rows = () => T[t].filter((r) => q.f.every(([c, v]) => r[c] === v) && q.isn.every(([c, v]) => (r[c] ?? null) === v) && (!q.gte || r[q.gte[0]] >= q.gte[1]) && (!q.inn || q.inn[1].includes(r[q.inn[0]])) && (!q.neq || r[q.neq[0]] !== q.neq[1]) && (!q.notnull || r[q.notnull] != null));
  const b = {
    select: () => { q.ret = true; return b; }, eq: (c, v) => { q.f.push([c, v]); return b; }, is: (c, v) => { q.isn.push([c, v]); return b; },
    gte: (c, v) => { q.gte = [c, v]; return b; }, not: (c, op, v) => { q.notnull = c; return b; }, in: (c, vs) => { q.inn = [c, vs]; return b; }, neq: (c, v) => { q.neq = [c, v]; return b; }, order: (c, o) => { q.order = [c, o.ascending]; return b; }, limit: (n) => { q.lim = n; return b; },
    maybeSingle: () => { q.single = true; return b; },
    insert: (o) => { q.mode = 'insert'; q.payload = o; return b; }, update: (o) => { q.mode = 'update'; q.payload = o; return b; }, delete: () => { q.mode = 'delete'; return b; },
    then: (res) => {
      if (q.mode === 'insert') {
        const r = Object.assign({ id: ++seq }, q.payload);
        if (t === 'health_keys' && T[t].some((x) => x.key_hash === r.key_hash)) return res({ data: null, error: { message: 'dup' } });
        if (t === 'health_daily' && T[t].some((x) => x.client_id === r.client_id && x.day === r.day)) return res({ data: null, error: { message: 'dup' } });
        T[t].push(r); return res({ data: r, error: null });
      }
      if (q.mode === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, q.payload)); return res({ data: hit, error: null }); }
      if (q.mode === 'delete') { const hit = rows(); T[t] = T[t].filter((r) => !hit.includes(r)); return res({ data: hit, error: null }); }
      let out = rows().slice();
      if (q.order) out.sort((a, z) => (a[q.order[0]] < z[q.order[0]] ? -1 : 1) * (q.order[1] ? 1 : -1));
      if (q.lim) out = out.slice(0, q.lim);
      return res({ data: q.single ? (out[0] ?? null) : out, error: null });
    },
  };
  return b;
}
const admin = { from };
const json = (o) => { const r = new Response(JSON.stringify(o)); r.__body = o; return r; };
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const sha256 = async (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const M = {};
const verifyClientToken = async (tok, key) => tok === 'tok-' + String(key).toLowerCase() ? { ok: true, storageKey: String(key).toLowerCase() } : { ok: false, reason: 'bad_token' };
const ENTITLED = new Set(['bishoy_shaker', 'zain_hussein']);
const requireCapability = async (k) => ENTITLED.has(k) ? { ok: true } : { ok: false, reason: 'forbidden_tier' };
const capabilityDenied = (r) => err(r || 'forbidden_tier');
new Function('admin', 'ok', 'err', 'verifyCoachToken', 'verifyClientToken', 'requireCapability', 'capabilityDenied', 'logEfError', 'CI_KEY_RE', 'sha256', 'crypto', 'exports',
  js + '\nObject.assign(exports, { healthKeyIssue, healthStatus, healthConsent, healthLog, healthRevoke, healthGet, healthSelfStatus, healthSelfConnect, healthSelfDisconnect, sydneyDate, HEALTH_CONSENT_VERSION, healthStepTarget, clientWeekGet, mondayOf });')(
  admin, ok, err, (t) => t === 'coach', verifyClientToken, requireCapability, capabilityDenied, () => {}, /^[a-z0-9_]{1,64}$/, sha256, globalThis.crypto, M);

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + JSON.stringify(d).slice(0, 300) : '')); } };
const B = (r) => r.__body;
(async () => {
  console.log('apple health');
  t('issue needs the coach token', B(await M.healthKeyIssue({ coachToken: 'x', storageKey: 'bishoy_shaker' })).error === 'unauthorized');
  const iss = B(await M.healthKeyIssue({ coachToken: 'coach', storageKey: 'Bishoy_Shaker' }));
  const key = (iss.setupUrl || '').split('#k=')[1];
  t('issue returns a setup link with the key in the URL fragment; only its sha256 is stored',
    iss.ok && /^https:\/\/omarsoubra\.github\.io\/DASHBOARD\/health\/#k=lih_[0-9a-f]{40}$/.test(iss.setupUrl) && T.health_keys.length === 1
    && T.health_keys[0].key_hash === await sha256(key) && !JSON.stringify(T.health_keys).includes(key), iss);
  const st = B(await M.healthStatus({ healthKey: key }));
  t('status: first name only, not active yet', st.ok && st.firstName === 'Bishoy' && st.active === false && !('storageKey' in st), st);
  const today = M.sydneyDate(Date.now());
  t('no upload before consent', B(await M.healthLog({ healthKey: key, steps: 8000 })).error === 'consent_required');
  t('consent needs agree:true + the current version', B(await M.healthConsent({ healthKey: key, agree: true, version: 'old' })).error === 'consent_required');
  t('consent recorded', B(await M.healthConsent({ healthKey: key, agree: true, version: M.HEALTH_CONSENT_VERSION })).active === true && !!T.health_keys[0].consent_at);
  const l1 = B(await M.healthLog({ healthKey: key, steps: '8,432', activeKcal: '512.6', exerciseMin: 34, restingHr: '58', sleepHours: '7.5' }));
  const d1 = T.health_daily[0];
  t('Shortcut values parsed (commas, decimals, hours -> minutes) into today\'s row for THIS client',
    l1.ok && l1.day === today && d1.client_id === 'c1' && d1.steps === 8432 && d1.active_kcal === 513 && d1.exercise_min === 34 && d1.resting_hr === 58 && d1.sleep_min === 450, d1);
  await M.healthLog({ healthKey: key, steps: 9100 });
  t('a later run updates; a missing value never erases one', T.health_daily.length === 1 && T.health_daily[0].steps === 9100 && T.health_daily[0].sleep_min === 450, T.health_daily[0]);
  const ps = B(await M.healthLog({ healthKey: key, stepsList: '10\n20\n25\n15', stepsSources: "Omar's iPhone\nOmar's iPhone\nOmar's Apple Watch\nOmar's Apple Watch",
                                   activeList: '0.4\n0.6', activeSources: 'Watch\nWatch' }));
  t('reading lists: summed per source, largest source wins (no iPhone + Watch double count)',
    ps.ok && T.health_daily[0].steps === 40 && T.health_daily[0].active_kcal === 1 && ps.stepsBySource["Omar's iPhone"] === 30 && ps.stepsBySource["Omar's Apple Watch"] === 40, ps);
  t('out-of-range refused', B(await M.healthLog({ healthKey: key, steps: 999999 })).error === 'out_of_range');
  t('no values refused', B(await M.healthLog({ healthKey: key, steps: '' })).error === 'no_values');
  t('a date older than 7 days refused', B(await M.healthLog({ healthKey: key, date: '2020-01-01', steps: 5 })).error === 'bad_date');
  t('a bad key is refused', B(await M.healthLog({ healthKey: 'lih_' + '0'.repeat(40), steps: 5 })).error === 'invalid_key' && B(await M.healthLog({ healthKey: "x'; drop", steps: 5 })).error === 'invalid_key');
  T.health_keys[0].uploads_today = 60; T.health_keys[0].uploads_day = today;
  t('rate limit per day', B(await M.healthLog({ healthKey: key, steps: 5 })).error === 'rate_limited');
  T.health_keys[0].uploads_today = 0;
  t('only the coach reads', B(await M.healthGet({ coachToken: 'x' })).error === 'unauthorized');
  const g = B(await M.healthGet({ coachToken: 'coach', days: 7 }));
  t('coach read: rows + active status', g.ok && g.rows.length === 1 && g.status.bishoy_shaker.state === 'active', g);
  const iss2 = B(await M.healthKeyIssue({ coachToken: 'coach', storageKey: 'bishoy_shaker' })); const key2 = iss2.setupUrl.split('#k=')[1];
  t('a new key replaces the old one (old key dead, data kept)', B(await M.healthLog({ healthKey: key, steps: 5 })).error === 'invalid_key'
    && T.health_keys[0].revoked_by === 'replaced' && T.health_daily.length === 1);
  await M.healthConsent({ healthKey: key2, agree: true, version: M.HEALTH_CONSENT_VERSION });
  t('coach revoke stops uploads but keeps data', B(await M.healthRevoke({ coachToken: 'coach', storageKey: 'bishoy_shaker' })).revoked === true
    && B(await M.healthLog({ healthKey: key2, steps: 5 })).error === 'invalid_key' && T.health_daily.length === 1);
  const iss3 = B(await M.healthKeyIssue({ coachToken: 'coach', storageKey: 'bishoy_shaker' })); const key3 = iss3.setupUrl.split('#k=')[1];
  await M.healthConsent({ healthKey: key3, agree: true, version: M.HEALTH_CONSENT_VERSION });
  const z = B(await M.healthKeyIssue({ coachToken: 'coach', storageKey: 'zain_hussein' })).setupUrl.split('#k=')[1];
  await M.healthConsent({ healthKey: z, agree: true, version: M.HEALTH_CONSENT_VERSION });
  await M.healthLog({ healthKey: z, steps: 4000 });
  const off = B(await M.healthRevoke({ healthKey: key3, deleteData: true }));
  t('client switch-off: revoked + ALL their data deleted, nobody else\'s', off.revoked && off.deleted === 1 && T.health_daily.length === 1 && T.health_daily[0].client_id === 'c2', off);
  console.log('v4: two days of readings with start times');
  T.health_keys = []; T.health_daily = [];
  const k4 = B(await M.healthSelfConnect({ storageKey: 'zain_hussein', token: 'tok-zain_hussein', agree: true, version: M.HEALTH_CONSENT_VERSION })).healthKey;
  const syd = (daysAgo, hh) => { const d = new Date(Date.now() - daysAgo * 864e5); const ymd = d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); return ymd + 'T' + hh + ':00+11:00'; };
  const tdy = M.sydneyDate(Date.now()), yst = M.sydneyDate(Date.now() - 864e5);
  // yesterday: Garmin 9000 total (two readings) vs iPhone 4000; plus a late 21:40 walk the 9pm sync missed. Today: Garmin 300.
  const v4 = B(await M.healthLog({ healthKey: k4,
    stepsList: ['5000', '3500', '500', '4000', '300'].join('\n'),
    stepsSources: ["Zain's Garmin", "Zain's Garmin", "Zain's Garmin", "Zain's iPhone", "Zain's Garmin"].join('\n'),
    stepsDates: [syd(1, '09:00'), syd(1, '18:00'), syd(1, '21:40'), syd(1, '12:00'), syd(0, '07:10')].join('\n') }));
  const rowY = T.health_daily.find((r) => r.day === yst), rowT = T.health_daily.find((r) => r.day === tdy);
  t('each reading lands on its own Sydney day; yesterday gets its FINAL total (incl. after 9pm); largest device wins',
    v4.ok && rowY && rowY.steps === 9000 && rowT && rowT.steps === 300, { v4, rowY, rowT });
  t('per-device totals are kept (who wears what)', rowY.sources && rowY.sources.steps["Zain's Garmin"] === 9000 && rowY.sources.steps["Zain's iPhone"] === 4000, rowY && rowY.sources);
  // the next run (rolling 24 h) re-sends two of yesterday's readings plus a 23:00 walk nobody had sent yet
  await M.healthLog({ healthKey: k4, stepsList: '500\n3500\n700', stepsSources: "Zain's Garmin\nZain's Garmin\nZain's Garmin", stepsDates: [syd(1, '21:40'), syd(1, '18:00'), syd(1, '23:00')].join('\n') });
  t('a later run completes yesterday: re-sent readings count once, the late 23:00 walk is added (9,700)', T.health_daily.filter((r) => r.day === yst).length === 1 && T.health_daily.find((r) => r.day === yst).steps === 9700, T.health_daily.find((r) => r.day === yst));
  t('readings older than 7 days are ignored', B(await M.healthLog({ healthKey: k4, stepsList: '10', stepsSources: 'x', stepsDates: '2020-01-01T10:00:00+11:00' })).error === 'no_values');
  // the 3-day window's OLDEST day arrives cut part-way: it must never lower a finished day
  await M.healthLog({ healthKey: k4, stepsList: '5000', stepsSources: "Zain's Garmin", stepsDates: syd(1, '09:00') });
  t('a slice holding only part of a day never lowers it (readings are merged, not replaced)', T.health_daily.find((r) => r.day === yst).steps === 9700);
  // iOS caps one send at ~100 Health items: the Shortcut sends the newest 90 and the oldest 90; overlap counts once
  const many = Array.from({ length: 150 }, (_, i) => ({ v: 10, d: new Date(Date.parse(syd(0, '00:30')) + i * 5 * 60000).toISOString().replace('Z', '+00:00') }));
  const slice = (xs) => ({ healthKey: k4, stepsList: xs.map((x) => x.v).join('\n'), stepsSources: xs.map(() => "Zain's Apple Watch").join('\n'), stepsDates: xs.map((x) => x.d).join('\n') });
  await M.healthLog(slice(many.slice(0, 90))); await M.healthLog(slice(many.slice(60)));
  t('newest-90 + oldest-90 slices of a 150-reading day: 1,500 steps, the 30 overlapping readings once', T.health_daily.find((r) => r.day === tdy).sources.steps["Zain's Apple Watch"] === 1500, T.health_daily.find((r) => r.day === tdy).sources.steps);
  // sleep, in the exact format iOS 26 Shortcuts writes (read back from Omar's Garmin data 2026-10-14): one long In Bed,
  // then stages. Last night 22:40 -> 06:40 in bed; asleep = 22:41-01:00 + 01:30-06:30 (a 30-min Awake gap) = 7h19m.
  const night = [['In Bed', syd(1, '22:40'), syd(0, '06:40')], ['Core', syd(1, '22:41'), syd(1, '23:30')], ['Deep', syd(1, '23:30'), syd(0, '00:20')],
    ['REM', syd(0, '00:20'), syd(0, '01:00')], ['Awake', syd(0, '01:00'), syd(0, '01:30')], ['Core', syd(0, '01:30'), syd(0, '06:30')],
    ['Core', syd(0, '02:00'), syd(0, '03:00')]];   // a second device overlapping: merged, not added twice
  const sl = B(await M.healthLog({ healthKey: k4, sleepValues: night.map((x) => x[0]).join('\n'), sleepStarts: night.map((x) => x[1]).join('\n'),
    sleepEnds: night.map((x) => x[2]).join('\n'), exerciseList: '12\n20', exerciseSources: "Zain's Apple Watch\nZain's Apple Watch",
    exerciseDates: [syd(0, '07:00'), syd(0, '08:00')].join('\n'), restingHr: '54', restingHrDate: syd(0, '06:00') }));
  const rs = T.health_daily.find((r) => r.day === tdy);
  t('sleep: time asleep (no In Bed, no Awake, overlaps merged) lands on the day you wake up', sl.ok && rs.sleep_min === 439, { sl, rs });
  t('sleep stages kept for the coach (deep / REM / core / awake minutes)', rs.sources.sleep && rs.sources.sleep.deep === 50 && rs.sources.sleep.rem === 40 && rs.sources.sleep.awake === 30, rs.sources);
  t('exercise minutes + resting heart rate on their own day; earlier steps on that day untouched', rs.exercise_min === 32 && rs.resting_hr === 54 && rs.steps === 1500, rs);
  await M.healthLog({ healthKey: k4, sleepValues: 'Core', sleepStarts: syd(0, '05:00'), sleepEnds: syd(0, '06:30') });
  t('a cut-off night re-sent later never lowers sleep', T.health_daily.find((r) => r.day === tdy).sleep_min === 439);
  t('a sleep stage longer than 16 h is ignored (bad data)', B(await M.healthLog({ healthKey: k4, sleepValues: 'Core', sleepStarts: syd(3, '00:00'), sleepEnds: syd(0, '00:00') })).error === 'no_values');
  const st4 = B(await M.healthSelfStatus({ storageKey: 'zain_hussein', token: 'tok-zain_hussein' }));
  t('self status reports when the phone last synced', st4.connected && !!st4.lastSyncAt, st4);

  console.log('step target');
  const ST = M.healthStepTarget;
  t('usual 6,200 -> target 7,500 (usual + 1,500, rounded to 500)', ST([6000, 6200, 6400, 6100, 6300, 6250, 6150]).steps === 7500);
  t('median, so one huge day does not move it', ST([6000, 6200, 30000, 6100, 6300, 6250, 6150]).steps === 7500);
  t('very low usual (2,500) -> floor 7,000', ST([2500, 2400, 2600, 2500, 2550, 2450, 2500]).steps === 7000);
  t('usual 11,000 -> capped at 12,000', ST(Array(7).fill(11000)).steps === 12000);
  t('already 14,200 a day -> keeps their own 14,000', ST(Array(10).fill(14200)).steps === 14000);
  t('fewer than 7 days of steps -> no target yet', ST([8000, 8000, 8000]) === null);
  t('only the FIRST 14 days count (later weeks never move it)', ST(Array(14).fill(8000).concat(Array(20).fill(2000))).steps === 9500);
  T.health_keys = []; T.health_daily = [];
  const tk = B(await M.healthSelfConnect({ storageKey: 'zain_hussein', token: 'tok-zain_hussein', agree: true, version: M.HEALTH_CONSENT_VERSION })).healthKey;
  const dd = (n) => M.sydneyDate(Date.now() - n * 864e5) + 'T12:00:00+11:00';
  for (let n = 9; n >= 1; n--) await M.healthLog({ healthKey: tk, stepsList: '8000', stepsSources: "Zain's iPhone", stepsDates: dd(n) });
  const s8 = B(await M.healthSelfStatus({ storageKey: 'zain_hussein', token: 'tok-zain_hussein' }));
  t('the app gets the target (healthSelfStatus.stepTarget)', s8.stepTarget && s8.stepTarget.steps === 9500 && s8.stepTarget.baseline === 8000, s8.stepTarget);
  const g8 = B(await M.healthGet({ coachToken: 'coach' }));
  t('the coach dashboard gets every client\'s target (healthGet.targets)', g8.targets && g8.targets.zain_hussein && g8.targets.zain_hussein.steps === 9500, g8.targets);

  console.log('your week + from Omar');
  {
    const MON = M.mondayOf(Date.now()), D0 = Date.parse(MON + 'T12:00:00+11:00');      // this Monday, midday Sydney
    const at = (daysBeforeThisMon) => new Date(D0 - daysBeforeThisMon * 864e5).toISOString();
    // last week = 7..1 days before this Monday; the week before = 14..8
    T.workout_completions.push({ client_id: 'c2', completed_at: at(6), local_date: null, status: 'complete' }, { client_id: 'c2', completed_at: at(4), status: 'complete' },
      { client_id: 'c2', completed_at: at(2), status: 'complete' }, { client_id: 'c2', completed_at: at(10), status: 'complete' }, { client_id: 'c2', completed_at: at(3), status: 'revoked', revoked_at: at(3) },
      { client_id: 'c1', completed_at: at(3), status: 'complete' });
    T.workout_log_entries.push({ client_key: 'zain_hussein', logged_at: at(20), exercise_name: 'Back Squat', weight: '100kg' }, { client_key: 'zain_hussein', logged_at: at(3), exercise_name: 'Back Squat', weight: '105kg' },
      { client_key: 'zain_hussein', logged_at: at(20), exercise_name: 'Bench Press', weight: '80kg' }, { client_key: 'zain_hussein', logged_at: at(3), exercise_name: 'Bench Press', weight: '80kg' },
      { client_key: 'zain_hussein', logged_at: at(3), exercise_name: 'New Lift', weight: '40kg' });
    T.weight_logs.push({ client_key: 'zain_hussein', logged_at: at(5), weight_kg: 80.0 }, { client_key: 'zain_hussein', logged_at: at(2), weight_kg: 79.6 }, { client_key: 'zain_hussein', logged_at: at(10), weight_kg: 80.6 });
    T.meal_logs.push({ client_id: 'c2', logged_at: at(5) }, { client_id: 'c2', logged_at: at(5) }, { client_id: 'c2', logged_at: at(3) }, { client_id: 'c2', logged_at: at(9) });
    T.checkin_drafts.push({ client_key: 'zain_hussein', checkin_ts: '2026-10-12T09:00:00.000Z', draft: 'Zain, solid week. Keep the steps up.', sent_at: at(1) },
      { client_key: 'zain_hussein', checkin_ts: '2026-10-13T09:00:00.000Z', draft: 'Unsent draft', sent_at: null },
      { client_key: 'zain_hussein', checkin_ts: 'journey:offer:2026-06-01', draft: 'Block 2 offer', sent_at: at(1) },
      { client_key: 'bishoy_shaker', checkin_ts: '2026-10-12T09:00:00.000Z', draft: 'Bishoy only', sent_at: at(1) });
    t('your week: needs the client\'s own token', B(await M.clientWeekGet({ storageKey: 'zain_hussein', token: 'tok-bishoy_shaker' })).error === 'bad_token');
    const wk = B(await M.clientWeekGet({ storageKey: 'zain_hussein', token: 'tok-zain_hussein' }));
    t('your week: last full week Mon-Sun', wk.ok && wk.week.from < MON && wk.week.to < MON, wk.week);
    t('sessions 3 last week (revoked not counted, other clients not counted) vs 1 the week before', wk.sessions === 3 && wk.sessionsPrev === 1, { s: wk.sessions, p: wk.sessionsPrev });
    t('PRs: squat 105 over 100; bench equal is not a PR; a first-ever lift is not a PR', wk.prs.length === 1 && wk.prs[0].exercise === 'Back Squat' && wk.prs[0].kg === 105 && wk.prs[0].prev === 100, wk.prs);
    t('weight average 79.8 vs 80.6', wk.weightAvg === 79.8 && wk.weightAvgPrev === 80.6, { a: wk.weightAvg, p: wk.weightAvgPrev });
    t('meal days 2 vs 1', wk.mealDays === 2 && wk.mealDaysPrev === 1);
    t('from Omar: only replies he SENT, only check-in replies (no journey/sales), only this client', wk.feedback.length === 1 && wk.feedback[0].text === 'Zain, solid week. Keep the steps up.', wk.feedback);
    t('a client without an active coaching entitlement cannot read it', B(await M.clientWeekGet({ storageKey: 'lapsed_l', token: 'tok-lapsed_l' })).error === 'forbidden_tier');
  }

  console.log('in-app (client login)');
  T.health_keys = []; T.health_daily = [];
  t('self status needs the client\'s own token', B(await M.healthSelfStatus({ storageKey: 'bishoy_shaker', token: 'tok-zain_hussein' })).error === 'bad_token');
  t('not connected at first', B(await M.healthSelfStatus({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker' })).connected === false);
  t('connect needs agree + version', B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: 'x' })).error === 'consent_required');
  const sc = B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: M.HEALTH_CONSENT_VERSION }));
  t('connect: a consented key for THIS client, returned once, only its hash stored',
    /^lih_[0-9a-f]{40}$/.test(sc.healthKey) && T.health_keys.length === 1 && T.health_keys[0].client_id === 'c1' && !!T.health_keys[0].consent_at && !JSON.stringify(T.health_keys).includes(sc.healthKey), sc);
  t('the Shortcut can upload with it straight away', B(await M.healthLog({ healthKey: sc.healthKey, steps: 1234 })).ok === true);
  const ss = B(await M.healthSelfStatus({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker' }));
  t('self status: connected + today\'s row', ss.connected === true && ss.days.length === 1 && ss.days[0].steps === 1234, ss);
  const sc2 = B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: M.HEALTH_CONSENT_VERSION }));
  t('connecting again replaces the old key (old one dead)', B(await M.healthLog({ healthKey: sc.healthKey, steps: 5 })).error === 'invalid_key' && B(await M.healthLog({ healthKey: sc2.healthKey, steps: 5 })).ok);
  // Omar 2026-10-14: "Set it up" tapped twice - the Shortcut holds the FIRST code; it must keep working
  T.health_keys = []; T.health_daily = [];
  const dk1 = B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: M.HEALTH_CONSENT_VERSION })).healthKey;
  const dk2 = B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: M.HEALTH_CONSENT_VERSION })).healthKey;
  t('set-up tapped twice within 30 min: the first (unused) code still uploads', B(await M.healthLog({ healthKey: dk1, steps: 42 })).ok === true);
  t('... and the spare second code is then switched off (one working code per client)', B(await M.healthLog({ healthKey: dk2, steps: 1 })).error === 'invalid_key'
    && T.health_keys.filter((k) => k.client_id === 'c1' && !k.revoked_at).length === 1);
  T.health_keys.forEach((k) => { if (!k.revoked_at) k.created_at = new Date(Date.now() - 31 * 60000).toISOString(); k.last_used_at = null; });
  B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: M.HEALTH_CONSENT_VERSION }));
  t('an unused code older than 30 min is replaced by a new set-up', B(await M.healthLog({ healthKey: dk1, steps: 1 })).error === 'invalid_key');
  const zk = B(await M.healthSelfConnect({ storageKey: 'zain_hussein', token: 'tok-zain_hussein', agree: true, version: M.HEALTH_CONSENT_VERSION })).healthKey;
  await M.healthLog({ healthKey: zk, steps: 777 });
  const sd = B(await M.healthSelfDisconnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker' }));
  t('disconnect: own key revoked + own data deleted, nobody else\'s', sd.revoked && sd.deleted === 1 && T.health_daily.length === 1 && T.health_daily[0].client_id === 'c2'
    && B(await M.healthSelfStatus({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker' })).connected === false, sd);
  ENTITLED.delete('bishoy_shaker');
  t('a lapsed client cannot connect', B(await M.healthSelfConnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker', agree: true, version: M.HEALTH_CONSENT_VERSION })).error === 'forbidden_tier');
  t('... but can always stop sharing + delete', B(await M.healthSelfDisconnect({ storageKey: 'bishoy_shaker', token: 'tok-bishoy_shaker' })).revoked === true);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
