// Shared harness for the LOCKED IN push test suites (push_proof, push_v1).
//
// 0 production invocations. Loads the REAL shipped source (webpush.ts,
// schedule.ts, handler.ts — transpiled with typescript) and runs it against:
//   * an in-memory Supabase stand-in whose push tables/columns are parsed from
//     the push migrations — an unknown column is an error, so handler ↔ schema
//     drift fails the tests;
//   * a fake push service that DECRYPTS every message with node:crypto and
//     VERIFIES the VAPID JWT (signature, audience, expiry).
'use strict';
const ts = require('typescript');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');

const ROOT = process.cwd();
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── load the real TS source ─────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-tests-'));
function transpile(src, out) {
  const js = ts.transpileModule(rd(src), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText.replace(/require\("\.\/(webpush|schedule)\.ts"\)/g, 'require("./$1.js")');
  fs.writeFileSync(path.join(tmp, out), js);
}
transpile('supabase/functions/push/webpush.ts', 'webpush.js');
transpile('supabase/functions/push/schedule.ts', 'schedule.js');
transpile('supabase/functions/push/handler.ts', 'handler.js');
const WP = require(path.join(tmp, 'webpush.js'));
const SCH = require(path.join(tmp, 'schedule.js'));
const H = require(path.join(tmp, 'handler.js'));

// ── tiny runner ─────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`ASSERT: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function run(label) {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log('  PASS  ' + t.name); }
    catch (e) { fail++; console.log('  FAIL  ' + t.name + '\n        ' + (e && e.message)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${label}: ${pass} passed, ${fail} failed, ${tests.length} total`);
  process.exit(fail ? 1 : 0);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const sha256hex = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');

// ════════════════════════════════════════════════════════════════════════════
// Schema from the push migrations (CREATE TABLE + ALTER TABLE ... ADD COLUMN)
// ════════════════════════════════════════════════════════════════════════════
const MIGRATION = rd('supabase/migrations/20260928120000_push_notifications_proof.sql');
const MIGRATION_V1 = rd('supabase/migrations/20260929120000_push_v1_pilot.sql');
const ALL_MIGRATIONS = MIGRATION + '\n' + MIGRATION_V1;
const COL_RE = /^([a-z][a-z0-9_]*)\s+(uuid|text|boolean|integer|smallint|timestamptz|jsonb|time)\b/;
function parseColumns(table) {
  const cols = new Set();
  const m = ALL_MIGRATIONS.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error('migration: table not found ' + table);
  for (const line of m[1].split('\n')) { const c = line.trim().match(COL_RE); if (c) cols.add(c[1]); }
  const alter = new RegExp(`alter table public\\.${table} add column if not exists ([a-z][a-z0-9_]*)`, 'g');
  for (const a of ALL_MIGRATIONS.matchAll(alter)) cols.add(a[1]);
  return cols;
}
function parseCheckList(table, constraint) {
  const re = new RegExp(`alter table public\\.${table} add constraint ${constraint}\\s+check \\(([\\s\\S]*?)\\);`);
  const m = MIGRATION_V1.match(re);
  if (!m) throw new Error('migration: constraint not found ' + constraint);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}
const SCHEMA = {
  push_devices: parseColumns('push_devices'),
  notification_events: parseColumns('notification_events'),
  push_preferences: parseColumns('push_preferences'),
  push_internal_auth: parseColumns('push_internal_auth'),
  // Existing tables: only the columns the push function touches (all exist in production).
  clients: new Set(['id', 'storage_key', 'is_paused', 'start_date']),
  client_sessions: new Set(['storage_key', 'token_hash', 'salt', 'access_status', 'client_id']),
  weight_logs: new Set(['id', 'client_id', 'client_key', 'logged_at', 'weight_kg']),
  check_ins: new Set(['id', 'client_id', 'client_key', 'submitted_at', 'week_number']),
};
const KINDS = parseCheckList('notification_events', 'notification_events_kind_check');
const STATUSES = parseCheckList('notification_events', 'notification_events_status_check');
const REASONS = parseCheckList('notification_events', 'notification_events_suppression_reason_check');
const UNIQUE = {
  push_devices: ['endpoint_hash'], notification_events: ['dedupe_key'], clients: ['storage_key'],
  client_sessions: ['storage_key'], push_preferences: ['client_id'], push_internal_auth: ['name'],
};
const CHECKS = {
  push_devices: (r) => ['active', 'revoked', 'expired', 'disabled'].includes(r.status) &&
    (r.status !== 'active' || (r.endpoint && r.p256dh && r.auth_secret)) && /^[0-9a-f]{64}$/.test(r.endpoint_hash),
  notification_events: (r) => KINDS.includes(r.kind) && STATUSES.includes(r.status || 'claimed') &&
    ['coach', 'system', 'client'].includes(r.created_by) && (r.suppression_reason == null || REASONS.includes(r.suppression_reason)),
  push_preferences: (r) => !r.notifications_enabled || !!r.consent_at,
};
const PREF_DEFAULTS = {
  notifications_enabled: false, consent_at: null, timezone: null, weighin_available: false, weighin_enabled: true,
  weighin_time: '07:30:00', checkin_enabled: true, checkin_dow: 0, checkin_time: '09:00:00',
  program_updates_enabled: true, quiet_start: '21:00:00', quiet_end: '07:00:00', updated_by: 'client',
};

// ════════════════════════════════════════════════════════════════════════════
// In-memory Supabase stand-in (strict)
// ════════════════════════════════════════════════════════════════════════════
function makeDb() {
  const T = { clients: [], client_sessions: [], push_devices: [], notification_events: [], push_preferences: [], push_internal_auth: [], weight_logs: [], check_ins: [] };
  const calls = [];
  let seq = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
  const colErr = (t, c) => ({ message: `column ${t}.${c} does not exist`, code: '42703' });
  const fail = { on: null };              // test hook: make a table's reads fail

  function checkCols(t, cols) { for (const c of cols) if (!SCHEMA[t].has(c)) return colErr(t, c); return null; }
  function parseSelect(s) {
    const cols = []; let embedded = null;
    for (const part of String(s).split(',').map((x) => x.trim()).filter(Boolean)) {
      const e = part.match(/^([a-z_]+)\(([a-z_, ]+)\)$/);
      if (e) { embedded = { table: e[1], cols: e[2].split(',').map((x) => x.trim()) }; continue; }
      cols.push(part);
    }
    return { cols, embedded };
  }
  function project(row, sel) {
    const o = {};
    for (const c of sel.cols) o[c] = row[c];
    if (sel.embedded && sel.embedded.table === 'clients') {
      const cl = T.clients.find((c) => c.id === row.client_id);
      o.clients = cl ? Object.fromEntries(sel.embedded.cols.map((c) => [c, cl[c]])) : null;
    }
    return o;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const norm = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);

  function from(t) {
    if (!T[t]) throw new Error('stand-in: unknown table ' + t);
    const q = { filters: [], mode: 'select', sel: null, opts: {}, limitN: null, payload: null, returning: null };
    const b = {};
    const matchRow = (r) => q.filters.every(([op, c, v]) => {
      if (op === 'eq') return r[c] === v;
      if (op === 'in') return v.includes(r[c]);
      const x = norm(r[c]), y = norm(v);
      if (x == null) return false;
      if (op === 'gte') return cmp(x, y) >= 0;
      if (op === 'lt') return cmp(x, y) < 0;
      if (op === 'lte') return cmp(x, y) <= 0;
      return false;
    });
    b.select = (s = '*', opts = {}) => { if (q.mode === 'select') { q.sel = parseSelect(s); q.opts = opts; } else q.returning = parseSelect(s); return b; };
    for (const op of ['eq', 'gte', 'lt', 'lte']) b[op] = (c, v) => { q.filters.push([op, c, v]); return b; };
    b.in = (c, v) => { q.filters.push(['in', c, v]); return b; };
    b.limit = (n) => { q.limitN = n; return b; };
    b.insert = (obj) => { q.mode = 'insert'; q.payload = obj; return b; };
    b.update = (obj) => { q.mode = 'update'; q.payload = obj; return b; };

    function run() {
      calls.push({ t, mode: q.mode, filters: q.filters.map((f) => f.slice()) });
      if (fail.on === t && q.mode === 'select') return { data: null, error: { message: 'simulated outage', code: 'XX000' }, count: null };
      const fe = checkCols(t, q.filters.map((f) => f[1]));
      if (fe) return { data: null, error: fe };
      if (q.mode === 'select') {
        const se = checkCols(t, q.sel.cols); if (se) return { data: null, error: se };
        let rows = T[t].filter(matchRow);
        if (q.limitN != null) rows = rows.slice(0, q.limitN);
        if (q.opts.count === 'exact' && q.opts.head) return { data: null, error: null, count: rows.length };
        return { data: rows.map((r) => project(r, q.sel)), error: null };
      }
      if (q.mode === 'insert') {
        const ce = checkCols(t, Object.keys(q.payload)); if (ce) return { data: null, error: ce };
        const row = { ...(t === 'push_preferences' ? PREF_DEFAULTS : {}), ...(t === 'push_preferences' ? {} : { id: uuid() }), ...q.payload };
        if (t === 'notification_events' && !row.status) row.status = 'claimed';
        for (const u of UNIQUE[t] || []) {
          if (T[t].some((r) => r[u] === row[u])) return { data: null, error: { message: `duplicate key value violates unique constraint "${t}_${u}_key"`, code: '23505' } };
        }
        if (CHECKS[t] && !CHECKS[t](row)) return { data: null, error: { message: `new row for relation "${t}" violates check constraint`, code: '23514' } };
        T[t].push(row);
        return { data: q.returning ? [project(row, q.returning)] : null, error: null };
      }
      if (q.mode === 'update') {
        const ce = checkCols(t, Object.keys(q.payload)); if (ce) return { data: null, error: ce };
        const hits = T[t].filter(matchRow);
        for (const r of hits) { if (CHECKS[t] && !CHECKS[t]({ ...r, ...q.payload })) return { data: null, error: { message: 'check constraint violation', code: '23514' } }; }
        for (const r of hits) Object.assign(r, q.payload);
        return { data: q.returning ? hits.map((r) => project(r, q.returning)) : null, error: null };
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
  return { admin: { from }, T, calls, uuid, fail };
}

// ════════════════════════════════════════════════════════════════════════════
// Fixtures: clients, tokens, VAPID keys, browser subscriptions
// ════════════════════════════════════════════════════════════════════════════
const CANARY = '_push_canary';
const OTHER = 'zac';                          // a real-looking key that is NOT allow-listed by default
const CANARY_TOKEN = 'canarytoken_' + nodeCrypto.randomBytes(16).toString('hex');
const OTHER_TOKEN = 'othertoken_' + nodeCrypto.randomBytes(16).toString('hex');
const SECOND_TOKEN = 'secondtoken_' + nodeCrypto.randomBytes(16).toString('hex');
const COACH_HASH = sha256hex('coach-password-for-tests');
const CRON_SECRET = 'cron_' + nodeCrypto.randomBytes(32).toString('hex');
const DEPLOY_SECRET = 'deploy_' + nodeCrypto.randomBytes(32).toString('hex');

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
  return { ecdh, auth, json: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
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
function makePushService(subsByEndpoint, vapidPublicB64, clock) {
  const received = [];
  let statusFor = () => 201;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    eq(init.method, 'POST', 'push is POST');
    eq(init.redirect, 'manual', 'push never follows redirects');
    eq(init.headers['Content-Encoding'], 'aes128gcm', 'Content-Encoding');
    assert(/^\d+$/.test(init.headers.TTL), 'TTL header');
    assert(['very-low', 'low', 'normal', 'high'].includes(init.headers.Urgency), 'Urgency header');
    verifyVapidHeader(init.headers.Authorization, u.origin, vapidPublicB64, Math.floor(clock() / 1000));
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

// A complete world: DB rows, env, handler, push service, captured logs, a clock.
async function world(opts = {}) {
  const db = makeDb();
  const canaryId = db.uuid(), otherId = db.uuid(), secondId = db.uuid();
  db.T.clients.push(
    { id: canaryId, storage_key: CANARY, is_paused: false, start_date: null },
    { id: otherId, storage_key: OTHER, is_paused: false, start_date: null },
    { id: secondId, storage_key: '_push_canary2', is_paused: false, start_date: null });
  const salt1 = 's1' + nodeCrypto.randomBytes(8).toString('hex');
  const salt2 = 's2' + nodeCrypto.randomBytes(8).toString('hex');
  const salt3 = 's3' + nodeCrypto.randomBytes(8).toString('hex');
  db.T.client_sessions.push(
    { client_id: canaryId, storage_key: CANARY, token_hash: sha256hex(CANARY_TOKEN + salt1), salt: salt1, access_status: opts.canaryAccess ?? 'active' },
    { client_id: otherId, storage_key: OTHER, token_hash: sha256hex(OTHER_TOKEN + salt2), salt: salt2, access_status: 'active' },
    { client_id: secondId, storage_key: '_push_canary2', token_hash: sha256hex(SECOND_TOKEN + salt3), salt: salt3, access_status: 'active' },
  );
  if (opts.internal !== false) {
    db.T.push_internal_auth.push({ name: 'cron', secret_sha256: sha256hex(CRON_SECRET) }, { name: 'deploy', secret_sha256: sha256hex(DEPLOY_SECRET) });
  }
  const vapid = opts.vapid ?? await makeVapid();
  const env = {
    vapidPublicKey: vapid.publicB64,
    vapidPrivateKey: opts.noVapid ? '' : vapid.privateB64,
    vapidSubject: 'https://omarsoubra.github.io/DASHBOARD/',
    coachPasswordHash: COACH_HASH,
    allowedClients: new Set(opts.allowed ?? [CANARY, '_push_canary2']),
  };
  const clock = { now: opts.now ?? Date.UTC(2026, 8, 28, 9, 0, 0) };
  const subs = new Map();
  const svc = makePushService(subs, vapid.publicB64, () => clock.now);
  const logs = [];
  const handle = H.makePushHandler({ admin: db.admin, env, fetchImpl: svc.fetchImpl, now: () => clock.now, log: (...a) => logs.push(a.join(' | ')) });
  const responses = [];
  async function call(body, method = 'POST', headers = {}) {
    const req = method === 'GET'
      ? new Request('https://x.supabase.co/functions/v1/push?type=' + body)
      : new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const r = await handle(req);
    const text = await r.text();
    responses.push(text);
    return { status: r.status, j: JSON.parse(text) };
  }
  const newSub = (host) => { const s = makeBrowserSub(host); subs.set(s.json.endpoint, s); return s; };
  const subscribe = (s, extra = {}) => call({ type: 'pushSubscribe', storageKey: CANARY, token: CANARY_TOKEN, subscription: s.json, timezone: 'Australia/Sydney', standalone: true, ...extra });
  let rid = 0;
  const send = (extra = {}) => call({ type: 'coachPushSend', coachToken: COACH_HASH, storageKey: CANARY, template: 'test', requestId: 'req_' + String(++rid).padStart(6, '0') + '_' + nodeCrypto.randomBytes(3).toString('hex'), ...extra });
  const tick = (secret = CRON_SECRET) => call({ type: 'pushTick' }, 'POST', secret === null ? {} : { 'x-push-cron-secret': secret });
  const programUpdated = (extra = {}, secret = DEPLOY_SECRET) => call({ type: 'programUpdated', storageKey: CANARY, deployHash: sha256hex('shell-v1'), commit: 'abc1234', ...extra }, 'POST', secret === null ? {} : { 'x-push-deploy-secret': secret });
  const prefsSet = (prefs, extra = {}) => call({ type: 'pushPrefsSet', storageKey: CANARY, token: CANARY_TOKEN, prefs, ...extra });
  const prefsGet = (extra = {}) => call({ type: 'pushPrefsGet', storageKey: CANARY, token: CANARY_TOKEN, ...extra });
  return { db, env, vapid, svc, logs, responses, call, newSub, subscribe, send, tick, programUpdated, prefsSet, prefsGet, clock, canaryId, otherId, secondId };
}

// Every secret that must never leave the server or reach a log.
function assertNoLeak(w, extraSecrets = []) {
  const secrets = [w.vapid.privateB64, CANARY_TOKEN, OTHER_TOKEN, SECOND_TOKEN, COACH_HASH, CRON_SECRET, DEPLOY_SECRET, ...extraSecrets];
  const hay = w.responses.join('\n') + '\n' + w.logs.join('\n');
  for (const s of secrets) assert(!hay.includes(s), 'secret leaked into a response or log');
  for (const d of w.db.T.push_devices) {
    if (d.endpoint) assert(!w.responses.join('\n').includes(d.endpoint), 'endpoint leaked into a response');
    if (d.p256dh) assert(!w.responses.join('\n').includes(d.p256dh), 'p256dh leaked into a response');
    if (d.auth_secret) assert(!w.responses.join('\n').includes(d.auth_secret), 'auth secret leaked into a response');
  }
}

module.exports = {
  ROOT, rd, WP, SCH, H, test, tests, assert, eq, run, b64u, unb64u, sha256hex,
  MIGRATION, MIGRATION_V1, SCHEMA, KINDS, STATUSES, REASONS, makeDb,
  CANARY, OTHER, CANARY_TOKEN, OTHER_TOKEN, SECOND_TOKEN, COACH_HASH, CRON_SECRET, DEPLOY_SECRET,
  makeVapid, makeBrowserSub, nodeDecrypt, verifyVapidHeader, makePushService, world, assertNoLeak,
};
