// Extracts the pure entitlement/capability logic from the SHIPPED Edge Function
// source and exercises it. No copy of the rules lives in this file.
const ts = require('/home/claude/.npm-global/lib/node_modules/typescript');
const fs = require('fs');

const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
function grab(startRe, endMarker) {
  const i = SRC.search(startRe);
  if (i < 0) throw new Error('could not locate ' + startRe);
  const j = SRC.indexOf(endMarker, i);
  if (j < 0) throw new Error('could not terminate ' + startRe);
  return SRC.slice(i, j + endMarker.length);
}
const snippet = [
  grab(/const ALL_CAPABILITIES/, '];'),
  grab(/const PRODUCT_CAPABILITIES/, '\n};'),
  grab(/const LEGACY_PRODUCT_CODE/, ';'),
  grab(/function capabilitiesForProducts/, '\n}'),
  grab(/function entitlementRowIsActive/, '\n}'),
].join('\n');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = {};
new Function('exports', js + '\nexports.capabilitiesForProducts=capabilitiesForProducts;' +
  'exports.entitlementRowIsActive=entitlementRowIsActive;' +
  'exports.PRODUCT_CAPABILITIES=PRODUCT_CAPABILITIES;' +
  'exports.ALL_CAPABILITIES=ALL_CAPABILITIES;' +
  'exports.LEGACY_PRODUCT_CODE=LEGACY_PRODUCT_CODE;')(mod);

const { capabilitiesForProducts, entitlementRowIsActive, PRODUCT_CAPABILITIES, ALL_CAPABILITIES, LEGACY_PRODUCT_CODE } = mod;

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + name); } };

console.log('CAPABILITY TRUTH TABLE (from shipped source)\n');
const SG = capabilitiesForProducts(['locked_in_self_guided_12w']);
const PR = capabilitiesForProducts(['locked_in_1to1']);
const hdr = 'capability'.padEnd(32) + 'SELF_GUIDED'.padEnd(13) + 'PREMIUM';
console.log(hdr); console.log('-'.repeat(hdr.length));
for (const c of ALL_CAPABILITIES) {
  console.log(c.padEnd(32) + String(SG[c]).padEnd(13) + String(PR[c]));
}

console.log('\nASSERTIONS');
// The five premium-only capabilities must be false for self-guided.
for (const c of ['direct_coach_messaging','manual_coach_review','coach_program_customisation','coach_nutrition_adjustment','form_review']) {
  t(`self-guided denied ${c}`, SG[c] === false);
  t(`premium allowed ${c}`,    PR[c] === true);
}
// Self-guided must actually be a complete product, not a crippled one.
for (const c of ['view_program','log_workout','view_nutrition','log_weight','submit_self_checkin','view_recipes','view_education','receive_automated_progression']) {
  t(`self-guided has ${c}`, SG[c] === true);
}
t('self-guided receives automated adjustment', SG.receive_automated_adjustment === true);
t('premium does NOT receive automated adjustment (coach decides)', PR.receive_automated_adjustment === false);

// Unknown / empty products grant nothing.
t('unknown product grants nothing', Object.values(capabilitiesForProducts(['nope'])).every(v => v === false));
t('no products grants nothing',     Object.values(capabilitiesForProducts([])).every(v => v === false));
// Every capability is defined for both products (no silent undefined).
t('matrix is complete', ALL_CAPABILITIES.every(c =>
  typeof PRODUCT_CAPABILITIES.locked_in_1to1[c] === 'boolean' &&
  typeof PRODUCT_CAPABILITIES.locked_in_self_guided_12w[c] === 'boolean'));
// Union semantics: an upgrade adds, never removes.
const BOTH = capabilitiesForProducts(['locked_in_self_guided_12w','locked_in_1to1']);
t('upgrade is additive (union)', ALL_CAPABILITIES.every(c => BOTH[c] === (SG[c] || PR[c])));
t('upgraded user gains coach review', BOTH.manual_coach_review === true);
t('upgraded user keeps self-guided automation', BOTH.receive_automated_adjustment === true);
t('legacy product code is premium', LEGACY_PRODUCT_CODE === 'locked_in_1to1');

// Window logic.
const now = Date.parse('2026-09-09T00:00:00Z');
const A = (o) => entitlementRowIsActive(o, now);
t('active, no window',            A({status:'active'}) === true);
t('active, started',              A({status:'active', starts_at:'2026-09-01T00:00:00Z'}) === true);
t('active, not yet started',      A({status:'active', starts_at:'2026-10-01T00:00:00Z'}) === false);
t('active, within window',        A({status:'active', starts_at:'2026-09-01T00:00:00Z', ends_at:'2026-12-01T00:00:00Z'}) === true);
t('active, expired by ends_at',   A({status:'active', ends_at:'2026-09-08T23:59:59Z'}) === false);
t('active, ends exactly now',     A({status:'active', ends_at:'2026-09-09T00:00:00Z'}) === false);
for (const st of ['pending','paused','expired','revoked']) t(`status ${st} is not active`, A({status:st}) === false);
t('missing status is not active', A({}) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
