// FOOD-LOG coach side (Omar 2026-11-19), run from the REAL handler source:
//   1. foodLogDays: plan meals + extra foods per Sydney day, undo and re-tick handled, totals add up
//   2. mealRemove: deletes only this client's own "Extra: ..." row at that exact time; never a plan meal
//   3. dashboard(): extra foods stay out of the meal lists and counts but still count as activity
const ts = require('typescript');
const fs = require('fs');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const cut = (a, b) => { const i = SRC.indexOf(a); if (i < 0) throw new Error('locate ' + a); const j = SRC.indexOf(b, i); if (j < 0) throw new Error('locate ' + b); return SRC.slice(i, j); };
const tr = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };

const json = (o) => ({ __body: o });
const ok  = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const sydneyDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// ── in-memory meal_logs ──
let ROWS = [], COACH_OK = true;
function table(name) {
  const q = { f: [], del: false };
  q.select = () => q; q.order = () => q; q.limit = () => q;
  q.eq = (c, v) => { q.f.push((r) => r[c] === v); return q; };
  q.gte = (c, v) => { q.f.push((r) => r[c] >= v); return q; };
  q.delete = () => { q.del = true; return q; };
  q.maybeSingle = async () => ({ data: name === 'clients' ? ({ k1: { id: 'c1' }, k2: { id: 'c2' } })[q.key] ?? null : null, error: null });
  const run = () => {
    const hit = ROWS.filter((r) => q.f.every((f) => f(r)));
    if (q.del) ROWS = ROWS.filter((r) => !hit.includes(r));
    return hit.slice().sort((a, b) => a.logged_at < b.logged_at ? -1 : 1);
  };
  q.range = async (a, b) => ({ data: run().slice(a, b + 1), error: null });
  q.then = (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
  if (name === 'clients') { const eq = q.eq; q.eq = (c, v) => { q.key = v; return q; }; }
  return q;
}
const admin = { from: table };

const M = {};
new Function('admin', 'ok', 'err', 'logEfError', 'sydneyDate', 'verifyCoachToken', 'CI_KEY_RE', 'exports',
  tr(cut('async function pagedRows(', '\nasync function dashboard(')) +
  tr(cut("const EXTRA_FOOD_PREFIX = 'Extra: ';", '\nasync function rosterGet(')) +
  tr('async function mealWrite(kind, key, clientId, body) {\n' + cut("  if (kind === 'meal') {", "\n  if (kind === 'workout') {") + '\n}') +
  '\nexports.foodLogDays = foodLogDays; exports.foodLogGet = foodLogGet; exports.isExtraFood = isExtraFood; exports.mealWrite = mealWrite;'
)(admin, ok, err, () => {}, sydneyDate, () => COACH_OK, /^[a-z0-9_]{1,64}$/, M);

const row = (cid, at, name, kcal, p, c, f, notes) => ({ id: 'm' + (ROWS.length + 1), client_id: cid, logged_at: at, meal_name: name, notes: notes || '', kcal, protein_g: p, carbs_g: c, fat_g: f });
const recent = (daysAgo, hhmm) => { const d = sydneyDate(Date.now() - daysAgo * 86400000); return new Date(d + 'T' + hhmm + ':00+11:00').toISOString(); };

(async () => {
  console.log('food log, coach side');
  // Sydney day: 13:30Z on the 18th is 00:30 on the 19th in Sydney (AEDT)
  let days = M.foodLogDays([
    row('c1', '2026-11-17T21:00:00.000Z', 'Oats + Whey', 520, 40, 60, 10),          // 18th 8am
    row('c1', '2026-11-18T02:00:00.000Z', 'Chicken Rice', 640, 55, 70, 12),         // 18th 1pm
    row('c1', '2026-11-18T02:00:30.000Z', '', 0, 0, 0, 0),                          // undo -> takes back Chicken Rice
    row('c1', '2026-11-18T02:05:00.000Z', 'Beef Rice', 600, 50, 66, 14),
    row('c1', '2026-11-18T09:00:00.000Z', 'Oats + Whey', 520, 40, 60, 10),          // ticked again -> once
    row('c1', '2026-11-18T10:00:00.000Z', 'Extra: Banana, peeled, raw', 113, 1.4, 25.5, 0.3, '120 g'),
    row('c1', '2026-11-18T13:30:00.000Z', 'Extra: Mars bar', 228, 2.2, 35, 8.5, '1 bar'),
  ]);
  t('two Sydney days', days.length === 2 && days[0].day === '2026-11-18' && days[1].day === '2026-11-19', days.map((d) => d.day));
  const d18 = days[0];
  t('undo takes back the meal ticked just before it', !d18.plan.some((x) => x.name === 'Chicken Rice') && d18.plan.some((x) => x.name === 'Beef Rice'), d18.plan.map((x) => x.name));
  t('a meal ticked twice counts once', d18.plan.filter((x) => x.name === 'Oats + Whey').length === 1 && d18.plan.length === 2);
  t('extra food listed without the prefix, with its amount', d18.extra.length === 1 && d18.extra[0].name === 'Banana, peeled, raw' && d18.extra[0].note === '120 g', d18.extra);
  t('day total = plan + extra', d18.kcal === 520 + 600 + 113 && d18.planKcal === 1120 && d18.extraKcal === 113 && d18.p === 91.4, d18);
  t('after-midnight snack lands on the next Sydney day', days[1].extra[0].name === 'Mars bar' && days[1].kcal === 228 && days[1].plan.length === 0);
  t('a day with only an undone meal is not a logged day', M.foodLogDays([row('c1', '2026-11-18T02:00:00.000Z', 'A', 500, 1, 1, 1), row('c1', '2026-11-18T02:01:00.000Z', '', 0, 0, 0, 0)]).length === 0);

  // foodLogGet
  ROWS = [row('c1', recent(1, '08:00'), 'Oats + Whey', 520, 40, 60, 10), row('c1', recent(1, '15:00'), 'Extra: Apple', 80, 0.4, 18, 0.2, '1 medium apple'),
          row('c2', recent(1, '09:00'), 'Extra: Pizza', 900, 30, 100, 40), row('c1', recent(60, '09:00'), 'Old meal', 500, 1, 1, 1)];
  let r = (await M.foodLogGet({ coachToken: 'x', client: 'k1' })).__body;
  t('coach read: only that client, only the window', r.ok && r.days.length === 1 && r.days[0].kcal === 600 && r.days[0].extra[0].name === 'Apple', r);
  COACH_OK = false;
  t('no coach token -> refused', (await M.foodLogGet({ client: 'k1' })).__body.error === 'unauthorized');
  COACH_OK = true;
  t('unknown client -> refused', (await M.foodLogGet({ coachToken: 'x', client: 'nobody' })).__body.error === 'unknown_client');
  t('bad key -> refused', (await M.foodLogGet({ coachToken: 'x', client: 'a b;' })).__body.error === 'bad_storageKey');

  // mealRemove
  const at = ROWS[1].logged_at, n0 = ROWS.length;
  r = (await M.mealWrite('mealRemove', 'k1', 'c2', { mealName: 'Extra: Apple', timestamp: at })).__body;
  t('another client cannot remove it', r.ok && r.removed === 0 && ROWS.length === n0);
  r = (await M.mealWrite('mealRemove', 'k1', 'c1', { mealName: 'Oats + Whey', timestamp: ROWS[0].logged_at })).__body;
  t('a plan meal can never be removed', r.ok === false && r.error === 'bad_request' && ROWS.length === n0);
  r = (await M.mealWrite('mealRemove', 'k1', 'c1', { mealName: 'Extra: Apple' })).__body;
  t('no time -> refused', r.ok === false && ROWS.length === n0);
  r = (await M.mealWrite('mealRemove', 'k1', 'c1', { mealName: 'Extra: Apple', timestamp: at })).__body;
  t('own extra food removed', r.ok && r.removed === 1 && ROWS.length === n0 - 1 && !ROWS.some((x) => x.meal_name === 'Extra: Apple'));
  r = (await M.mealWrite('mealRemove', 'k1', 'c1', { mealName: 'Extra: Apple', timestamp: at })).__body;
  t('removing it again still settles', r.ok && r.removed === 0);

  // dashboard(): source check that extras return before the meal list and counts
  const dash = cut('  (meals ?? []).forEach(r => {', '  (workouts ?? []).forEach(r => {');
  const iX = dash.indexOf("if (String(r.meal_name ?? '').startsWith('Extra: '))"), iPush = dash.indexOf('p.recentMeals.push'), iToday = dash.indexOf('p.mealsToday++');
  t('dashboard: extras leave before recentMeals and mealsToday', iX > 0 && iX < iPush && iX < iToday && /latestMealTs = r\.logged_at;[\s\S]*return;/.test(dash.slice(iX, iPush)));
  t('routes + capability wired', /case 'mealRemove': +return clientWrite\('mealRemove', body\)/.test(SRC) && /case 'foodLogGet': +return foodLogGet\(body\)/.test(SRC) && /mealRemove: +'log_meal'/.test(SRC));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
