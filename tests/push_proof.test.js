// LOCKED IN Push Notifications — MINIMAL PROOF test suite.
//
// 0 production invocations. Runs the REAL shipped source:
//   supabase/functions/push/webpush.ts   (transpiled with typescript)
//   supabase/functions/push/handler.ts   (transpiled with typescript)
//   sw.js                                 (executed in a vm sandbox)
// against:
//   * an in-memory Supabase stand-in whose tables/columns are parsed from the
//     push migration — an unknown column is an error, so handler ↔ schema drift fails here;
//   * a fake push service that DECRYPTS every message with node:crypto (an
//     implementation independent of the WebCrypto sender) and VERIFIES the
//     VAPID JWT signature, audience and expiry;
//   * the RFC 8291 Appendix A known-answer vector.
//
// Usage (from the DASHBOARD repo root):   node tests/push_proof.test.js
'use strict';
const ts = require('typescript');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── load the real TS source ─────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-proof-'));
function transpile(src, out) {
  const js = ts.transpileModule(rd(src), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText.replace(/require\("\.\/webpush\.ts"\)/g, 'require("./webpush.js")');
  fs.writeFileSync(path.join(tmp, out), js);
}
transpile('supabase/functions/push/webpush.ts', 'webpush.js');
transpile('supabase/functions/push/handler.ts', 'handler.js');
const WP = require(path.join(tmp, 'webpush.js'));
const H = require(path.join(tmp, 'handler.js'));

// ── tiny runner ─────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`ASSERT: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const sha256hex = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

// ════════════════════════════════════════════════════════════════════════════
// Schema from the migration
// ════════════════════════════════════════════════════════════════════════════
const MIGRATION = rd('supabase/migrations/20260928120000_push_notifications_proof.sql');
function parseColumns(table) {
  const m = MIGRATION.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error('migration: table not found ' + table);
  const cols = new Set();
  for (const line of m[1].split('\n')) {
    const c = line.trim().match(/^([a-z][a-z0-9_]*)\s+(uuid|text|boolean|integer|timestamptz|jsonb)\b/);
    if (c) cols.add(c[1]);
  }
  return cols;
}
const SCHEMA = {
  push_devices: parseColumns('push_devices'),
  notification_events: parseColumns('notification_events'),
  // Existing tables: only the columns this function touches.
  clients: new Set(['id', 'storage_key']),
  client_sessions: new Set(['storage_key', 'token_hash', 'salt', 'access_status', 'client_id']),
};
const UNIQUE = { push_devices: ['endpoint_hash'], notification_events: ['dedupe_key'], clients: ['storage_key'], client_sessions: ['storage_key'] };
const CHECKS = {
  push_devices: (r) => ['active', 'revoked', 'expired', 'disabled'].includes(r.status) &&
    (r.status !== 'active' || (r.endpoint && r.p256dh && r.auth_secret)) && /^[0-9a-f]{64}$/.test(r.endpoint_hash),
  notification_events: (r) => ['test'].includes(r.kind) &&
    ['claimed', 'sent', 'partial', 'failed', 'suppressed'].includes(r.status) &&
    ['coach', 'system', 'client'].includes(r.created_by),
};

// ════════════════════════════════════════════════════════════════════════════
// In-memory Supabase stand-in (strict)
// ════════════════════════════════════════════════════════════════════════════
function makeDb() {
  const T = { clients: [], client_sessions: [], push_devices: [], notification_events: [] };
  const calls = [];
  let seq = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
  const colErr = (t, c) => ({ message: `column ${t}.${c} does not exist`, code: '42703' });

  function checkCols(t, cols) {
    for (const c of cols) if (!SCHEMA[t].has(c)) return colErr(t, c);
    return null;
  }
  function parseSelect(t, s) {
    const cols = []; let embedded = null;
    for (const part of String(s).split(',').map((x) => x.trim()).filter(Boolean)) {
      const e = part.match(/^([a-z_]+)\(([a-z_, ]+)\)$/);
      if (e) { embedded = { table: e[1], cols: e[2].split(',').map((x) => x.trim()) }; continue; }
      cols.push(part);
    }
    return { cols, embedded };
  }
  function project(t, row, sel) {
    const o = {};
    for (const c of sel.cols) o[c] = row[c];
    if (sel.embedded && sel.embedded.table === 'clients') {
      const cl = T.clients.find((c) => c.id === row.client_id);
      o.clients = cl ? Object.fromEntries(sel.embedded.cols.map((c) => [c, cl[c]])) : null;
    }
    return o;
  }

  function from(t) {
    if (!T[t]) throw new Error('stand-in: unknown table ' + t);
    const q = { t, filters: [], mode: 'select', sel: null, opts: {}, limitN: null, payload: null, returning: null };
    const b = {};
    const matchRow = (r) => q.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c]) >= String(v) : false);
    b.select = (s = '*', opts = {}) => {
      if (q.mode === 'select') { q.sel = parseSelect(t, s); q.opts = opts; }
      else q.returning = parseSelect(t, s);
      return b;
    };
    b.eq = (c, v) => { q.filters.push(['eq', c, v]); return b; };
    b.gte = (c, v) => { q.filters.push(['gte', c, v]); return b; };
    b.limit = (n) => { q.limitN = n; return b; };
    b.insert = (obj) => { q.mode = 'insert'; q.payload = obj; return b; };
    b.update = (obj) => { q.mode = 'update'; q.payload = obj; return b; };

    function run() {
      calls.push({ t, mode: q.mode, filters: q.filters.map((f) => f.slice()) });
      const fe = checkCols(t, q.filters.map((f) => f[1]));
      if (fe) return { data: null, error: fe };
      if (q.mode === 'select') {
        const se = checkCols(t, q.sel.cols); if (se) return { data: null, error: se };
        let rows = T[t].filter(matchRow);
        if (q.limitN != null) rows = rows.slice(0, q.limitN);
        if (q.opts.count === 'exact' && q.opts.head) return { data: null, error: null, count: rows.length };
        return { data: rows.map((r) => project(t, r, q.sel)), error: null };
      }
      if (q.mode === 'insert') {
        const ce = checkCols(t, Object.keys(q.payload)); if (ce) return { data: null, error: ce };
        const row = { id: uuid(), ...q.payload };
        for (const u of UNIQUE[t] || []) {
          if (T[t].some((r) => r[u] === row[u])) return { data: null, error: { message: `duplicate key value violates unique constraint "${t}_${u}_key"`, code: '23505' } };
        }
        if (CHECKS[t] && !CHECKS[t](row)) return { data: null, error: { message: `new row for relation "${t}" violates check constraint`, code: '23514' } };
        T[t].push(row);
        return { data: q.returning ? [project(t, row, q.returning)] : null, error: null };
      }
      if (q.mode === 'update') {
        const ce = checkCols(t, Object.keys(q.payload)); if (ce) return { data: null, error: ce };
        const hits = T[t].filter(matchRow);
        for (const r of hits) {
          const next = { ...r, ...q.payload };
          if (CHECKS[t] && !CHECKS[t](next)) return { data: null, error: { message: 'check constraint violation', code: '23514' } };
        }
        for (const r of hits) Object.assign(r, q.payload);
        return { data: q.returning ? hits.map((r) => project(t, r, q.returning)) : null, error: null };
      }
      throw new Error('stand-in: bad mode');
    }
    b.single = async () => {
      const r = run(); if (r.error) return r;
      const rows = Array.isArray(r.data) ? r.data : [];
      if (rows.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      return { data: rows[0], error: null };
    };
    b.maybeSingle = async () => {
      const r = run(); if (r.error) return r;
      const rows = Array.isArray(r.data) ? r.data : [];
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
      return { data: rows[0] ?? null, error: null };
    };
    b.then = (res, rej) => Promise.resolve().then(run).then(res, rej);
    return b;
  }
  return { admin: { from }, T, calls, uuid };
}

