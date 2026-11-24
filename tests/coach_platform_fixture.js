// Coach Platform V1 - the real handler source (sliced out of the Edge Function) wired to an in-memory database.
// Shared by tests/coach_platform.test.js and the local sandbox server (tests/coach_platform_sandbox.js).
const ts = require('typescript');
const fs = require('fs');
const nodeCrypto = require('crypto');
const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'supabase/functions/api/index.ts'), 'utf8');
const i = SRC.indexOf('const CP_SESSION_TTL_DAYS');
if (i < 0) throw new Error('locate coach platform handlers');
const js = ts.transpileModule(SRC.slice(i), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// ── in-memory supabase-js subset ────────────────────────────────────────────
const DB = { coaches: [], coach_sessions: [], plan_builds: [], clients: [], profiles: [], client_entitlements: [], client_sessions: [],
             access_log: [], weight_logs: [], check_ins: [], workout_log_entries: [], meal_logs: [] };
let seq = 1;
const uuid = () => nodeCrypto.randomUUID();
const DEFAULTS = {
  coaches: () => ({ id: uuid(), status: 'active', client_limit: 25, failed_logins: 0, locked_until: null, password_hash: null, password_salt: null, created_at: new Date().toISOString(), last_login_at: null }),
  coach_sessions: () => ({ id: seq++, created_at: new Date().toISOString(), revoked_at: null }),
  plan_builds: () => ({ id: uuid(), is_update: false, status: 'queued', summary: null, plan: null, error: null, page_sha256: null, claimed_at: null, published_at: null,
                        created_at: new Date(Date.now() + seq++).toISOString(), updated_at: new Date().toISOString() }),
  clients: () => ({ id: uuid(), coach_id: null, is_internal: false }),
  profiles: () => ({ id: uuid() }),
};
function table(name) {
  if (!DB[name]) throw new Error('unknown table ' + name);
  const q = { f: [], op: 'select', payload: null, one: null, ord: null, lim: null, ret: false, conflict: null };
  const add = (fn) => { q.f.push(fn); return q; };
  q.select = () => { if (q.op !== 'select') q.ret = true; return q; };
  q.eq = (c, v) => add((r) => r[c] === v);
  q.in = (c, vs) => add((r) => vs.includes(r[c]));
  q.is = (c, v) => add((r) => (r[c] ?? null) === v);
  q.not = (c, op, v) => add((r) => !((r[c] ?? null) === v));
  q.gte = (c, v) => add((r) => r[c] >= v);
  q.lt = (c, v) => add((r) => r[c] != null && r[c] < v);
  q.order = (c, o) => { q.ord = [c, !(o && o.ascending === false)]; return q; };
  q.limit = (n) => { q.lim = n; return q; };
  q.maybeSingle = () => { q.one = 'maybe'; return q; };
  q.single = () => { q.one = 'single'; return q; };
  q.insert = (p) => { q.op = 'insert'; q.payload = p; return q; };
  q.update = (p) => { q.op = 'update'; q.payload = p; return q; };
  q.upsert = (p, o) => { q.op = 'upsert'; q.payload = p; q.conflict = o && o.onConflict; return q; };
  q.delete = () => { q.op = 'delete'; return q; };
  q.then = (res, rej) => {
    try {
      let rows;
      if (q.op === 'insert' || q.op === 'upsert') {
        const p = Object.assign({}, (DEFAULTS[name] || (() => ({ id: seq++ })))(), q.payload);
        if (name === 'coaches' && DB.coaches.some((c) => c.email === p.email || c.slug === p.slug)) return res({ data: null, error: { message: 'duplicate key 23505' } });
        if (name === 'clients' && DB.clients.some((c) => c.storage_key === p.storage_key)) return res({ data: null, error: { message: 'duplicate key 23505' } });
        const ex = q.op === 'upsert' && q.conflict ? DB[name].find((r) => r[q.conflict] === p[q.conflict]) : null;
        if (ex) { Object.assign(ex, q.payload); rows = [ex]; } else { DB[name].push(p); rows = [p]; }
      } else {
        rows = DB[name].filter((r) => q.f.every((fn) => fn(r)));
        if (q.op === 'update') rows.forEach((r) => Object.assign(r, q.payload));
        if (q.op === 'delete') { DB[name] = DB[name].filter((r) => !rows.includes(r)); }
        if (q.ord) rows = rows.slice().sort((a, b) => (a[q.ord[0]] < b[q.ord[0]] ? -1 : a[q.ord[0]] > b[q.ord[0]] ? 1 : 0) * (q.ord[1] ? 1 : -1));
        if (q.lim != null) rows = rows.slice(0, q.lim);
      }
      const copy = rows.map((r) => JSON.parse(JSON.stringify(r)));
      if (q.one) return res({ data: copy[0] ?? null, error: (!copy[0] && q.one === 'single') ? { message: 'no rows' } : null });
      return res({ data: (q.op === 'select' || q.ret) ? copy : null, error: null });
    } catch (e) { return rej ? rej(e) : res({ data: null, error: { message: String(e) } }); }
  };
  return q;
}
const admin = { from: table };
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const OMAR = 'omar-coach-token-hash';
const verifyCoachToken = (t) => t === OMAR;
const sha256 = async (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => nodeCrypto.randomBytes(32).toString('base64url');
const BUILDER_KEY = 'builder-key-' + 'x'.repeat(40);
const Deno = { env: { get: (k) => (k === 'CP_BUILDER_KEY_SHA256' ? nodeCrypto.createHash('sha256').update(BUILDER_KEY).digest('hex') : undefined) } };
const logEfError = () => {};
const M = {};
const NAMES = ['cpCoachCreate', 'cpCoachList', 'cpCoachSetStatus', 'cpSetupInspect', 'cpSetup', 'cpLogin', 'cpLogout', 'cpMe', 'cpBuildCreate', 'cpBuildGet',
  'cpBuildDiscard', 'cpPublish', 'cpClients', 'cpClient', 'cpClientLink', 'cpClientAccess', 'cpWorkerClaim', 'cpWorkerDone', 'cpStorageKey'];
new Function('admin', 'ok', 'err', 'verifyCoachToken', 'sha256', 'randomToken', 'Deno', 'logEfError', 'LEGACY_PRODUCT_CODE', 'crypto', 'exports',
  js + '\nObject.assign(exports, { ' + NAMES.join(', ') + ' });')(admin, ok, err, verifyCoachToken, sha256, randomToken, Deno, logEfError, 'locked_in_1to1', globalThis.crypto, M);

module.exports = { M, DB, OMAR, BUILDER_KEY, uuid, nodeCrypto };
