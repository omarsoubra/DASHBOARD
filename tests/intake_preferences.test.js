// INTAKE PREFERENCES (Omar 2026-10-13): the six new intake answers are whitelisted and validated server-side,
// using the REAL validateIntakeFields + maps from the api source; existing answers behave exactly as before.
const ts = require('typescript');
const fs = require('fs');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const grab = (re, end) => { const i = SRC.search(re); if (i < 0) throw new Error('locate ' + re); return SRC.slice(i, SRC.indexOf(end, i) + end.length); };
const snippet = [grab(/const INTAKE_FIELD_MAP/, '\n};'), grab(/const INTAKE_NUMERIC/, '\n};'), grab(/const INTAKE_INTEGER/, ';'),
  grab(/const INTAKE_ENUM/, '\n};'), grab(/const WORK_DAYS_RE/, ';'), grab(/const INTAKE_TEXT_MAX/, ';'),
  grab(/function validateIntakeFields/, '\n}'), grab(/const INTAKE_COACHING_COLUMNS/, '];')].join('\n');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const M = {}; new Function('exports', js + '\nObject.assign(exports, { validateIntakeFields, INTAKE_COACHING_COLUMNS });')(M);
let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + JSON.stringify(d) : '')); } };
const V = b => M.validateIntakeFields(b);
console.log('intake preferences');
let r = V({ fullName: 'Test Person', halalPref: 'halal_only', workDays: 'mon,tue,wed,thu,fri', workHours: '7am-3pm', cookingTime: 'batch', shakesOk: 'sometimes', foodOut: 'often' });
t('all six new answers stored in their columns', !Object.keys(r.fieldErrors).length && r.row.halal_pref === 'halal_only' && r.row.work_days === 'mon,tue,wed,thu,fri' &&
  r.row.work_hours === '7am-3pm' && r.row.cooking_time === 'batch' && r.row.shakes_ok === 'sometimes' && r.row.food_out === 'often', r);
t('work days normalised (case, spaces)', V({ workDays: 'Mon, Wed ,FRI' }).row.work_days === 'mon,wed,fri');
t("'varies' accepted", V({ workDays: 'varies' }).row.work_days === 'varies');
t('unknown day refused', V({ workDays: 'mon,funday' }).fieldErrors.workDays === 'not_an_allowed_value');
t('duplicate day refused', V({ workDays: 'mon,mon' }).fieldErrors.workDays === 'not_an_allowed_value');
t("'varies' mixed with days refused", V({ workDays: 'varies,mon' }).fieldErrors.workDays === 'not_an_allowed_value');
for (const [k, bad] of [['halalPref', 'maybe'], ['cookingTime', 'lots'], ['shakesOk', 'never'], ['foodOut', 'daily']]) {
  t(`${k}: a value outside the list is refused`, V({ [k]: bad }).fieldErrors[k] === 'not_an_allowed_value');
}
t('new answers are optional (old form / old clients): nothing set, no error', !Object.keys(V({ fullName: 'X' }).fieldErrors).length);
t('existing answers unchanged (meal variety enum, meals per day range)', V({ mealVariety: 'rotating', mealsPerDay: 4 }).row.meal_variety === 'rotating' && V({ mealsPerDay: 9 }).fieldErrors.mealsPerDay);
t('coach-side intakeGet returns the six new columns', ['halal_pref', 'work_days', 'work_hours', 'cooking_time', 'shakes_ok', 'food_out'].every(c => M.INTAKE_COACHING_COLUMNS.includes(c)));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