// ════════════════════════════════════════════════════════════════════════════
// Fixtures: clients, tokens, VAPID keys, browser subscriptions
// ════════════════════════════════════════════════════════════════════════════
const CANARY = '_push_canary';
const OTHER = 'zac';                          // a real-looking key that is NOT allow-listed
const CANARY_TOKEN = 'canarytoken_' + nodeCrypto.randomBytes(16).toString('hex');
const OTHER_TOKEN = 'othertoken_' + nodeCrypto.randomBytes(16).toString('hex');
const SECOND_TOKEN = 'secondtoken_' + nodeCrypto.randomBytes(16).toString('hex');
const COACH_HASH = sha256hex('coach-password-for-tests');

async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicB64: b64u(pub), privateB64: jwk.d };
}

function makeBrowserSub(host = 'web.push.apple.com') {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  const endpoint = `https://${host}/${nodeCrypto.randomBytes(24).toString('base64url')}`;
  return {
    ecdh, auth,
    json: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
  };
}

// Independent RFC 8291 decryptor: node:crypto ECDH + HKDF + AES-128-GCM.
function nodeDecrypt(body, ecdh, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  assert(rs === 4096, 'record size 4096');
  assert(idlen === 65, 'keyid is a 65-byte P-256 point');
  assert(ct.length <= rs, 'single record');
  const shared = ecdh.computeSecret(asPub);
  const uaPub = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const padded = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert(padded[end] === 2, 'last-record delimiter 0x02');
  return padded.subarray(0, end).toString('utf8');
}

