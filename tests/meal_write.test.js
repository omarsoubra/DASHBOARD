// MEAL-SWAP-FIX 2026-10-11 — the meal branch of doWrite, run from the REAL
// handler source against an in-memory meal_logs stand-in.
//
//   1. a failed insert is reported as a failed save (ok:false), never "ok"
//   2. a resend of the same log (same client, time and content) stores nothing
//      new and answers with the existing row
//   3. genuinely different logs (other time, or other content) are all stored
const ts = require('typescript');
const fs = require('fs');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');

const i = SRC.indexOf("  if (kind === 'meal') {");
if (i < 0) throw new Error('locate meal branch');
const j = SRC.indexOf("\n  if (kind === 'workout') {", i);
const branch = SRC.slice(i, j);
const js = ts.transpileModule('async function mealWrite(kind, key, clientId, body) {\n' + branch + '\n}',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

let ROWS = [], FAIL_INSERT = false;
function table() {
  const q = { f: [], ins: null };
  q.select = () => q;
  q.eq = (c, v) => { q.f.push([c, v]); return q; };
  q.limit = () => q;
  q.maybeSingle = async () => ({ data: ROWS.find(r => q.f.every(([c, v]) => r[c] === v)) ?? null, error: null });
  q.insert = (row) => { q.ins = row; return q; };
  q.single = async () => {
    if (FAIL_INSERT) return { data: null, error: { message: 'boom' } };
    const row = Object.assign({ id: 'm' + (ROWS.length + 1) }, q.ins); ROWS.push(row); return { data: { id: row.id }, error: null };
  };
  return q;
}
const admin = { from: table };
const json = (o) => ({ __body: o });
const ok  = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const logEfError = () => {};
const M = {};
new Function('admin', 'ok', 'err', 'logEfError', 'exports', js + '\nexports.mealWrite = mealWrite;')(admin, ok, err, logEfError, M);

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const swap = { mealName: 'MEAL PREP: Beef Mince + Rice + Veg (pan)', status: 'swap', swapDesc: 'Beef rice',
  calActual: 589, pActual: 51, cActual: 68, fActual: 12, timestamp: '2026-10-11T03:20:37.000Z' };

(async () => {
  console.log('meal writes');
  FAIL_INSERT = true;
  let r = (await M.mealWrite('meal', 'k', 'c1', swap)).__body;
  t('failed insert -> ok:false write_failed', r.ok === false && r.error === 'write_failed');
  t('failed insert stored nothing', ROWS.length === 0);
  FAIL_INSERT = false;

  r = (await M.mealWrite('meal', 'k', 'c1', swap)).__body;
  t('first send stored', r.ok === true && ROWS.length === 1 && !r.deduped);
  const r2 = (await M.mealWrite('meal', 'k', 'c1', { ...swap })).__body;
  const r3 = (await M.mealWrite('meal', 'k', 'c1', { ...swap })).__body;
  t('resend of the same log -> same row, nothing new', r2.ok && r2.deduped && r2.id === r.id && r3.id === r.id && ROWS.length === 1);

  await M.mealWrite('meal', 'k', 'c2', { ...swap });
  t('same log for another client is its own row', ROWS.length === 2);
  await M.mealWrite('meal', 'k', 'c1', { ...swap, timestamp: '2026-10-11T03:25:00.000Z' });
  t('a later log of the same meal is stored', ROWS.length === 3);
  await M.mealWrite('meal', 'k', 'c1', { ...swap, swapDesc: 'Chicken wrap', calActual: 640 });
  t('different content at the same time is stored', ROWS.length === 4);
  await M.mealWrite('meal', 'k', 'c1', { mealName: '', status: 'undo', calActual: 0, pActual: 0, cActual: 0, fActual: 0, timestamp: '2026-10-11T03:30:00.000Z' });
  t('undo marker still stored', ROWS.length === 5);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
