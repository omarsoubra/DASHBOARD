// clientProgram / setClientProgram v3 allowlist — exercises the REAL handler
// source from supabase/functions/api/index.ts.
//
// The client shell is thin: it carries no program data and fetches everything
// from clientProgram after authenticating. That makes this response the only
// delivery path for a client's program, so the contract under test is an
// ALLOWLIST, not a filter: unknown top-level fields must never reach a browser,
// and credential-shaped keys must be dropped at any depth.
//
// Context: on 2026-09-12, 33 stored payloads were found carrying
// CLIENT_CONFIG.trainerPassword. They were cleaned. This test is what stops a
// dirty row from ever being served again.
const ts = (() => {
  for (const p of ['typescript', '/home/claude/.npm-global/lib/node_modules/typescript']) {
    try { return require(p); } catch (_) {}
  }
  throw new Error('typescript not available');
})();
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'api', 'index.ts'), 'utf8');

function grab(re, end) {
  const i = SRC.search(re); if (i < 0) throw new Error('locate ' + re);
  const j = SRC.indexOf(end, i); if (j < 0) throw new Error('terminate ' + re);
  return SRC.slice(i, j + end.length);
}
const snippet = [
  grab(/const UNSAFE_KEY_RE/, '/i;'),
  grab(/const PROGRAM_V3_KEYS/, 'as const;'),
  grab(/const PROGRAM_LEGACY_KEYS/, '\n];'),
  grab(/function stripUnsafe/, '\n}'),
  grab(/function projectProgram/, '\n}'),
  grab(/function unsafeKeyPaths/, '\n}'),
  grab(/function validateProgramV3/, '\n  return { ok: true };\n}'),
].join('\n');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = {};
eval(js + '\n;Object.assign(mod,{stripUnsafe,projectProgram,validateProgramV3});');
const { stripUnsafe, projectProgram, validateProgramV3 } = mod;

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const v3 = {
  schemaVersion: 3, generatedAt: 'x', storageKey: 'k',
  client: { firstName: 'Test', startWeight: 85 },
  copy: { a: 'b' }, rationale: ['a'], dayTypes: ['Weights'],
  phases: { 1: {} }, mealPlan: { 1: [{}] }, nutrition: {},
};

console.log('validateProgramV3 (write side)');
t('accepts a well-formed v3',        validateProgramV3(v3).ok === true);
t('rejects unknown top-level field', validateProgramV3({ ...v3, generatorNotes: 'x' }).error === 'unknown_top_level_fields');
t('rejects trainerPassword',         validateProgramV3({ ...v3, client: { firstName: 'N', trainerPassword: 'p' } }).error === 'unsafe_fields');
t('rejects a nested secret',         validateProgramV3({ ...v3, nutrition: { deep: { api_key: 'x' } } }).error === 'unsafe_fields');
t('rejects a phase unlockCode',      validateProgramV3({ ...v3, phases: { 1: { unlockCode: 'X20' } } }).error === 'unsafe_fields');
t('rejects missing client',          validateProgramV3({ ...v3, client: undefined }).error === 'client_missing');
t('rejects missing mealPlan',        validateProgramV3({ ...v3, mealPlan: undefined }).error === 'mealPlan_missing');
t('rejects a non-array meal week',   validateProgramV3({ ...v3, mealPlan: { 1: 'x' } }).error === 'mealPlan_week_not_array');
t('rejects empty phases',            validateProgramV3({ ...v3, phases: {} }).error === 'phases_empty');
t('rejects non-array rationale',     validateProgramV3({ ...v3, rationale: 'x' }).error === 'rationale_not_array');
t('rejects a non-object payload',    validateProgramV3([]).error === 'payload_not_object');

console.log('projectProgram — v3 (read side)');
const p3 = projectProgram({ ...v3, sneaky: 'leak', internalNotes: { x: 1 } });
t('drops unknown top-level keys', p3.sneaky === undefined && p3.internalNotes === undefined);
t('keeps every allowlisted key',
  ['schemaVersion', 'client', 'copy', 'rationale', 'dayTypes', 'phases', 'mealPlan', 'nutrition'].every(k => k in p3));

console.log('projectProgram — legacy rows still in the table');
const legacy = {
  schemaVersion: 2, client: { firstName: 'Omar' },
  CLIENT_CONFIG: { client: { storageKey: 'omar' }, trainerPassword: 'SENTINEL_SECRET',
                   phases: { 2: { unlockCode: 'SENTINEL_CODE' } } },
  howTos: { a: 'b' }, phases: { 1: {} }, mealPlan: { 1: [] },
  generatorNotes: 'internal', _comment: 'internal',
};
const pl = projectProgram(legacy);
t('legacy: credential stripped',   JSON.stringify(pl).indexOf('SENTINEL_SECRET') < 0);
t('legacy: unlock code stripped',  JSON.stringify(pl).indexOf('SENTINEL_CODE') < 0);
t('legacy: unknown keys dropped',  pl.generatorNotes === undefined && pl._comment === undefined);
t('legacy: program content kept',  !!(pl.howTos && pl.mealPlan && pl.phases && pl.CLIENT_CONFIG.client.storageKey === 'omar'));

console.log('stripUnsafe');
t('walks arrays',              JSON.stringify(stripUnsafe([{ password: 'x', ok: 1 }])) === '[{"ok":1}]');
t('tolerates null',            stripUnsafe(null) === null);
t('is case-insensitive',       stripUnsafe({ TrainerPassword: 'x', a: 1 }).TrainerPassword === undefined);
t('leaves normal data intact', JSON.stringify(stripUnsafe({ a: [1, 2], b: { c: 'd' } })) === '{"a":[1,2],"b":{"c":"d"}}');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
