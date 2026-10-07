// CLIENT ISOLATION — two clients, real token verification (Phase 0, 2026-10-08)
//
// Question: with Client A's VALID token, can A read B's weights, photos or
// overrides by naming B in the request? Required answer: NO, for every field
// the caller controls (body.client, body.storageKey) — and A must still read A.
//
// Runs the REAL source of verifyClientToken (salted sha256 against
// client_sessions, revoked/suspended handling), the entitlement gate, and the
// three read handlers, against an in-memory Supabase stand-in seeded with two
// clients. No network, no real credentials: tokens are random per run.
//
//   node tests/client_isolation.test.js                    → checks the working tree
//   SRC_FILE=/path/to/index.ts node tests/client_isolation.test.js  → checks another revision
const ts = require('typescript');
const fs = require('fs');
const crypto = require('crypto');
const SRC = fs.readFileSync(process.env.SRC_FILE || 'supabase/functions/api/index.ts', 'utf8');

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
  grab(/async function verifyClientToken/, '\n}'),     // REAL token verification
  grab(/async function sha256\(/, '\n}'),
  grab(/const PHOTO_BUCKET/, ';'),
  grab(/const SIGNED_URL_TTL_SEC/, ';'),
  grab(/async function weightLog/, '\n}'),
  grab(/async function photosGet/, '\n}'),
  grab(/async function overrideGet/, '\n}'),
].join('\n').replace(/^type Resolved[\s\S]*?\n};\n/m, '');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// ── in-memory Supabase stand-in ────────────────────────────────────────────
const DB = { clients: [], client_sessions: [], client_entitlements: [], products: [], weight_logs: [], photo_uploads: [], intakes: [], client_overrides: [] };
const match = (row, f) => f.every(([op, c, v]) => op === 'eq' ? row[c] === v : op === 'is' ? (row[c] ?? null) === v : op === 'in' ? v.includes(row[c]) : true);
function table(name) {
  if (!DB[name]) DB[name] = [];
  const api = { _f: [] };
  api.select = () => api; api.limit = () => api; api.order = () => api;
  api.eq = (c, v) => { api._f.push(['eq', c, v]); return api; };
  api.is = (c, v) => { api._f.push(['is', c, v]); return api; };
  api.in = (c, v) => { api._f.push(['in', c, v]); return api; };
  api.single = async () => { const d = DB[name].filter(r => match(r, api._f))[0] ?? null; return { data: d, error: d ? null : { message: 'no rows' } }; };
  api.maybeSingle = async () => ({ data: DB[name].filter(r => match(r, api._f))[0] ?? null, error: null });
  api.then = (res) => res({ data: DB[name].filter(r => match(r, api._f)), error: null });
  return api;
}
const admin = {
  from: table,
  storage: { from: () => ({ createSignedUrls: async (paths) => ({ data: paths.map(p => ({ path: p, signedUrl: 'https://signed.example/' + p })), error: null }) }) },
};
const json = (o) => ({ __body: o });
const ok  = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const logEfError = () => {};
const COACH_TOKEN = crypto.randomBytes(16).toString('hex');
const verifyCoachToken = (tok) => !!tok && tok === COACH_TOKEN;

const M = {};
new Function('admin', 'ok', 'err', 'json', 'logEfError', 'verifyCoachToken', 'exports',
  js + '\nObject.assign(exports,{verifyClientToken,weightLog,photosGet,overrideGet});'
)(admin, ok, err, json, logEfError, verifyCoachToken, M);
const B = (r) => r.__body;

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 160) : '')); } };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── seed: two entitled clients (A, B), one revoked (R), one suspended (S) ──
const TOK = {};
function seed(key, id, status) {
  TOK[key] = crypto.randomBytes(32).toString('hex');
  const salt = 'salt_' + crypto.randomBytes(4).toString('hex');
  DB.clients.push({ id, storage_key: key, entitlement_legacy: true });
  DB.client_sessions.push({ storage_key: key, client_id: id, token_hash: sha(TOK[key] + salt), salt, access_status: status, clients: { storage_key: key } });
  DB.weight_logs.push({ client_key: key, logged_at: '2026-10-01', weight_kg: key.length * 10 + 1, notes: key + ' private' });
  DB.photo_uploads.push({ id: 'p_' + key, client_key: key, storage_path: key + '/front.jpg', view: 'front', week: 1, uploaded_at: '2026-10-01', source: 'checkin' });
  DB.client_overrides.push({ client_id: id, key: 'macros.p1', value_text: key + ' plan', value_number: null, valid_to: null });
}
seed('alice_a', 'c_a', 'active');
seed('bob_bb', 'c_b', 'active');
seed('rev_rr', 'c_r', 'revoked');
seed('sus_ss', 'c_s', 'suspended');