function verifyVapidHeader(authz, expectedAud, vapidPublicB64, nowSec) {
  const m = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(authz || '');
  assert(m, 'Authorization is "vapid t=<jwt>, k=<key>"');
  eq(m[2], vapidPublicB64, 'k= is the configured VAPID public key');
  const [h, p, s] = m[1].split('.');
  const header = JSON.parse(unb64u(h).toString());
  const claims = JSON.parse(unb64u(p).toString());
  eq(header.alg, 'ES256', 'JWT alg'); eq(header.typ, 'JWT', 'JWT typ');
  eq(claims.aud, expectedAud, 'JWT aud = push service origin');
  assert(claims.exp > nowSec && claims.exp <= nowSec + 24 * 3600, 'JWT exp within 24h');
  assert(/^(mailto:|https:)/.test(claims.sub), 'JWT sub is mailto:/https:');
  const pub = unb64u(m[2]);
  const key = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  assert(nodeCrypto.verify('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }, unb64u(s)), 'JWT ES256 signature verifies');
}

// Fake push service. statusFor(endpoint) decides the HTTP answer.
function makePushService(subsByEndpoint, vapidPublicB64, nowSec) {
  const received = [];
  let statusFor = () => 201;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    eq(init.method, 'POST', 'push is POST');
    eq(init.redirect, 'manual', 'push never follows redirects');
    eq(init.headers['Content-Encoding'], 'aes128gcm', 'Content-Encoding');
    assert(/^\d+$/.test(init.headers.TTL), 'TTL header');
    assert(['very-low', 'low', 'normal', 'high'].includes(init.headers.Urgency), 'Urgency header');
    verifyVapidHeader(init.headers.Authorization, u.origin, vapidPublicB64, nowSec);
    const sub = subsByEndpoint.get(url);
    assert(sub, 'push went to a registered endpoint');
    const plaintext = nodeDecrypt(Buffer.from(init.body), sub.ecdh, sub.auth);
    received.push({ url, headers: init.headers, payload: JSON.parse(plaintext) });
    const status = statusFor(url);
    if (status === 'throw') throw new TypeError('fetch failed');
    return new Response(null, { status });
  };
  return { fetchImpl, received, setStatus: (fn) => { statusFor = fn; } };
}

// A complete world: DB rows, env, handler, push service, captured logs.
async function world(opts = {}) {
  const db = makeDb();
  const canaryId = db.uuid(), otherId = db.uuid(), secondId = db.uuid();
  db.T.clients.push({ id: canaryId, storage_key: CANARY }, { id: otherId, storage_key: OTHER }, { id: secondId, storage_key: '_push_canary2' });
  const salt1 = 's1' + nodeCrypto.randomBytes(8).toString('hex');
  const salt2 = 's2' + nodeCrypto.randomBytes(8).toString('hex');
  const salt3 = 's3' + nodeCrypto.randomBytes(8).toString('hex');
  db.T.client_sessions.push(
    { client_id: canaryId, storage_key: CANARY, token_hash: sha256hex(CANARY_TOKEN + salt1), salt: salt1, access_status: opts.canaryAccess ?? 'active' },
    { client_id: otherId, storage_key: OTHER, token_hash: sha256hex(OTHER_TOKEN + salt2), salt: salt2, access_status: 'active' },
    { client_id: secondId, storage_key: '_push_canary2', token_hash: sha256hex(SECOND_TOKEN + salt3), salt: salt3, access_status: 'active' },
  );
  const vapid = opts.vapid ?? await makeVapid();
  const env = {
    vapidPublicKey: vapid.publicB64,
    vapidPrivateKey: opts.noVapid ? '' : vapid.privateB64,
    vapidSubject: 'https://omarsoubra.github.io/DASHBOARD/',
    coachPasswordHash: COACH_HASH,
    allowedClients: new Set(opts.allowed ?? [CANARY, '_push_canary2']),
  };
  const nowMs = Date.UTC(2026, 8, 28, 9, 0, 0);
  const subs = new Map();
  const svc = makePushService(subs, vapid.publicB64, Math.floor(nowMs / 1000));
  const logs = [];
  const handle = H.makePushHandler({ admin: db.admin, env, fetchImpl: svc.fetchImpl, now: () => nowMs, log: (...a) => logs.push(a.join(' | ')) });
  const responses = [];
  async function call(body, method = 'POST') {
    const req = method === 'GET'
      ? new Request('https://x.supabase.co/functions/v1/push?type=' + body)
      : new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const r = await handle(req);
    const text = await r.text();
    responses.push(text);
    return { status: r.status, j: JSON.parse(text) };
  }
  const newSub = (host) => { const s = makeBrowserSub(host); subs.set(s.json.endpoint, s); return s; };
  const subscribe = (s, extra = {}) => call({ type: 'pushSubscribe', storageKey: CANARY, token: CANARY_TOKEN, subscription: s.json, timezone: 'Australia/Sydney', standalone: true, ...extra });
  let rid = 0;
  const send = (extra = {}) => call({ type: 'coachPushSend', coachToken: COACH_HASH, storageKey: CANARY, template: 'test', requestId: 'req_' + String(++rid).padStart(6, '0') + '_' + nodeCrypto.randomBytes(3).toString('hex'), ...extra });
  return { db, env, vapid, svc, logs, responses, call, newSub, subscribe, send, canaryId, otherId, secondId };
}

// Every secret that must never leave the server or reach a log.
function assertNoLeak(w, extraSecrets = []) {
  const secrets = [w.vapid.privateB64, CANARY_TOKEN, OTHER_TOKEN, SECOND_TOKEN, COACH_HASH, ...extraSecrets];
  const hay = w.responses.join('\n') + '\n' + w.logs.join('\n');
  for (const s of secrets) assert(!hay.includes(s), 'secret leaked into a response or log');
  for (const d of w.db.T.push_devices) {
    if (d.endpoint) assert(!w.responses.join('\n').includes(d.endpoint), 'endpoint leaked into a response');
    if (d.p256dh) assert(!w.responses.join('\n').includes(d.p256dh), 'p256dh leaked into a response');
    if (d.auth_secret) assert(!w.responses.join('\n').includes(d.auth_secret), 'auth secret leaked into a response');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// A. Crypto — RFC vectors and independent verification
// ════════════════════════════════════════════════════════════════════════════
test('A1 RFC 8291 Appendix A: byte-exact aes128gcm body', async () => {
  const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  const out = await WP.encryptPayload(
    new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    unb64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    unb64u('BTBZMqHH6r4Tts7J_aSIgg'),
    {
      senderPrivateRaw: unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      senderPublicRaw: unb64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
      salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    });
  eq(b64u(out), expected, 'RFC 8291 §5 body');
});

test('A2 random payloads decrypt with the independent node:crypto receiver', async () => {
  for (let i = 0; i < 25; i++) {
    const s = makeBrowserSub();
    const msg = JSON.stringify({ i, pad: 'x'.repeat(i * 97) });
    const body = await WP.encryptPayload(new TextEncoder().encode(msg), s.ecdh.getPublicKey(), s.auth);
    eq(nodeDecrypt(Buffer.from(body), s.ecdh, s.auth), msg, 'round-trip ' + i);
  }
});

test('A3 fresh salt + ephemeral key per message', async () => {
  const s = makeBrowserSub();
  const p = new TextEncoder().encode('same');
  const a = Buffer.from(await WP.encryptPayload(p, s.ecdh.getPublicKey(), s.auth));
  const b = Buffer.from(await WP.encryptPayload(p, s.ecdh.getPublicKey(), s.auth));
  assert(!a.subarray(0, 16).equals(b.subarray(0, 16)), 'salt differs');
  assert(!a.subarray(21, 86).equals(b.subarray(21, 86)), 'sender key differs');
});

test('A4 encryption rejects bad receiver keys / auth / oversize payload', async () => {
  const s = makeBrowserSub();
  const bad = async (fn, label) => { let threw = false; try { await fn(); } catch { threw = true; } assert(threw, label); };
  await bad(() => WP.encryptPayload(new Uint8Array(3), new Uint8Array(65), s.auth), 'all-zero point');
  await bad(() => WP.encryptPayload(new Uint8Array(3), s.ecdh.getPublicKey().subarray(0, 64), s.auth), 'short point');
  const offCurve = Buffer.from(s.ecdh.getPublicKey()); offCurve[64] ^= 1;
  await bad(() => WP.encryptPayload(new Uint8Array(3), offCurve, s.auth), 'off-curve point');
  await bad(() => WP.encryptPayload(new Uint8Array(3), s.ecdh.getPublicKey(), s.auth.subarray(0, 8)), 'short auth');
  await bad(() => WP.encryptPayload(new Uint8Array(WP.MAX_PAYLOAD_BYTES + 1), s.ecdh.getPublicKey(), s.auth), 'oversize');
});

test('A5 VAPID: JWT verifies with node:crypto; mismatched keypair refused', async () => {
  const v = await makeVapid();
  const keys = await WP.importVapidKeys(v.publicB64, v.privateB64, 'mailto:coach@example.com');
  const nowSec = 1_800_000_000;
  const jwt = await WP.createVapidJwt('https://web.push.apple.com', keys, nowSec);
  verifyVapidHeader(`vapid t=${jwt}, k=${v.publicB64}`, 'https://web.push.apple.com', v.publicB64, nowSec);
  const other = await makeVapid();
  let threw = ''; try { await WP.importVapidKeys(v.publicB64, other.privateB64, 'mailto:a@b.co'); } catch (e) { threw = e.message; }
  eq(threw, 'vapid_keypair_mismatch', 'mismatched pair');
  threw = ''; try { await WP.importVapidKeys(v.publicB64, v.privateB64, 'not-a-subject'); } catch (e) { threw = e.message; }
  eq(threw, 'vapid_subject_invalid', 'subject must be mailto:/https:');
});

test('A6 base64url decoder is strict', async () => {
  for (const bad of ['a+b', 'a/b', 'a b', 'abcde', '%%%']) {
    let threw = false; try { WP.b64urlDecode(bad); } catch { threw = true; }
    assert(threw, 'rejects ' + bad);
  }
  eq(b64u(WP.b64urlDecode('BTBZMqHH6r4Tts7J_aSIgg')), 'BTBZMqHH6r4Tts7J_aSIgg', 'round trip');
});

// ════════════════════════════════════════════════════════════════════════════
// B. Auth + identity
// ════════════════════════════════════════════════════════════════════════════
test('B1 subscribe: missing / wrong / other-client token → 401, nothing stored', async () => {
  const w = await world(); const s = w.newSub();
  eq((await w.subscribe(s, { token: '' })).j.error, 'missing_credentials', 'no token');
  eq((await w.subscribe(s, { token: 'x'.repeat(64) })).j.error, 'bad_token', 'wrong token');
  eq((await w.subscribe(s, { token: OTHER_TOKEN })).j.error, 'bad_token', "another client's token");
  eq((await w.subscribe(s, { token: SECOND_TOKEN })).j.error, 'bad_token', "allow-listed sibling's token");
  eq(w.db.T.push_devices.length, 0, 'no device rows');
  assertNoLeak(w);
});

test('B2 non-allow-listed client is refused before any DB read', async () => {
  const w = await world(); const s = w.newSub();
  const before = w.db.calls.length;
  const r = await w.call({ type: 'pushSubscribe', storageKey: OTHER, token: OTHER_TOKEN, subscription: s.json });
  eq(r.status, 403, 'status'); eq(r.j.error, 'push_not_enabled', 'error');
  eq(w.db.calls.length, before, 'zero DB calls');
  const w2 = await world({ allowed: [] });
  eq((await w2.subscribe(w2.newSub())).j.error, 'push_not_enabled', 'empty allow-list = nobody');
});

test('B3 caller-supplied client_id / clientId are ignored', async () => {
  const w = await world(); const s = w.newSub();
  const r = await w.subscribe(s, { client_id: w.otherId, clientId: w.otherId, storage_key: OTHER });
  eq(r.j.ok, true, 'ok');
  eq(w.db.T.push_devices[0].client_id, w.canaryId, 'stored against the VERIFIED client');
  eq(w.db.T.push_devices[0].storage_key, CANARY, 'storage key from auth');
});

test('B4 revoked / suspended access → refused', async () => {
  for (const st of ['revoked', 'suspended']) {
    const w = await world({ canaryAccess: st });
    eq((await w.subscribe(w.newSub())).j.error, 'access_' + st, st);
    eq(w.db.T.push_devices.length, 0, 'nothing stored ' + st);
  }
});

test('B5 coach auth: wrong / missing coach token → 401; client token is not a coach token', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  eq((await w.send({ coachToken: 'nope' })).status, 401, 'wrong');
  eq((await w.send({ coachToken: undefined })).status, 401, 'missing');
  eq((await w.send({ coachToken: CANARY_TOKEN })).status, 401, 'client token');
  eq(w.svc.received.length, 0, 'nothing sent');
  eq(w.db.T.notification_events.length, 0, 'nothing claimed');
});

test('B6 coach send to a non-allow-listed client is refused', async () => {
  const w = await world();
  const r = await w.send({ storageKey: OTHER });
  eq(r.j.error, 'push_not_enabled', 'refused');
  eq(w.db.T.notification_events.length, 0, 'nothing claimed');
});

test('B7 verifyClientToken is a verbatim copy of the api implementation', async () => {
  const grabFn = (src) => {
    const i = src.indexOf('async function verifyClientToken');
    assert(i >= 0, 'function present');
    let depth = 0, j = src.indexOf('{', src.indexOf(')', src.indexOf('Promise<', i)));
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1).replace(/\s+/g, ' ');
    }
    throw new Error('unterminated');
  };
  eq(grabFn(rd('supabase/functions/push/handler.ts')), grabFn(rd('supabase/functions/api/index.ts')), 'identical');
});

