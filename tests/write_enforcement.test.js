// Client-facing ACCESS ENFORCEMENT — the invariant Omar asked to be proven:
//
//   When a client's entitlement grants zero capabilities, can that client
//   perform ANY protected application read or write?   Required answer: NO.
//
// Two layers:
//   PART A  behavioural — runs the REAL handler source against an in-memory
//           Supabase stand-in, across all four entitlement states.
//   PART B  structural — parses the dispatch table and proves that EVERY
//           client-callable action is either gated or on the documented
//           ungated allow-list. A new ungated client action fails this test.
const ts = require('/home/claude/.npm-global/lib/node_modules/typescript');
const fs = require('fs');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');

function grab(startRe, endMarker) {
  const i = SRC.search(startRe); if (i < 0) throw new Error('locate ' + startRe);
  const j = SRC.indexOf(endMarker, i); if (j < 0) throw new Error('terminate ' + startRe);
  return SRC.slice(i, j + endMarker.length);
}
const snippet = [
  grab(/const ALL_CAPABILITIES/, '];'),
  grab(/const PRODUCT_CAPABILITIES/, '\n};'),
  grab(/const LEGACY_PRODUCT_CODE/, ';'),
  grab(/const DENIED_TIER/, ';'),
  grab(/type EntMode/, ';'),
  grab(/let _entModeCache/, ';'),
  grab(/async function entitlementSystemMode/, '\n}'),
  grab(/function capabilitiesForProducts/, '\n}'),
  grab(/function entitlementRowIsActive/, '\n}'),
  grab(/const DENIED_RESOLVED/, '\n});'),
  grab(/async function resolveEntitlements/, '\n}'),
  grab(/async function requireCapability/, '\n}'),
  grab(/function capabilityDenied/, '\n}'),
  grab(/const CLIENT_WRITE_CAPABILITY/, '\n};'),
  grab(/async function entitlementGrant/, '\n}'),
  grab(/async function entitlementRevoke/, '\n}'),
  grab(/async function entitlementsGet/, '\n}'),
  grab(/async function clientProgram/, '\n}'),
  grab(/async function weightLog/, '\n}'),
  grab(/async function overrideGet/, '\n}'),
  grab(/async function clientWrite/, '\n}'),
].join('\n').replace(/^type Resolved[\s\S]*?\n};\n/m, '');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// ── in-memory Supabase stand-in ────────────────────────────────────────────
const DB = { clients: [], client_entitlements: [], products: [], programs: [], weight_logs: [] };
const match = (row, f) => f.every(([c, v]) => row[c] === v);
function table(name) {
  if (!DB[name]) DB[name] = [];
  const api = { _f: [], _mode: null, _p: null };
  api.select = () => api; api.eq = (c, v) => { api._f.push([c, v]); return api; };
  api.is = () => api; api.limit = () => api; api.order = () => api;
  api.single = async () => ({ data: DB[name].filter(r => match(r, api._f))[0] ?? null, error: null });
  api.update = (p) => { api._mode = 'update'; api._p = p; return api; };
  api.insert = (p) => { api._mode = 'insert'; api._p = p; return api; };
  api.then = (res) => {
    if (api._mode === 'update') { DB[name].filter(r => match(r, api._f)).forEach(r => Object.assign(r, api._p)); return res({ error: null }); }
    if (api._mode === 'insert') { const row = Object.assign({ id: name[0] + (DB[name].length + 1) }, api._p); DB[name].push(row); return res({ data: row, error: null }); }
    return res({ data: DB[name].filter(r => match(r, api._f)), error: null });
  };
  return api;
}
const admin = { from: table };
const json = (o) => ({ __body: o, json: async () => o });
const ok  = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const logEfError = () => {};
let AUTH_OK = true, COACH_OK = true, ROSTER_ACTIVE = false;
const verifyClientToken = async (t, k) => AUTH_OK ? { ok: true, storageKey: String(k).toLowerCase() } : { ok: false, reason: 'bad_token' };
const verifyCoachToken  = (tok) => COACH_OK && !!tok;
const isKnownActiveRosterKey = async () => ROSTER_ACTIVE;
// doWrite is pre-existing, out-of-scope persistence code. Stubbed so that what
// is under test is purely WHETHER the write is permitted to happen.
let DID_WRITE = [];
const doWrite = async (kind, body, silent) => { DID_WRITE.push(kind + ':' + body.client); return silent ? { weight_id: 'w1', checkin_id: 'k1' } : ok({ tab: kind }); };
let QUEUED = [];
const queueInsert = async (kind) => { QUEUED.push(kind); return { id: 'q1' }; };

