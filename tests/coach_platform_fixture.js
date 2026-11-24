// Coach Platform V1 - the real handler source (sliced out of the Edge Function) wired to an in-memory database.
// Shared by tests/coach_platform.test.js and the local sandbox server (tests/coach_platform_sandbox.js).
const ts = require('typescript');
const fs = require('fs');
const nodeCrypto = require('crypto');
const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'supabase/functions/api/index.ts'), 'utf8');
const i = SRC.indexOf('const CP_SESSION_TTL_DAYS');
if (i < 0) throw new Error('locate coach platform handlers');
const js = ts.transpileModule(SRC.slice(i), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const M = {};
// ── in-memory supabase-js subset ────────────────────────────────────────────
const DB = { coaches: [], coach_sessions: [], plan_builds: [], clients: [], profiles: [], client_entitlements: [], client_sessions: [],
             access_log: [], client_invites: [], coach_templates: [], coach_client_state: [], coach_intakes: [], roster_snapshots: [], checkin_drafts: [], client_overrides: [], products: [], testimonials: [], programs: [], photo_uploads: [], weight_logs: [], check_ins: [], workout_log_entries: [], meal_logs: [] };
let seq = 1;
const uuid = () => nodeCrypto.randomUUID();
const DEFAULTS = {
  coach_templates: () => ({ id: uuid(), created_at: new Date().toISOString() }),
  coach_intakes: () => ({ id: uuid(), created_at: new Date().toISOString(), submitted_at: null, answers: null }),
  coaches: () => ({ id: uuid(), status: 'active', client_limit: 25, failed_logins: 0, locked_until: null, password_hash: null, password_salt: null, created_at: new Date().toISOString(), last_login_at: null }),
  coach_sessions: () => ({ id: seq++, created_at: new Date().toISOString(), revoked_at: null }),
  plan_builds: () => ({ id: uuid(), is_update: false, status: 'queued', summary: null, plan: null, error: null, page_sha256: null, claimed_at: null, published_at: null,
                        created_at: new Date(Date.now() + seq++).toISOString(), updated_at: new Date().toISOString() }),
  clients: () => ({ id: uuid(), coach_id: null, is_internal: false }),
  profiles: () => ({ id: uuid() }),
};
function table(name) {
  if (!DB[name]) DB[name] = [];
  const q = { f: [], op: 'select', payload: null, one: null, ord: null, lim: null, ret: false, conflict: null };
  const add = (fn) => { q.f.push(fn); return q; };
  q.select = () => { if (q.op !== 'select') q.ret = true; return q; };
  q.eq = (c, v) => add((r) => r[c] === v);
  q.in = (c, vs) => add((r) => vs.includes(r[c]));
  q.is = (c, v) => add((r) => (r[c] ?? null) === v);
  q.not = (c, op, v) => add((r) => !((r[c] ?? null) === v));
  q.gte = (c, v) => add((r) => r[c] >= v);
  q.gt = (c, v) => add((r) => r[c] > v);
  q.lte = (c, v) => add((r) => r[c] != null && r[c] <= v);
  q.neq = (c, v) => add((r) => r[c] !== v);
  q.like = (c, v) => add((r) => new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(String(r[c] ?? '')));
  q.range = (a, b) => { q.rng = [a, b]; return q; };
  q.lt = (c, v) => add((r) => r[c] != null && r[c] < v);
  q.order = (c, o) => { if (!q.ord) q.ord = [c, !(o && o.ascending === false)]; return q; };   // first order wins; later ones are tie-breaks
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
        const ck = q.conflict ? q.conflict.split(',').map((x) => x.trim()) : [];
        const ex = q.op === 'upsert' && ck.length ? DB[name].find((r) => ck.every((k) => r[k] === p[k])) : null;
        if (ex) { Object.assign(ex, q.payload); rows = [ex]; } else { DB[name].push(p); rows = [p]; }
      } else {
        rows = DB[name].filter((r) => q.f.every((fn) => fn(r)));
        if (q.op === 'update') rows.forEach((r) => Object.assign(r, q.payload));
        if (q.op === 'delete') { DB[name] = DB[name].filter((r) => !rows.includes(r)); }
        if (q.ord) rows = rows.slice().sort((a, b) => (a[q.ord[0]] < b[q.ord[0]] ? -1 : a[q.ord[0]] > b[q.ord[0]] ? 1 : 0) * (q.ord[1] ? 1 : -1));
        if (q.rng) rows = rows.slice(q.rng[0], q.rng[1] + 1);
        if (q.lim != null) rows = rows.slice(0, q.lim);
      }
      const copy = rows.map((r) => JSON.parse(JSON.stringify(r)));
      if (q.one) return res({ data: copy[0] ?? null, error: (!copy[0] && q.one === 'single') ? { message: 'no rows' } : null });
      return res({ data: (q.op === 'select' || q.ret) ? copy : null, error: null });
    } catch (e) { return rej ? rej(e) : res({ data: null, error: { message: String(e) } }); }
  };
  return q;
}
const rawAdmin = { from: table, storage: { from: () => ({ createSignedUrls: async (paths, ttl) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'https://signed.example/' + p + '?ttl=' + ttl })) }) }) } };
// Handlers see the same tenant-scoped client as production: plain for Omar and cp* calls, narrowed inside a coach's dashboard request.
const admin = { from: (t) => M.tenantAdmin(rawAdmin).from(t), storage: rawAdmin.storage };
const { AsyncLocalStorage } = require('async_hooks');
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const OMAR = 'omar-coach-token-hash', OMAR_HASH = OMAR;
const verifyCoachToken = (t) => t === OMAR;
const sha256 = async (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => nodeCrypto.randomBytes(32).toString('base64url');
const BUILDER_KEY = 'builder-key-' + 'x'.repeat(40);
const Deno = { env: { get: (k) => (k === 'CP_BUILDER_KEY_SHA256' ? nodeCrypto.createHash('sha256').update(BUILDER_KEY).digest('hex') : undefined) } };
const logEfError = () => {};

const NAMES = ['cpRegistry', 'tenantAdmin', 'tenantScope', 'TENANT', 'TENANT_TYPES', 'TENANT_RULES', 'cpIntakeCreate', 'cpIntakeInspect', 'cpIntakeSubmit', 'cpIntakes', 'cpIntakeClose', 'cpClientNote', 'cpCheckinReviewed', 'cpNeeds', 'cpTemplateSave', 'cpTemplates', 'cpTemplateDelete', 'cpClientPhotos', 'cpSettingsSave', 'cpRebrandAll', 'cpBrand', 'cpClientInvite', 'cpCoachCreate', 'cpCoachList', 'cpCoachSetStatus', 'cpSetupInspect', 'cpSetup', 'cpLogin', 'cpLogout', 'cpMe', 'cpBuildCreate', 'cpBuildGet',
  'cpBuildDiscard', 'cpPublish', 'cpClients', 'cpClient', 'cpClientLink', 'cpClientAccess', 'cpWorkerClaim', 'cpWorkerDone', 'cpStorageKey'];
new Function('COACH_SETTINGS_KEY', 'rawAdmin', 'AsyncLocalStorage', 'COACH_PASSWORD_HASH', 'admin', 'ok', 'err', 'verifyCoachToken', 'sha256', 'randomToken', 'Deno', 'logEfError', 'LEGACY_PRODUCT_CODE', 'crypto', 'PHOTO_BUCKET', 'SIGNED_URL_TTL_SEC', 'exports',
  js + '\nObject.assign(exports, { ' + NAMES.join(', ') + ' });')('_coach', rawAdmin, AsyncLocalStorage, OMAR_HASH, admin, ok, err, verifyCoachToken, sha256, randomToken, Deno, logEfError, 'locked_in_1to1', globalThis.crypto, 'progress-photos', 3600, M);

module.exports = { M, DB, admin, rawAdmin, BUILDER_KEY_SHA: nodeCrypto.createHash('sha256').update(BUILDER_KEY).digest('hex'), OMAR_HASH, OMAR, BUILDER_KEY, uuid, nodeCrypto };