// ════════════════════════════════════════════════════════════════════════════
// C. Subscription validation + endpoint allow-list
// ════════════════════════════════════════════════════════════════════════════
test('C1 endpoint allow-list: every hostile / malformed endpoint rejected', async () => {
  const bad = [
    'http://web.push.apple.com/abc',                   // not https
    'https://evil.example.com/abc',
    'https://web.push.apple.com.evil.com/abc',          // suffix trick
    'https://evilweb.push.apple.com.attacker.io/x',
    'https://push.apple.com/x',                         // bare suffix, not a subdomain
    'https://fcm.googleapis.com.evil.io/x',
    'https://user:pw@web.push.apple.com/x',             // userinfo
    'https://web.push.apple.com:8443/x',                // port
    'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data',
    'https://localhost/x', 'https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/api',
    'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '',
    'https://web.push.apple.com/' + 'a'.repeat(1100),
  ];
  const w = await world();
  for (const e of bad) {
    const s = makeBrowserSub(); s.json.endpoint = e;
    const r = await w.subscribe(s);
    eq(r.j.ok, false, 'rejected: ' + e.slice(0, 60));
    eq(r.status, 400, 'status 400: ' + e.slice(0, 60));
  }
  const nonString = await w.call({ type: 'pushSubscribe', storageKey: CANARY, token: CANARY_TOKEN, subscription: { endpoint: { href: 'x' }, keys: {} } });
  eq(nonString.j.ok, false, 'non-string endpoint');
  eq(w.db.T.push_devices.length, 0, 'nothing stored');
});