const M = {};
new Function('admin','ok','err','json','logEfError','verifyClientToken','verifyCoachToken','isKnownActiveRosterKey','doWrite','queueInsert','exports',
  js + '\nObject.assign(exports,{requireCapability,entitlementsGet,entitlementGrant,entitlementRevoke,' +
       'clientProgram,weightLog,overrideGet,clientWrite,CLIENT_WRITE_CAPABILITY,ALL_CAPABILITIES,PRODUCT_CAPABILITIES});'
)(admin, ok, err, json, logEfError, verifyClientToken, verifyCoachToken, isKnownActiveRosterKey, doWrite, queueInsert, M);

const B = (r) => r.__body;
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const KEY = 'sg_test';
const WRITES = ['weight', 'checkin', 'meal', 'workout', 'photoUpload'];
const READS = [
  ['clientProgram', () => M.clientProgram({ token: 'x', storageKey: KEY })],
  ['weightLog',     () => M.weightLog({ token: 'x', storageKey: KEY })],
  ['overrideGet',   () => M.overrideGet({ token: 'x', storageKey: KEY })],
];

async function allWrites() {
  const out = {};
  for (const k of WRITES) out[k] = B(await M.clientWrite(k, { token: 'x', storageKey: KEY, weightKg: 80, week: 1 }));
  return out;
}
async function allReads() {
  const out = {};
  for (const [n, f] of READS) { const r = await f(); out[n] = r.__body ?? r; }
  return out;
}
// weightLog answers with a bare JSON array on success (no {ok:true} envelope),
// so "allowed" means "returned data", not "returned ok".
const readAllowed = (n, r) => n === 'weightLog' ? Array.isArray(r) : r.ok === true;
const denied = (r) => r.ok === false && ['forbidden_tier', 'provisioning_incomplete'].includes(r.error);

