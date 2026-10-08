// Shared sandbox for Workout Completion V1: the REAL api source (auth, entitlement
// machinery, the three WORKOUT-COMPLETION-V1 handlers) running against a strict
// in-memory stand-in whose workout_completions schema is parsed from the
// migration. Used by tests/workout_completion.test.js and by the throwaway-shell
// browser test (scripts/workouts/browser_e2e.js). 0 production invocations.
'use strict';
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/api/index.ts'), 'utf8');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261001120000_workout_completions.sql'), 'utf8');

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
  grab(/async function verifyClientToken/, '\n}'),
  grab(/async function sha256\(/, '\n}'),
  grab(/const WC_REF_RE/, '\nasync function doWrite'),
].join('\n').replace(/^type Resolved[\s\S]*?\n};\n/m, '').replace(/\nasync function doWrite$/, '\n');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// ── schema of workout_completions, parsed from the migration ───────────────
const tableSql = MIG.match(/create table if not exists public\.workout_completions \(([\s\S]*?)\n\);/)[1];
const WC_COLUMNS = new Set(tableSql.split('\n').map((l) => l.trim().match(/^([a-z_]+)\s+(uuid|text|smallint|timestamptz|date)\b/)).filter(Boolean).map((m) => m[1]));
const KINDS = [...tableSql.match(/session_kind in \(([^)]*)\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const REF_RE = new RegExp(tableSql.match(/completion_ref ~ '([^']+)'/)[1]);
const PHASE_RE = new RegExp(tableSql.match(/phase_key ~ '([^']+)'/)[1]);
function wcCheck(r) {
  const nn = ['client_id', 'storage_key', 'completion_ref', 'phase_key', 'day_index', 'day_label', 'session_kind', 'completed_at', 'recorded_at', 'local_date', 'status'];
  for (const c of nn) if (r[c] === undefined || r[c] === null) return 'not-null ' + c;
  if (!REF_RE.test(r.completion_ref)) return 'check completion_ref';
  if (!PHASE_RE.test(r.phase_key)) return 'check phase_key';
  if (!(r.day_index >= 0 && r.day_index <= 13)) return 'check day_index';
  if (!(r.day_label.length >= 1 && r.day_label.length <= 120)) return 'check day_label';
  if (!KINDS.includes(r.session_kind)) return 'check session_kind';
  if (r.rx_fingerprint != null && !/^[0-9a-f]{64}$/.test(r.rx_fingerprint)) return 'check rx_fingerprint';
  if (!['completed', 'revoked'].includes(r.status)) return 'check status';
  if ((r.status === 'revoked') !== (r.revoked_at != null && r.revoked_by != null)) return 'check revoked_consistent';
  if (r.revoked_by != null && !['client', 'coach'].includes(r.revoked_by)) return 'check revoked_by';
  return null;
}

// ── strict stand-in ────────────────────────────────────────────────────────
let DB, seq, FAIL_READ;
function reset() {
  DB = { clients: [], client_sessions: [], client_entitlements: [], products: [], workout_completions: [], workout_log_entries: [] };
  seq = 0; FAIL_READ = null;
}
const norm = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
function table(name) {
  if (!DB[name]) throw new Error('stand-in: unknown table ' + name);
  const q = { f: [], mode: 'select', p: null, ret: false, order: null, lim: null, cols: null };
  const b = {};
  const hit = (r) => q.f.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'gte' ? norm(r[c]) >= norm(v) : true);
  const colsOf = (s) => String(s).split(',').map((x) => x.trim()).filter((x) => x && !x.includes('('));
  const proj = (r) => { if (!q.cols) return { ...r }; const o = {}; for (const c of q.cols) o[c] = r[c]; if (q.embed) o.clients = { storage_key: r.storage_key }; return o; };
  b.select = (s = '*') => { if (q.mode === 'select') { q.cols = s === '*' ? null : colsOf(s); q.embed = /clients\(/.test(s); } else { q.ret = true; q.cols = s === '*' ? null : colsOf(s); } return b; };
  b.eq = (c, v) => { q.f.push(['eq', c, v]); return b; };
  b.in = (c, v) => { q.f.push(['in', c, v]); return b; };
  b.gte = (c, v) => { q.f.push(['gte', c, v]); return b; };
  b.is = () => b;
  b.order = (c, o) => { q.order = [c, o && o.ascending === false ? -1 : 1]; return b; };
  b.limit = (n) => { q.lim = n; return b; };
  b.insert = (p) => { q.mode = 'insert'; q.p = p; return b; };
  b.update = (p) => { q.mode = 'update'; q.p = p; return b; };
  function badCols(cols) { if (name !== 'workout_completions') return null; for (const c of cols) if (!WC_COLUMNS.has(c)) return { message: `column workout_completions.${c} does not exist`, code: '42703' }; return null; }
  function run() {
    if (q.mode === 'select' && FAIL_READ === name) return { data: null, error: { message: 'simulated outage' } };
    const ce = badCols([...q.f.map((x) => x[1]), ...(q.cols || []), ...(q.p ? Object.keys(q.p) : [])]); if (ce) return { data: null, error: ce };
    if (q.mode === 'insert') {
      const row = { id: 'id' + (++seq), ...q.p };
      if (name === 'workout_completions') {
        const bad = wcCheck(row); if (bad) return { data: null, error: { message: 'violates ' + bad, code: '23514' } };
        if (DB[name].some((r) => r.client_id === row.client_id && r.completion_ref === row.completion_ref)) return { data: null, error: { message: 'duplicate key value violates unique constraint "workout_completions_ref_unique"', code: '23505' } };
      }
      DB[name].push(row);
      return { data: q.ret ? [proj(row)] : null, error: null };
    }
    if (q.mode === 'update') {
      const rows = DB[name].filter(hit);
      if (name === 'workout_completions') for (const r of rows) { const bad = wcCheck({ ...r, ...q.p }); if (bad) return { data: null, error: { message: 'violates ' + bad, code: '23514' } }; }
      rows.forEach((r) => Object.assign(r, q.p));
      return { data: q.ret ? rows.map(proj) : null, error: null };
    }
    let rows = DB[name].filter(hit);
    if (q.order) rows = rows.slice().sort((x, y) => (norm(x[q.order[0]]) < norm(y[q.order[0]]) ? -1 : 1) * q.order[1]);
    if (q.lim != null) rows = rows.slice(0, q.lim);
    return { data: rows.map(proj), error: null };
  }
  b.single = async () => { const r = run(); if (r.error) return r; const a = r.data || []; return a.length === 1 ? { data: a[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }; };
  b.maybeSingle = async () => { const r = run(); if (r.error) return r; const a = r.data || []; return a.length > 1 ? { data: null, error: { message: 'multiple rows' } } : { data: a[0] ?? null, error: null }; };
  b.then = (res, rej) => Promise.resolve().then(run).then(res, rej);
  return b;
}
const admin = { from: table };
const json = (o) => ({ __body: o, json: async () => o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const LOGS = [];
const logEfError = (...a) => LOGS.push(a.join('|'));
// `json(...)` in the stand-in is a plain object; the handlers only need `instanceof Response` to be false for success objects.
const M = {};
new Function('admin', 'ok', 'err', 'json', 'logEfError', 'exports',
  js + '\nObject.assign(exports,{workoutComplete,workoutCompleteUndo,workoutCompletionsGet,requireCapability,wcPublic});'
)(admin, ok, err, json, logEfError, M);

// ── fixtures ───────────────────────────────────────────────────────────────
const sha = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
const TOK = { a: 'tok_a_' + nodeCrypto.randomBytes(12).toString('hex'), b: 'tok_b_' + nodeCrypto.randomBytes(12).toString('hex'), sg: 'tok_sg_' + nodeCrypto.randomBytes(12).toString('hex'), np: 'tok_np_' + nodeCrypto.randomBytes(12).toString('hex') };
function seed() {
  reset();
  DB.products.push({ code: 'locked_in_1to1', duration_weeks: null }, { code: 'locked_in_self_guided_12w', duration_weeks: 12 });
  const add = (id, key, tok, ent, legacy = false, access = 'active') => {
    DB.clients.push({ id, storage_key: key, entitlement_legacy: legacy });
    const salt = 's_' + id;
    DB.client_sessions.push({ client_id: id, storage_key: key, token_hash: sha(tok + salt), salt, access_status: access });
    if (ent) DB.client_entitlements.push({ id: 'e_' + id, client_id: id, product_code: ent, status: 'active', starts_at: null, ends_at: null });
  };
  add('c_a', 'client_a', TOK.a, 'locked_in_1to1');
  add('c_b', 'client_b', TOK.b, 'locked_in_1to1');
  add('c_sg', 'client_sg', TOK.sg, 'locked_in_self_guided_12w');
  add('c_np', 'client_np', TOK.np, null);                        // provisioning incomplete
  DB.workout_log_entries.push({ id: 'wl1', client_id: 'c_a', exercise_name: 'Bench', client_ref: 'perf_1' });
}
const B = (r) => r.__body;
const ref = (n = 1) => 'cmp_' + String(n).padStart(4, '0') + '_' + 'abcdefghijklmnop';
function todayLocal(tz = 'Australia/Sydney', ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const FP = sha('Bench Press|Row|Squat');
const completion = (over = {}) => ({ ref: ref(1), phase: '1', dayIdx: 0, dayLabel: 'Day 1 — Upper A', sessionKind: 'mandatory', rxFingerprint: FP,
  exercisesPrescribed: 5, exercisesLogged: 3, setsLogged: 9, completedAt: new Date().toISOString(), localDate: todayLocal(), timezone: 'Australia/Sydney', ...over });
const complete = (key, tok, over = {}, extra = {}) => M.workoutComplete({ type: 'workoutComplete', storageKey: key, token: tok, completion: completion(over), ...extra }).then(B);
const undo = (key, tok, r, extra = {}) => M.workoutCompleteUndo({ type: 'workoutCompleteUndo', storageKey: key, token: tok, ref: r, ...extra }).then(B);
const list = (key, tok) => M.workoutCompletionsGet({ type: 'workoutCompletionsGet', storageKey: key, token: tok }).then(B);
const rows = (id) => DB.workout_completions.filter((r) => !id || r.client_id === id);


module.exports = {
  SRC, MIG, WC_COLUMNS, M, B, TOK, sha, seed, ref, todayLocal, completion, complete, undo, list, rows, LOGS,
  db: () => DB, setFailRead: (t) => { FAIL_READ = t; },
};