test('C2 allow-listed push services accepted', async () => {
  const ok = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'api.push.apple.com', 'wns2-par02p.notify.windows.com'];
  for (const h of ok) {
    const r = H.validateEndpoint(`https://${h}/abc`);
    assert(r.ok, 'accepted ' + h);
  }
  assert(H.validateEndpoint('https://WEB.PUSH.APPLE.COM/abc').ok, 'case-insensitive host');
});

test('C3 subscription key validation', async () => {
  const w = await world();
  const cases = [
    (s) => { delete s.json.keys; },
    (s) => { s.json.keys.p256dh = 'short'; },
    (s) => { s.json.keys.p256dh = b64u(Buffer.alloc(65)); },                       // not on curve
    (s) => { const k = unb64u(s.json.keys.p256dh); k[64] ^= 1; s.json.keys.p256dh = b64u(k); },
    (s) => { s.json.keys.auth = b64u(Buffer.alloc(8)); },
    (s) => { s.json.keys.auth = '!!notb64!!'; },
    (s) => { s.json.keys.p256dh = 12345; },
  ];
  for (const [i, mut] of cases.entries()) {
    const s = makeBrowserSub(); mut(s);
    eq((await w.subscribe(s)).j.ok, false, 'bad keys case ' + i);
  }
  eq(w.db.T.push_devices.length, 0, 'nothing stored');
});

test('C4 oversize / malformed request bodies', async () => {
  const w = await world();
  eq((await w.call('{not json')).j.error, 'bad_json', 'bad json');
  eq((await w.call(JSON.stringify({ type: 'pushSubscribe', pad: 'x'.repeat(9000) }))).status, 413, 'too large');
  eq((await w.call({ type: 'nope' })).j.error, 'unknown_type', 'unknown type');
  eq((await w.call({ type: 'pushSubscribe', storageKey: '../etc', token: 'x' })).j.error, 'bad_storageKey', 'bad key');
});

// ════════════════════════════════════════════════════════════════════════════
// D. Registration lifecycle
// ════════════════════════════════════════════════════════════════════════════
test('D1 valid subscribe stores one active device with hashed identity; no secrets echoed', async () => {
  const w = await world(); const s = w.newSub();
  const r = await w.subscribe(s);
  eq(r.j.ok, true, 'ok'); eq(r.j.created, true, 'created');
  const d = w.db.T.push_devices[0];
  eq(d.status, 'active', 'active'); eq(d.endpoint_hash, sha256hex(s.json.endpoint), 'endpoint hash');
  eq(d.push_host, 'web.push.apple.com', 'host'); eq(d.timezone, 'Australia/Sydney', 'tz'); eq(d.standalone, true, 'standalone');
  assertNoLeak(w);
});

test('D2 duplicate registration (same client) updates in place — never a second row', async () => {
  const w = await world(); const s = w.newSub();
  const a = await w.subscribe(s);
  const b = await w.subscribe(s, { timezone: 'Europe/London' });
  eq(b.j.created, false, 'not created'); eq(b.j.deviceId, a.j.deviceId, 'same device id');
  eq(w.db.T.push_devices.length, 1, 'one row'); eq(w.db.T.push_devices[0].timezone, 'Europe/London', 'updated tz');
});

test('D3 same endpoint under a different client → 409, original row untouched', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  const snapshot = JSON.stringify(w.db.T.push_devices);
  const r = await w.call({ type: 'pushSubscribe', storageKey: '_push_canary2', token: SECOND_TOKEN, subscription: s.json });
  eq(r.status, 409, 'conflict'); eq(r.j.error, 'endpoint_conflict', 'error');
  eq(JSON.stringify(w.db.T.push_devices), snapshot, 'unchanged');
});

test('D4 invalid timezone is dropped, not stored', async () => {
  const w = await world();
  await w.subscribe(w.newSub(), { timezone: 'Mars/Olympus_Mons' });
  await w.subscribe(w.newSub(), { timezone: '<script>' });
  assert(w.db.T.push_devices.every((d) => d.timezone === null), 'null timezones');
});

test('D5 device cap per client', async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) eq((await w.subscribe(w.newSub())).j.ok, true, 'device ' + i);
  eq((await w.subscribe(w.newSub())).j.error, 'too_many_devices', 'sixth refused');
});

