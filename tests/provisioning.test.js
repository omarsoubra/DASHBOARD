// SELF-GUIDED entitlement enforcement — exercises the REAL handler source from
// supabase/functions/api/index.ts against an in-memory Supabase stand-in.
// Central invariant under test: a missing entitlement must NEVER grant premium
// to a client created after the entitlement cutover.
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
  grab(/async function entitlementsGet/, '\n}'),
  grab(/async function entitlementGrant/, '\n}'),
  grab(/async function entitlementRevoke/, '\n}'),
  grab(/async function provisionSelfGuidedClient/, '\n}'),
  grab(/async function coachReviewRequest/, '\n}'),
  grab(/async function clientProgram/, '\n}'),
].join('\n').replace(/^type Resolved[\s\S]*?\n};\n/m, '');

const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// ── in-memory Supabase stand-in ────────────────────────────────────────────
const DB = { clients: [], client_entitlements: [], products: [], programs: [] };
let TABLE_MISSING = false;      // simulate: migration not yet run
let ENT_INSERT_FAILS = false;   // simulate: entitlement write fails (FK violation, outage)
let DB_ERROR = false;           // simulate: transient backend failure
let writes = 0;
const match = (row, f) => f.every(([c, v]) => row[c] === v);
function table(name) {
  const api = { _f: [], _mode: null, _p: null };
  api.select = () => api;
  api.eq = (c, v) => { api._f.push([c, v]); return api; };
  api.is = () => api;
  api.limit = () => api;
  api.single = async () => {
    if (DB_ERROR) return { data: null, error: { code: 'XX000', message: 'connection failure' } };
    return { data: DB[name].filter(r => match(r, api._f))[0] ?? null, error: null };
  };
  api.update = (p) => { api._mode = 'update'; api._p = p; return api; };
  api.insert = (p) => { api._mode = 'insert'; api._p = p; return api; };
  api.then = (res) => {
    if (name === 'client_entitlements' && TABLE_MISSING)
      return res({ data: null, error: { code: '42P01', message: 'relation "client_entitlements" does not exist' } });
    if (DB_ERROR) return res({ data: null, error: { code: 'XX000', message: 'connection failure' } });
    if (api._mode === 'update') {
      DB[name].filter(r => match(r, api._f)).forEach(r => { Object.assign(r, api._p); writes++; });
      return res({ error: null });
    }
    if (api._mode === 'insert') {
      if (name === 'client_entitlements' && ENT_INSERT_FAILS)
        return res({ data: null, error: { code: '23503', message: 'insert violates foreign key constraint' } });
      const row = Object.assign({ id: name[0] + (DB[name].length + 1) }, api._p);
      DB[name].push(row); writes++; return res({ data: row, error: null });
    }
    return res({ data: DB[name].filter(r => match(r, api._f)), error: null });
  };
  return api;
}
const admin = { from: table };
const json = (o) => ({ __body: o, json: async () => o });
const ok  = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const logEfError = () => {};
let AUTH_OK = true, COACH_OK = true, CREATE_OK = true;
const verifyClientToken = async (t, k) => AUTH_OK ? { ok: true, storageKey: k } : { ok: false, reason: 'bad_token' };
const verifyCoachToken  = (tok) => COACH_OK && !!tok;   // no token => not a coach call
// clientCreate is pre-existing, out-of-scope code; stubbed so provisioning
// orchestration and its fail-closed behaviour are what is under test.
const clientCreate = async (b) => {
  if (!CREATE_OK) return err('client_insert_failed');
  const key = String(b.storageKey).toLowerCase();
  let row = DB.clients.find(c => c.storage_key === key);
  if (!row) { row = { id: 'c_' + key, storage_key: key, entitlement_legacy: false }; DB.clients.push(row); }
  return ok({ clientId: row.id, storageKey: key, already_exists: false });
};

const M = {};
new Function('admin','ok','err','json','logEfError','verifyClientToken','verifyCoachToken','clientCreate','exports',
  js + '\nObject.assign(exports,{resolveEntitlements,requireCapability,entitlementsGet,entitlementGrant,' +
       'entitlementRevoke,provisionSelfGuidedClient,coachReviewRequest,clientProgram,' +
       'resetMode:()=>{_entModeCache=null;}});'
)(admin, ok, err, json, logEfError, verifyClientToken, verifyCoachToken, clientCreate, M);

const B = (r) => r.__body;
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

