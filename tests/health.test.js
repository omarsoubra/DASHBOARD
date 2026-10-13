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
            health_keys: [], health_daily: [] };
let seq = 0;
function from(t) {
  const q = { f: [], isn: [], gte: null, mode: 'select', payload: null, single: false, order: null, lim: null, ret: false };
  const rows = () => T[t].filter((r) => q.f.every(([c, v]) => r[c] === v) && q.isn.every(([c, v]) => (r[c] ?? null) === v) && (!q.gte || r[q.gte[0]] >= q.gte[1]));
  const b = {
    select: () => { q.ret = true; return b; }, eq: (c, v) => { q.f.push([c, v]); return b; }, is: (c, v) => { q.isn.push([c, v]); return b; },
    gte: (c, v) => { q.gte = [c, v]; return b; }, order: (c, o) => { q.order = [c, o.ascending]; return b; }, limit: (n) => { q.lim = n; return b; },
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
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const sha256 = async (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const M = {};
new Function('admin', 'ok', 'err', 'verifyCoachToken', 'logEfError', 'CI_KEY_RE', 'sha256', 'crypto', 'exports',
  js + '\nObject.assign(exports, { healthKeyIssue, healthStatus, healthConsent, healthLog, healthRevoke, healthGet, sydneyDate, HEALTH_CONSENT_VERSION });')(
  admin, ok, err, (t) => t === 'coach', () => {}, /^[a-z0-9_]{1,64}$/, sha256, globalThis.crypto, M);

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
  t('out-of-range refused', B(await M.healthLog({ healthKey: key, steps: 999999 })).error === 'out_of_range');
  t('no values refused', B(await M.healthLog({ healthKey: key, steps: '' })).error === 'no_values');
  t('a date older than 7 days refused', B(await M.healthLog({ healthKey: key, date: '2020-01-01', steps: 5 })).error === 'bad_date');
  t('a bad key is refused', B(await M.healthLog({ healthKey: 'lih_' + '0'.repeat(40), steps: 5 })).error === 'invalid_key' && B(await M.healthLog({ healthKey: "x'; drop", steps: 5 })).error === 'invalid_key');
  T.health_keys[0].uploads_today = 30; T.health_keys[0].uploads_day = today;
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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