test('D6 pushStatus: returns VAPID public key + registration, never endpoint/keys', async () => {
  const w = await world(); const s = w.newSub();
  let r = await w.call({ type: 'pushStatus', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.ok, true, 'ok'); eq(r.j.vapidPublicKey, w.vapid.publicB64, 'public key'); eq(r.j.registered, false, 'not yet');
  await w.subscribe(s);
  r = await w.call({ type: 'pushStatus', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.registered, true, 'registered');
  r = await w.call({ type: 'pushStatus', storageKey: '_push_canary2', token: SECOND_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.registered, false, "another client can't see this device");
  eq(r.j.deviceStatus, null, 'no status leak');
  assertNoLeak(w);
});

test('D7 unsubscribe revokes + wipes endpoint/keys; scoped to the caller', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  const foreign = await w.call({ type: 'pushUnsubscribe', storageKey: '_push_canary2', token: SECOND_TOKEN, endpoint: s.json.endpoint });
  eq(foreign.j.revoked, false, "other client can't revoke");
  eq(w.db.T.push_devices[0].status, 'active', 'still active');
  const r = await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.revoked, true, 'revoked');
  const d = w.db.T.push_devices[0];
  eq(d.status, 'revoked', 'status'); eq(d.endpoint, '', 'endpoint wiped'); eq(d.p256dh, '', 'p256dh wiped'); eq(d.auth_secret, '', 'auth wiped');
  eq((await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint })).j.revoked, false, 'idempotent');
  const sent = await w.send();
  eq(sent.j.status, 'suppressed', 'no send after unsubscribe'); eq(sent.j.reason, 'no_active_device', 'reason');
  eq(w.svc.received.length, 0, 'nothing delivered');
  // Re-subscribing the same browser later reactivates the row with fresh keys.
  eq((await w.subscribe(s)).j.created, false, 'reactivated in place');
  eq(w.db.T.push_devices[0].status, 'active', 'active again');
});

test('D8 unsubscribe requires auth', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  eq((await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: 'bad'.repeat(10), endpoint: s.json.endpoint })).status, 401, '401');
  eq(w.db.T.push_devices[0].status, 'active', 'untouched');
});

// ════════════════════════════════════════════════════════════════════════════
// E. Sending
// ════════════════════════════════════════════════════════════════════════════
test('E1 coach test send: encrypted, VAPID-signed, lock-screen-safe payload, logged', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  const r = await w.send();
  eq(r.j.ok, true, 'ok'); eq(r.j.status, 'sent', 'sent');
  eq(w.svc.received.length, 1, 'one push');
  const p = w.svc.received[0].payload;
  eq(p.title, 'LOCKED IN', 'title'); eq(p.url, './', 'url is scope-relative'); eq(p.kind, 'test', 'kind');
  eq(w.svc.received[0].headers.Topic, 'li-test', 'topic');
  const ev = w.db.T.notification_events[0];
  eq(ev.status, 'sent', 'event status'); eq(ev.success_count, 1, 'success count'); eq(ev.created_by, 'coach', 'created_by');
  assert(!JSON.stringify(ev.results).includes(s.json.endpoint), 'results never hold the endpoint');
  assert(w.db.T.push_devices[0].last_success_at, 'last_success_at set');
  assertNoLeak(w);
});

test('E2 duplicate requestId → no second push', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  const a = await w.send({ requestId: 'fixed_request_0001' });
  const b = await w.send({ requestId: 'fixed_request_0001' });
  eq(b.j.duplicate, true, 'duplicate'); eq(b.j.eventId, a.j.eventId, 'same event');
  eq(w.svc.received.length, 1, 'exactly one push'); eq(w.db.T.notification_events.length, 1, 'one event');
});

test('E3 410 Gone → device expired + wiped; next send suppressed', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  w.svc.setStatus(() => 410);
  const r = await w.send();
  eq(r.j.status, 'failed', 'event failed'); eq(r.j.results[0].outcome, 'expired', 'outcome');
  const d = w.db.T.push_devices[0];
  eq(d.status, 'expired', 'expired'); eq(d.disabled_reason, 'push_service_410', 'reason');
  eq(d.endpoint + d.p256dh + d.auth_secret, '', 'wiped');
  eq((await w.send()).j.reason, 'no_active_device', 'next send suppressed');
});

test('E4 404 → expired; 5xx/429/network → counted failure, device kept; 5 failures → disabled', async () => {
  let w = await world(); await w.subscribe(w.newSub());
  w.svc.setStatus(() => 404); await w.send();
  eq(w.db.T.push_devices[0].status, 'expired', '404 expires');

  w = await world(); await w.subscribe(w.newSub());
  const seq = [500, 429, 'throw', 503];
  let i = 0; w.svc.setStatus(() => seq[i++]);
  for (let k = 0; k < 4; k++) await w.send();
  eq(w.db.T.push_devices[0].status, 'active', 'still active after 4 transient failures');
  eq(w.db.T.push_devices[0].failure_count, 4, 'failure count');
  w.svc.setStatus(() => 500); await w.send();
  eq(w.db.T.push_devices[0].status, 'disabled', 'disabled after 5');
  w.svc.setStatus(() => 201);
  eq((await w.send()).j.reason, 'no_active_device', 'disabled device not used');
});

test('E5 partial: one device ok, one gone', async () => {
  const w = await world();
  const a = w.newSub(); const b = w.newSub('fcm.googleapis.com');
  await w.subscribe(a); await w.subscribe(b);
  w.svc.setStatus((url) => url === a.json.endpoint ? 201 : 410);
  const r = await w.send();
  eq(r.j.status, 'partial', 'partial'); eq(w.svc.received.length, 2, 'both attempted');
});

test('E6 access revoked after subscribing → send suppressed', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  w.db.T.client_sessions[0].access_status = 'revoked';
  const r = await w.send();
  eq(r.j.status, 'suppressed', 'suppressed'); eq(r.j.reason, 'access_not_active', 'reason');
  eq(w.svc.received.length, 0, 'nothing sent');
});