(async () => {
  DB.products.push({ code: 'locked_in_1to1', duration_weeks: null },
                   { code: 'locked_in_self_guided_12w', duration_weeks: 12 });
  DB.programs.push({ storage_key: 'legacy_joey', payload: { ok: 1 } },
                   { storage_key: 'sg_new',      payload: { ok: 1 } },
                   { storage_key: 'orphan',      payload: { ok: 1 } });

  // Pre-cutover client: marked by the migration, no entitlement row.
  DB.clients.push({ id: 'c_joey', storage_key: 'legacy_joey', entitlement_legacy: true });
  // Post-cutover clients: default false.
  DB.clients.push({ id: 'c_sg',     storage_key: 'sg_new',   entitlement_legacy: false });
  DB.clients.push({ id: 'c_prem',   storage_key: 'prem_new', entitlement_legacy: false });
  DB.clients.push({ id: 'c_orphan', storage_key: 'orphan',   entitlement_legacy: false });

  console.log('\n[1] LEGACY pre-cutover client, no entitlement row');
  let r = B(await M.entitlementsGet({ token: 'x', storageKey: 'legacy_joey' }));
  t('resolves premium', r.tier === 'locked_in_1to1');
  t('basis is the explicit legacy marker', r.basis === 'legacy_marker');
  t('status entitled', r.status === 'entitled');
  t('keeps manual_coach_review', r.capabilities.manual_coach_review === true);
  t('can fetch program', B(await M.clientProgram({ token: 'x', storageKey: 'legacy_joey' })).ok === true);
  t('can request coach review', B(await M.coachReviewRequest({ token: 'x', storageKey: 'legacy_joey' })).ok === true);

  console.log('\n[2] NEW post-cutover client with SELF_GUIDED entitlement');
  await M.entitlementGrant({ coachToken: 'k', storageKey: 'sg_new', productCode: 'locked_in_self_guided_12w' });
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'sg_new' }));
  t('tier self-guided', r.tier === 'locked_in_self_guided_12w');
  t('basis is entitlement', r.basis === 'entitlement');
  t('has view_program', r.capabilities.view_program === true);
  t('has automated adjustment', r.capabilities.receive_automated_adjustment === true);
  t('denied manual_coach_review', r.capabilities.manual_coach_review === false);
  t('can fetch program', B(await M.clientProgram({ token: 'x', storageKey: 'sg_new' })).ok === true);

  console.log('\n[3] NEW post-cutover client with PREMIUM entitlement');
  await M.entitlementGrant({ coachToken: 'k', storageKey: 'prem_new', productCode: 'locked_in_1to1' });
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'prem_new' }));
  t('tier premium', r.tier === 'locked_in_1to1');
  t('basis is entitlement, not legacy', r.basis === 'entitlement' && r.legacy === false);
  t('has manual_coach_review', r.capabilities.manual_coach_review === true);

  console.log('\n[4] NEW post-cutover client with NO entitlement — MUST BE DENIED');
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'orphan' }));
  t('tier is none', r.tier === 'none');
  t('status provisioning_incomplete', r.status === 'provisioning_incomplete');
  t('NOT flagged legacy', r.legacy === false);
  t('zero capabilities granted', Object.values(r.capabilities).every(v => v === false));
  t('NOT promoted to premium', r.capabilities.manual_coach_review === false);
  r = B(await M.clientProgram({ token: 'x', storageKey: 'orphan' }));
  t('program delivery refused', r.ok === false && r.error === 'provisioning_incomplete');
  r = B(await M.coachReviewRequest({ token: 'x', storageKey: 'orphan' }));
  t('coach review refused as provisioning_incomplete', r.ok === false && r.error === 'provisioning_incomplete');

  console.log('\n[5] FAILED entitlement write after client creation');
  ENT_INSERT_FAILS = true;                     // the entitlement write fails
  r = B(await M.provisionSelfGuidedClient({ coachToken: 'k', storageKey: 'halfmade', productCode: 'locked_in_self_guided_12w' }));
  ENT_INSERT_FAILS = false;
  t('provisioning reports incomplete', r.ok === false && r.error === 'provisioning_incomplete');
  t('client row was created', !!DB.clients.find(c => c.storage_key === 'halfmade'));
  const half = B(await M.entitlementsGet({ token: 'x', storageKey: 'halfmade' }));
  t('half-provisioned client is DENIED', half.status === 'provisioning_incomplete');
  t('half-provisioned client did NOT become premium', half.capabilities.manual_coach_review === false);
  t('half-provisioned client cannot fetch program',
    B(await M.clientProgram({ token: 'x', storageKey: 'halfmade' })).error === 'provisioning_incomplete');

  console.log('\n[6] REVOKED entitlement does not regain premium via fallback');
  await M.entitlementRevoke({ coachToken: 'k', storageKey: 'sg_new', productCode: 'locked_in_self_guided_12w' });
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'sg_new' }));
  t('revoked -> denied, not premium', r.status === 'provisioning_incomplete' && r.tier === 'none');
  t('revoked -> no coach review', r.capabilities.manual_coach_review === false);
  t('revoked -> no program access', B(await M.clientProgram({ token: 'x', storageKey: 'sg_new' })).ok === false);

  console.log('\n[7] EXPIRED entitlement does not regain premium via fallback');
  DB.client_entitlements.push({ client_id: 'c_orphan', product_code: 'locked_in_self_guided_12w',
    status: 'active', starts_at: '2020-01-01T00:00:00Z', ends_at: '2020-04-01T00:00:00Z' });
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'orphan' }));
  t('expired -> denied, not premium', r.status === 'provisioning_incomplete' && r.tier === 'none');
  t('expired -> no coach review', r.capabilities.manual_coach_review === false);

  console.log('\n[8] CAPABILITY TAMPERING — nothing is trusted from the caller');
  r = B(await M.coachReviewRequest({ token: 'x', storageKey: 'sg_new',
        tier: 'locked_in_1to1', capabilities: { manual_coach_review: true },
        serviceTier: 'PREMIUM', entitlement_legacy: true, legacy: true, status: 'entitled' }));
  t('forged body cannot grant coach review', r.ok === false);
  r = B(await M.clientProgram({ token: 'x', storageKey: 'orphan', capabilities: { view_program: true }, entitlement_legacy: true }));
  t('forged body cannot grant program access', r.ok === false && r.error === 'provisioning_incomplete');

  console.log('\n[9] TRANSIENT BACKEND FAILURE fails closed');
  DB_ERROR = true; M.resetMode();
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'legacy_joey' }));
  t('db error -> refused, never premium',
    r.ok === false || (r.status === 'provisioning_incomplete' &&
                       Object.values(r.capabilities || {}).every(v => v === false)));
  t('db error -> program refused',
    B(await M.clientProgram({ token: 'x', storageKey: 'legacy_joey' })).ok === false);
  DB_ERROR = false; M.resetMode();

  console.log('\n[10] PRE-MIGRATION MODE (entitlements table absent)');
  TABLE_MISSING = true; M.resetMode();
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'legacy_joey' }));
  t('pre-migration -> premium for existing clients', r.tier === 'locked_in_1to1' && r.basis === 'pre_migration');
  t('deploying EF before migration cannot lock out 1:1 clients', r.capabilities.view_program === true);
  TABLE_MISSING = false; M.resetMode();

  console.log('\n[11] AUTH PRECEDES ENTITLEMENT');
  AUTH_OK = false;
  t('bad token rejected before capability check',
    B(await M.coachReviewRequest({ token: 'bad', storageKey: 'legacy_joey' })).error === 'bad_token');
  t('bad token blocks program fetch',
    B(await M.clientProgram({ token: 'bad', storageKey: 'legacy_joey' })).error === 'bad_token');
  AUTH_OK = true;
  COACH_OK = false;
  t('non-coach cannot grant', B(await M.entitlementGrant({ coachToken: 'b', storageKey: 'orphan', productCode: 'locked_in_1to1' })).error === 'unauthorized');
  t('non-coach cannot provision', B(await M.provisionSelfGuidedClient({ coachToken: 'b', storageKey: 'x' })).error === 'unauthorized');
  COACH_OK = true;

  console.log('\n[12] HAPPY-PATH PROVISIONING (the acceptance test)');
  const w0 = writes;
  r = B(await M.provisionSelfGuidedClient({ coachToken: 'k', storageKey: 'customer_501', displayName: 'Customer 501' }));
  t('provision succeeds', r.ok === true);
  t('tier self-guided', r.tier === 'locked_in_self_guided_12w');
  t('12-week window', Math.round((Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 86400000) === 84);
  DB.programs.push({ storage_key: 'customer_501', payload: { ok: 1 } });
  t('client can fetch program', B(await M.clientProgram({ token: 'x', storageKey: 'customer_501' })).ok === true);
  t('client denied coach review', B(await M.coachReviewRequest({ token: 'x', storageKey: 'customer_501' })).error === 'forbidden_tier');
  console.log(`       ${writes - w0} row writes · 0 files generated · 0 deploys`);

  console.log('\n[13] UPGRADE SELF_GUIDED -> PREMIUM preserves history');
  const before = DB.client_entitlements.length;
  await M.entitlementGrant({ coachToken: 'k', storageKey: 'customer_501', productCode: 'locked_in_1to1', source: 'admin' });
  r = B(await M.entitlementsGet({ token: 'x', storageKey: 'customer_501' }));
  t('holds both products', r.products.length === 2);
  t('gains coach review', r.capabilities.manual_coach_review === true);
  t('keeps self-guided automation', r.capabilities.receive_automated_adjustment === true);
  t('nothing deleted', DB.client_entitlements.length === before + 1);
  t('client not duplicated', DB.clients.filter(c => c.storage_key === 'customer_501').length === 1);

  console.log('\n[14] overridePut GATE — legacy 1:1 unaffected');
  t('legacy client passes coach_program_customisation',
    (await M.requireCapability('legacy_joey', 'coach_program_customisation')).ok === true);
  const g = await M.requireCapability('customer_501', 'view_program');
  t('provisioned client passes view_program', g.ok === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