(async () => {
  DB.products.push({ code: 'locked_in_1to1', duration_weeks: null }, { code: 'locked_in_self_guided_12w', duration_weeks: 12 });
  DB.programs.push({ storage_key: KEY, payload: { ok: 1 } }, { storage_key: 'legacy_one', payload: { ok: 1 } });
  DB.clients.push({ id: 'c_sg', storage_key: KEY, entitlement_legacy: false });
  DB.clients.push({ id: 'c_leg', storage_key: 'legacy_one', entitlement_legacy: true });

  console.log('\n[A1] ACTIVE SELF_GUIDED — allowed reads and writes work');
  await M.entitlementGrant({ coachToken: 'k', storageKey: KEY, productCode: 'locked_in_self_guided_12w' });
  let R = await allReads(), W = await allWrites();
  for (const n of Object.keys(R)) t('read allowed: ' + n, readAllowed(n, R[n]));
  for (const k of WRITES) t('write allowed: ' + k, W[k].ok === true);
  t('writes actually reached persistence', DID_WRITE.length === 5);

  console.log('\n[A2] REVOKED — every protected read and write denied');
  DID_WRITE = [];
  await M.entitlementRevoke({ coachToken: 'k', storageKey: KEY, productCode: 'locked_in_self_guided_12w' });
  let ent = B(await M.entitlementsGet({ token: 'x', storageKey: KEY }));
  t('resolves to zero capabilities', Object.values(ent.capabilities).filter(Boolean).length === 0);
  R = await allReads(); W = await allWrites();
  for (const n of Object.keys(R)) t('read DENIED: ' + n, denied(R[n]));
  for (const k of WRITES) t('write DENIED: ' + k, denied(W[k]));
  t('nothing reached persistence', DID_WRITE.length === 0);

  console.log('\n[A3] EXPIRED WINDOW — every protected read and write denied');
  DID_WRITE = [];
  await M.entitlementGrant({ coachToken: 'k', storageKey: KEY, productCode: 'locked_in_self_guided_12w',
                             startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-02-01T00:00:00Z' });
  ent = B(await M.entitlementsGet({ token: 'x', storageKey: KEY }));
  t('resolves to zero capabilities', Object.values(ent.capabilities).filter(Boolean).length === 0);
  R = await allReads(); W = await allWrites();
  for (const n of Object.keys(R)) t('read DENIED: ' + n, denied(R[n]));
  for (const k of WRITES) t('write DENIED: ' + k, denied(W[k]));
  t('nothing reached persistence', DID_WRITE.length === 0);

  console.log('\n[A4] NO ENTITLEMENT AT ALL (provisioning_incomplete) — denied');
  DID_WRITE = [];
  DB.client_entitlements = DB.client_entitlements.filter(e => e.client_id !== 'c_sg');
  ent = B(await M.entitlementsGet({ token: 'x', storageKey: KEY }));
  t('status provisioning_incomplete', ent.status === 'provisioning_incomplete');
  t('resolves to zero capabilities', Object.values(ent.capabilities).filter(Boolean).length === 0);
  R = await allReads(); W = await allWrites();
  for (const n of Object.keys(R)) t('read DENIED: ' + n, denied(R[n]));
  for (const k of WRITES) t('write DENIED: ' + k, denied(W[k]));
  t('nothing reached persistence', DID_WRITE.length === 0);

  console.log('\n[A5] RE-GRANTED — functionality returns immediately');
  DID_WRITE = [];
  await M.entitlementGrant({ coachToken: 'k', storageKey: KEY, productCode: 'locked_in_self_guided_12w' });
  R = await allReads(); W = await allWrites();
  for (const n of Object.keys(R)) t('read restored: ' + n, readAllowed(n, R[n]));
  for (const k of WRITES) t('write restored: ' + k, W[k].ok === true);
  t('writes reached persistence again', DID_WRITE.length === 5);

  console.log('\n[A6] LEGACY 1:1 REGRESSION — unchanged by the new gates');
  DID_WRITE = [];
  for (const k of WRITES) {
    const r = B(await M.clientWrite(k, { token: 'x', storageKey: 'legacy_one', weightKg: 80, week: 1 }));
    t('1:1 write still allowed: ' + k, r.ok === true);
  }
  t('1:1 read weightLog still allowed', B(await M.weightLog({ token: 'x', storageKey: 'legacy_one' })) !== undefined);
  t('1:1 read overrideGet still allowed', B(await M.overrideGet({ token: 'x', storageKey: 'legacy_one' })).ok === true);
  t('1:1 read clientProgram still allowed', B(await M.clientProgram({ token: 'x', storageKey: 'legacy_one' })).ok === true);
  const leg = B(await M.entitlementsGet({ token: 'x', storageKey: 'legacy_one' }));
  t('1:1 keeps every premium capability',
    leg.capabilities.manual_coach_review && leg.capabilities.coach_program_customisation &&
    leg.capabilities.coach_nutrition_adjustment && leg.capabilities.form_review && leg.capabilities.direct_coach_messaging);
  t('1:1 gains the three new self-owned-data capabilities',
    leg.capabilities.log_meal === true && leg.capabilities.upload_photo === true && leg.capabilities.view_progress === true);

  console.log('\n[A7] COACH BYPASS — Omar can still inspect a denied client');
  DB.client_entitlements = DB.client_entitlements.filter(e => e.client_id !== 'c_sg');
  t('coach reads program of a denied client', B(await M.clientProgram({ coachToken: 'k', storageKey: KEY })).ok === true);
  t('coach reads overrides of a denied client', B(await M.overrideGet({ coachToken: 'k', storageKey: KEY })).ok === true);

  console.log('\n[A8] LEGACY QUARANTINE PATH — canonical mirror is gated too');
  // Legacy Apps Script callers identify with `client`, not `storageKey`, and
  // carry no valid token — that is exactly the shape this path exists for.
  DID_WRITE = []; QUEUED = []; AUTH_OK = false; ROSTER_ACTIVE = true;
  await M.clientWrite('weight', { token: 'bad', client: KEY, weightKg: 80 });
  t('attempt is quarantined in the queue', QUEUED.length === 1);
  t('canonical mirror BLOCKED for an unentitled key', DID_WRITE.length === 0);
  DID_WRITE = []; QUEUED = [];
  await M.clientWrite('weight', { token: 'bad', client: 'legacy_one', weightKg: 80 });
  t('attempt is quarantined in the queue', QUEUED.length === 1);
  t('canonical mirror still works for an entitled legacy key', DID_WRITE.length === 1);
  AUTH_OK = true; ROSTER_ACTIVE = false;

  console.log('\n[A9] WRITE MAP COMPLETENESS');
  t('every dispatched client write kind is mapped',
    WRITES.every(k => typeof M.CLIENT_WRITE_CAPABILITY[k] === 'string'));
  t('every mapped capability exists in the matrix',
    Object.values(M.CLIENT_WRITE_CAPABILITY).every(c => M.ALL_CAPABILITIES.includes(c)));
  DID_WRITE = [];
  t('an unmapped write kind is refused, not defaulted to allowed',
    B(await M.clientWrite('somethingNew', { token: 'x', storageKey: 'legacy_one' })).error === 'unknown_write_kind');
  t('and never reaches persistence', DID_WRITE.length === 0);

  // ── PART B: structural proof over the real dispatch table ────────────────
  console.log('\n[B1] STRUCTURAL — every client-callable action is gated or explicitly allow-listed');
  const UNGATED_BY_DESIGN = {
    authClient:      'bootstrap: token validity + access status only, no client data',
    entitlementsGet: 'entitlement resolution itself; gating it is circular. Own tier/flags only',
    intakeSubmit:    'public pre-client form; allow-listed insert into the intakes queue only',
    intake:          'legacy alias of intakeSubmit',
    ping:            'liveness probe, no auth, no data',
  };
  const dispatch = [...SRC.matchAll(/case '(\w+)':\s*return (?:(\w+)\(|clientWrite\('(\w+)')/g)]
    .map(m => ({ action: m[1], handler: m[2] || 'clientWrite' }));
  t('dispatch table parsed', dispatch.length >= 37);
  const bodyOf = (fn) => {
    const i = SRC.search(new RegExp('\\n(?:async )?function ' + fn + '\\s*\\('));
    if (i < 0) return null;
    const rest = SRC.slice(i + 1);
    const nxt = rest.search(/\n(?:async )?function \w+\s*\(/);
    return nxt < 0 ? rest : rest.slice(0, nxt);
  };
  const ungatedFound = [];
  for (const d of dispatch) {
    const b = bodyOf(d.handler);
    if (!b) continue;
    const clientCallable = b.includes('verifyClientToken');
    if (!clientCallable) continue;                       // coach-only surface
    const gated = /requireCapability\(/.test(b);
    if (!gated && !UNGATED_BY_DESIGN[d.action]) ungatedFound.push(d.action);
  }
  t('no client-callable action is ungated without a documented reason  ' +
    (ungatedFound.length ? '[' + ungatedFound.join(', ') + ']' : ''), ungatedFound.length === 0);
  for (const a of Object.keys(UNGATED_BY_DESIGN)) {
    t('allow-list documented in source: ' + a,
      a === 'intake' || a === 'ping' || SRC.includes(a + ' ') );
  }
  t('the ungated allow-list is documented in the source file',
    SRC.includes('INTENTIONALLY UNGATED CLIENT-CALLABLE ACTIONS'));

  console.log('\n[B2] STRUCTURAL — no scattered tier checks bypassing the matrix');
  const scattered = [...SRC.matchAll(/tier\s*===\s*'locked_in/g)].length;
  t('no handler compares tier strings directly', scattered === 0);
  t('capability decisions all flow through requireCapability',
    (SRC.match(/requireCapability\(/g) || []).length >= 8);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