test('E7 only fixed templates; bad requestId refused', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  eq((await w.send({ template: 'custom', title: 'Your weight is 92kg' })).j.error, 'unknown_template', 'no free text');
  eq((await w.send({ requestId: 'short' })).j.error, 'bad_requestId', 'short id');
  eq((await w.send({ requestId: 'has spaces in it' })).j.error, 'bad_requestId', 'spaces');
  eq(w.svc.received.length, 0, 'nothing sent');
});

test('E8 templates are lock-screen safe (no numbers, no body/health terms)', async () => {
  for (const [k, t] of Object.entries(H.TEMPLATES)) {
    const text = t.title + ' ' + t.body;
    assert(!/\d/.test(text), k + ': no digits');
    assert(!/\b(kg|kgs|lb|lbs|kcal|calorie|calories|protein|carb|carbs|fat|macro|macros|weight|weigh-in|bmi|body)\b/i.test(text), k + ': no health terms');
    assert(/^\.\/[A-Za-z0-9#_-]*$/.test(t.url), k + ': url is scope-relative');
  }
});

test('E9 daily cap', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  for (let i = 0; i < 20; i++) await w.send();
  eq((await w.send()).j.error, 'daily_cap_reached', 'capped at 20/day');
  eq(w.svc.received.length, 20, '20 delivered');
});

test('E10 VAPID not configured → fail closed everywhere', async () => {
  const w = await world({ noVapid: true });
  eq((await w.subscribe(w.newSub())).j.error, 'push_not_configured', 'subscribe');
  eq((await w.send()).j.error, 'push_not_configured', 'send');
  eq((await w.call('ping', 'GET')).j.configured, false, 'ping says not configured');
  eq(w.db.T.push_devices.length + w.db.T.notification_events.length, 0, 'nothing written');
});

test('E11 ping exposes nothing sensitive', async () => {
  const w = await world();
  const r = await w.call('ping', 'GET');
  eq(r.j.ok, true, 'ok'); eq(r.j.configured, true, 'configured');
  eq(Object.keys(r.j).sort().join(','), 'configured,ok,v', 'only ok/v/configured');
});

// ════════════════════════════════════════════════════════════════════════════
// F. Service worker (sw.js executed in a sandbox)
// ════════════════════════════════════════════════════════════════════════════
const SCOPE = 'https://omarsoubra.github.io/DASHBOARD/clients/_push_canary/';
function loadSw() {
  const listeners = {};
  const shown = [], opened = [], focused = [];
  let windows = [];
  const self = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    registration: { scope: SCOPE, showNotification: (title, o) => { shown.push({ title, o }); return Promise.resolve(); } },
    location: { href: 'https://omarsoubra.github.io/DASHBOARD/sw.js' },
    clients: {
      matchAll: async () => windows,
      openWindow: async (u) => { opened.push(u); },
      claim: async () => {},
    },
    skipWaiting: () => {},
  };
  const ctx = vm.createContext({ self, URL, caches: { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], match: async () => null }, fetch: async () => new Response(''), Promise, console });
  vm.runInContext(rd('sw.js'), ctx);
  const fire = async (type, ev) => {
    const waits = [];
    ev.waitUntil = (p) => waits.push(p);
    for (const fn of listeners[type] || []) fn(ev);
    await Promise.all(waits);
  };
  return { listeners, shown, opened, focused, fire, setWindows: (w) => { windows = w; } };
}

test('F1 sw.js keeps its existing handlers and adds push', async () => {
  const sw = loadSw();
  for (const t of ['install', 'activate', 'fetch', 'notificationclick', 'push']) assert(sw.listeners[t] && sw.listeners[t].length === 1, 'one ' + t + ' listener');
});

test('F2 push: always shows a notification; click URL confined to scope', async () => {
  const sw = loadSw();
  const cases = [
    [{ title: 'LOCKED IN', body: 'b', url: './' }, SCOPE],
    [{ title: 'T', url: './#checkin' }, SCOPE + '#checkin'],
    [{ title: 'T', url: 'https://evil.example/phish' }, SCOPE],
    [{ title: 'T', url: '//evil.example/x' }, SCOPE],
    [{ title: 'T', url: '../zac/' }, SCOPE],
    [{ title: 'T', url: '/DASHBOARD/coach_dashboard.html' }, SCOPE],
    [{ title: 'T', url: 'javascript:alert(1)' }, SCOPE],
    [{ title: 'T', url: 42 }, SCOPE],
  ];
  for (const [payload, expectUrl] of cases) {
    await sw.fire('push', { data: { json: () => payload } });
    eq(sw.shown.at(-1).o.data.url, expectUrl, 'click url for ' + JSON.stringify(payload.url));
  }
  await sw.fire('push', { data: null });
  eq(sw.shown.at(-1).title, 'LOCKED IN', 'empty push still shows');
  await sw.fire('push', { data: { json: () => { throw new Error('bad'); } } });
  eq(sw.shown.at(-1).title, 'LOCKED IN', 'malformed push still shows');
  await sw.fire('push', { data: { json: () => ({ title: 'x'.repeat(500), tag: 'bad tag!' }) } });
  eq(sw.shown.at(-1).title.length, 80, 'title clamped'); eq(sw.shown.at(-1).o.tag, 'locked-in', 'bad tag replaced');
});

test('F3 notificationclick: opens only in-scope URLs; focuses existing window', async () => {
  const sw = loadSw();
  const note = (url) => ({ notification: { close() {}, data: { url } } });
  await sw.fire('notificationclick', note('https://evil.example/'));
  eq(sw.opened.at(-1), SCOPE, 'evil → scope');
  await sw.fire('notificationclick', note(SCOPE + '#x'));
  eq(sw.opened.at(-1), SCOPE + '#x', 'in-scope kept');
  let focusedCount = 0;
  sw.setWindows([{ url: SCOPE, focus: async () => { focusedCount++; } }]);
  const before = sw.opened.length;
  await sw.fire('notificationclick', note(SCOPE));
  eq(focusedCount, 1, 'focused'); eq(sw.opened.length, before, 'no new window');
});