const owner = {
  weightLog:   (r) => Array.isArray(r) ? (r.length ? r[0].notes.split(' ')[0] : 'EMPTY') : 'DENIED:' + r.error,
  photosGet:   (r) => r.ok ? (r.photos.length ? r.photos[0].url.split('/').slice(-2)[0] : 'EMPTY') : 'DENIED:' + r.error,
  overrideGet: (r) => r.ok ? ((r['macros.p1'] || 'EMPTY').split(' ')[0]) : 'DENIED:' + r.error,
};
const READS = ['weightLog', 'photosGet', 'overrideGet'];
const call = async (fn, body) => owner[fn](B(await M[fn](body)));

(async () => {
  console.log('\n[I1] OWN DATA — each client reads its own weights, photos, overrides');
  for (const [me] of [['alice_a'], ['bob_bb']]) for (const fn of READS)
    t(`${me} → own ${fn}`, (await call(fn, { token: TOK[me], storageKey: me })) === me);

  console.log('\n[I2] CROSS-CLIENT via body.client — valid own token + own storageKey + other client named');
  for (const [me, other] of [['alice_a', 'bob_bb'], ['bob_bb', 'alice_a']]) for (const fn of READS) {
    const got = await call(fn, { token: TOK[me], storageKey: me, client: other });
    t(`${me} naming client:${other} via ${fn} never returns ${other}'s data`, got !== other, got);
  }

  console.log('\n[I3] CROSS-CLIENT via body.storageKey — own token presented for the other client');
  for (const [me, other] of [['alice_a', 'bob_bb'], ['bob_bb', 'alice_a']]) for (const fn of READS) {
    const got = await call(fn, { token: TOK[me], storageKey: other });
    t(`${me}'s token with storageKey:${other} via ${fn} is refused (bad_token)`, got === 'DENIED:bad_token', got);
  }

  console.log('\n[I4] MISSING / INVALID / REVOKED / SUSPENDED / UNKNOWN');
  for (const fn of READS) {
    t(`${fn}: no token → refused`, (await call(fn, { storageKey: 'alice_a' })) === 'DENIED:missing_credentials');
    t(`${fn}: no token, client:bob_bb → refused`, (await call(fn, { client: 'bob_bb' })).startsWith('DENIED:'));
    t(`${fn}: invalid token → refused`, (await call(fn, { token: 'not-a-real-token', storageKey: 'alice_a' })) === 'DENIED:bad_token');
    t(`${fn}: revoked client's own token → refused`, (await call(fn, { token: TOK.rev_rr, storageKey: 'rev_rr' })) === 'DENIED:access_revoked');
    t(`${fn}: suspended client's own token → refused`, (await call(fn, { token: TOK.sus_ss, storageKey: 'sus_ss' })) === 'DENIED:access_suspended');
    t(`${fn}: nonexistent storageKey → refused`, (await call(fn, { token: TOK.alice_a, storageKey: 'nobody_x' })) === 'DENIED:unknown_client');
    const viaRev = await call(fn, { token: TOK.alice_a, storageKey: 'alice_a', client: 'rev_rr' });
    t(`${fn}: alice naming revoked client never returns its data`, viaRev !== 'rev_rr', viaRev);
    const nx = await call(fn, { token: TOK.alice_a, storageKey: 'alice_a', client: 'nobody_x' });
    t(`${fn}: alice naming nonexistent client gets her own data, not an error leak`, nx === 'alice_a', nx);
    t(`${fn}: mixed-case own key still reads own data`, (await call(fn, { token: TOK.alice_a, storageKey: 'ALICE_A' })) === 'alice_a');
  }

  console.log('\n[I5] COACH — may still read any named client');
  for (const fn of READS) for (const who of ['alice_a', 'bob_bb', 'rev_rr'])
    t(`coach ${fn} client:${who}`, (await call(fn, { coachToken: COACH_TOKEN, client: who, storageKey: who })) === who);
  t('wrong coach token is not the coach', (await call('weightLog', { coachToken: 'nope', client: 'bob_bb' })).startsWith('DENIED:'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