// ════════════════════════════════════════════════════════════════════════════
// G. Static security + isolation
// ════════════════════════════════════════════════════════════════════════════
const CLIENT_VISIBLE = ['push-client.js', 'sw.js', 'clients/_push_canary/index.html', 'clients/_push_canary/manifest.json'];

test('G1 no secrets in any client-visible file', async () => {
  const patterns = [
    [/service_role/i, 'service role'], [/SUPABASE_SERVICE/i, 'service key name'], [/VAPID_PRIVATE/i, 'vapid private name'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'], [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub PAT'],
    [/\bsb_secret_/, 'supabase secret key'], [/COACH_PASSWORD/i, 'coach secret name'], [/coachToken/, 'coach token field'],
    [/\b[A-Za-z0-9_-]{43}\b/, '43-char base64url (32-byte key-shaped)'],
    [/\b[a-f0-9]{64}\b/, '64-hex (sha256-shaped secret)'],
  ];
  for (const f of CLIENT_VISIBLE) {
    const src = rd(f);
    for (const [re, label] of patterns) assert(!re.test(src), `${f}: contains ${label}`);
  }
});

test('G2 permission requested ONLY inside the Turn-on tap handler', async () => {
  const src = rd('push-client.js');
  const hits = src.match(/requestPermission/g) || [];
  eq(hits.length, 1, 'exactly one requestPermission call');
  const start = src.indexOf('Push.prototype._onEnable = function');
  const end = src.indexOf('Push.prototype._onDisable');
  const at = src.indexOf('requestPermission');
  assert(start > 0 && at > start && at < end, 'it is inside _onEnable');
  assert(/addEventListener\('click', handler\)/.test(src), '_onEnable is wired to a click');
  assert(!/requestPermission|new Notification\(/.test(rd('clients/_push_canary/index.html')), 'canary shell never prompts on its own');
  assert(!/setTimeout\([^)]*requestPermission/.test(src), 'no timer prompt');
});

test('G3 token never placed in a URL, the console or innerHTML by push-client.js', async () => {
  const src = rd('push-client.js');
  assert(!/innerHTML/.test(src), 'no innerHTML');
  assert(!/console\.(log|info|warn|error)/.test(src), 'no console output');
  assert(!/[?&]token=/.test(src), 'no token query param');
  assert(/token: this\.o\.getToken\(\)/.test(src), 'token only in POST body');
});

test('G4 canary shell is isolated: canary key only, push endpoint only, never api', async () => {
  const src = rd('clients/_push_canary/index.html');
  assert(/storageKey: '_push_canary'/.test(src), 'canary key');
  assert(!/functions\/v1\/api/.test(src), 'no api calls');
  assert(/functions\/v1\/push'/.test(src), 'push endpoint');
  assert(/Content-Security-Policy/.test(src), 'CSP present');
  assert(/history\.replaceState/.test(src), 'strips ?t= from the address bar');
  const man = JSON.parse(rd('clients/_push_canary/manifest.json'));
  eq(man.display, 'standalone', 'standalone'); eq(man.scope, './', 'scope'); eq(man.start_url, './', 'no token in start_url');
});

test('G5 migration is additive + locked down', async () => {
  const live = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/\bdrop\b/i.test(live), 'no DROP outside the commented DOWN block');
  assert(!/alter table public\.(clients|client_sessions|programs|weight_logs|check_ins)/i.test(live), 'no existing table altered');
  for (const t of ['push_devices', 'notification_events']) {
    assert(new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(live), t + ' RLS');
    assert(new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`).test(live), t + ' revoke');
    assert(!new RegExp(`create policy[^;]*${t}`, 'i').test(live), t + ' has no policy (default deny)');
  }
  assert(/unique \(endpoint_hash\)/.test(live) && /unique \(dedupe_key\)/.test(live), 'unique constraints');
});

test('G6 the existing api function and the sw.js cache/fetch logic are untouched', async () => {
  let head;
  try { head = execSync('git show HEAD:sw.js', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { head = null; }
  if (head !== null) {
    const cut = (s, marker) => s.slice(0, s.indexOf(marker));
    const was = head.includes('// Notification handling') ? cut(head, '// Notification handling') : cut(head, '// ───────────────────────────────────────────────────────────────────────── \n// LOCKED IN Push');
    const now = cut(rd('sw.js'), '// ─────────────────────────────────────────────────────────────────────────\n// LOCKED IN Push');
    eq(now, was, 'install/activate/fetch section byte-identical to HEAD');
    let apiDirty = false;
    try { execSync('git diff --quiet HEAD -- supabase/functions/api', { cwd: ROOT, stdio: 'ignore' }); } catch { apiDirty = true; }
    eq(apiDirty, false, 'supabase/functions/api has no changes');
  }
  assert(/const CACHE_NAME = 'strengthbyo-v4-2026-08-30-pwa-refresh';/.test(rd('sw.js')), 'CACHE_NAME not bumped (no forced reload for existing users)');
});

test('G7 handler never follows redirects and caps work per call', async () => {
  const wp = rd('supabase/functions/push/webpush.ts');
  const h = rd('supabase/functions/push/handler.ts');
  assert(/redirect: 'manual'/.test(wp), 'redirect manual');
  assert(/limit\(MAX_DEVICES_PER_SEND\)/.test(h), 'device fan-out bounded');
  assert(!/\bwhile\s*\(/.test(h + wp), 'no while loops (Rule 2)');
});

// ════════════════════════════════════════════════════════════════════════════
(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log('  PASS  ' + t.name); }
    catch (e) { fail++; console.log('  FAIL  ' + t.name + '\n        ' + (e && e.message)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\npush_proof: ${pass} passed, ${fail} failed, ${tests.length} total`);
  process.exit(fail ? 1 : 0);
})();
