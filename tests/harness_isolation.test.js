// ═══════════════════════════════════════════════════════════════════════════
// HARNESS ISOLATION — development-side invocation safety gate
//
// The 2026-09 billing cycle recorded 2,381,825 Edge Function invocations, of
// which 99.1% came from a six-day burst whose generator could not be identified
// (log retention is ~24h and the evidence had expired). The forensics did
// establish that the automated harnesses could not have caused it, because they
// are isolated from production three times over:
//
//   1. every test copy of a client shell points at the LOCAL stub, not at the
//      production Edge Function;
//   2. every browser harness installs a route allow-list that permits only
//      file:// and 127.0.0.1 and aborts everything else;
//   3. neither sandbox has network egress to *.supabase.co at all.
//
// Layers 1 and 2 live in source and can silently regress — a single copied
// shell that kept its production webhook, or one harness written without the
// allow-list, and a fleet-wide validation sweep starts spending real
// invocations. This test is the regression guard for those two layers. It reads
// files only. It makes NO network calls and costs ZERO Edge Function
// invocations.
//
//   usage:  HARNESS_DIR=/path/to/harnesses node tests/harness_isolation.test.js
//
// It FAILS CLOSED: if the harness directory cannot be found, the run fails
// rather than reporting success on an empty set. Not being able to check is not
// the same as being safe.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

/* The production endpoint. Public (it ships in every client shell), never a
   secret. Anything matching this inside a TEST shell or a harness is a defect. */
const PROD_PATTERNS = [/cwrrxieahrcustjvpqsk\.supabase\.co/i, /functions\/v1\/api/i];
const STUB_PATTERN  = /127\.0\.0\.1:\d+/;

/* Directories of webhook-rewritten shell copies that harnesses are allowed to
   load. Every .html in them must carry the stub and must not carry production. */
const TEST_SHELL_DIRS = ['test', 'audit', 'audit_pre'];

/* Directories of DEPLOYMENT artifacts. These legitimately carry the production
   webhook, and precisely because of that no harness may ever navigate to one. */
const PROD_ARTIFACT_DIRS = ['out', 'fixed', 'isaac', 'shells'];

function resolveHarnessDir() {
  if (process.env.HARNESS_DIR) return process.env.HARNESS_DIR;
  const guesses = [
    path.join(process.cwd(), 'harnesses'),
    path.join(process.cwd(), '_harnesses'),
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

const failures = [];
const notes = [];
function fail(inv, msg) { failures.push('[' + inv + '] ' + msg); }

const ROOT = resolveHarnessDir();
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('FAIL — harness directory not found.');
  console.error('');
  console.error('  This gate fails closed: it will not report success on a set it could not read.');
  console.error('  Point it at the harness working directory, e.g.');
  console.error('');
  console.error('    HARNESS_DIR=/path/to/swapv2 node tests/harness_isolation.test.js');
  console.error('');
  process.exit(1);
}

const listFiles = (dir, ext) => {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter(f => f.endsWith(ext)).map(f => path.join(p, f));
};

// ── INVARIANT 1 ────────────────────────────────────────────────────────────
// No test-shell copy may contain the production endpoint, and every one of them
// must carry the local stub. A shell with neither is not "clean" — it is a
// shell whose target is unknown, and it fails too.
let shellsChecked = 0, dirsFound = 0;
for (const dir of TEST_SHELL_DIRS) {
  const files = listFiles(dir, '.html');
  if (!files.length) continue;
  dirsFound++;
  for (const f of files) {
    shellsChecked++;
    const src = fs.readFileSync(f, 'utf8');
    const hit = PROD_PATTERNS.find(re => re.test(src));
    if (hit) fail('1 test-shell target', path.relative(ROOT, f) + ' contains the PRODUCTION endpoint (' + hit + '). A harness loading it would spend real invocations.');
    else if (!STUB_PATTERN.test(src)) fail('1 test-shell target', path.relative(ROOT, f) + ' carries neither the production endpoint nor a 127.0.0.1 stub — its backend target is unknown.');
  }
}
if (!dirsFound) fail('1 test-shell target', 'none of ' + TEST_SHELL_DIRS.join(', ') + ' exist under ' + ROOT + ' — nothing to verify, so this cannot pass.');
else notes.push('invariant 1: ' + shellsChecked + ' test-shell copies across ' + dirsFound + ' directories, all stub-targeted');

// ── INVARIANT 2 ────────────────────────────────────────────────────────────
// Every browser harness that installs a request route must install an ALLOW
// LIST: continue for file:// and 127.0.0.1, abort otherwise. A harness that
// routes without aborting is an open channel to whatever the page asks for.
const harnesses = fs.readdirSync(ROOT).filter(f => f.endsWith('.py')).map(f => path.join(ROOT, f));
let routed = 0;
for (const f of harnesses) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);

  // 2a. no harness may name the production endpoint at all
  const hit = PROD_PATTERNS.find(re => re.test(src));
  if (hit) fail('2 harness allow-list', rel + ' references the PRODUCTION endpoint (' + hit + ').');

  if (!/\.route\s*\(/.test(src)) continue;   // not a browser harness
  routed++;
  const hasContinue = /continue_\s*\(/.test(src);
  const hasAbort    = /abort\s*\(/.test(src);
  const allowsFile  = /file:\/\//.test(src);
  const allowsLocal = /127\.0\.0\.1/.test(src);
  if (!hasAbort)    fail('2 harness allow-list', rel + ' installs a route but never calls abort() — it is not an allow-list.');
  if (!hasContinue) fail('2 harness allow-list', rel + ' installs a route but never calls continue_().');
  if (!allowsFile || !allowsLocal) fail('2 harness allow-list', rel + ' routes requests without naming both file:// and 127.0.0.1 as the permitted origins.');
}
if (!routed) fail('2 harness allow-list', 'no browser harness with a route handler found under ' + ROOT + ' — nothing to verify, so this cannot pass.');
else notes.push('invariant 2: ' + routed + ' browser harnesses, all with a file://+127.0.0.1 allow-list');

// ── INVARIANT 3 ────────────────────────────────────────────────────────────
// No harness may NAVIGATE to a deployment artifact. Those copies carry the real
// webhook by design; loading one in a browser spends production invocations.
// Reading such a file (open(), readFileSync) is fine — only navigation is not.
const NAV = /(?:goto|preview_start|location\.href\s*=)\s*\(?\s*[^\n]*/g;
let navChecked = 0;
for (const f of harnesses) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  for (const line of src.split('\n')) {
    if (!/goto\s*\(|preview_start|location\.href/.test(line)) continue;
    navChecked++;
    for (const d of PROD_ARTIFACT_DIRS) {
      if (new RegExp("['\"/]" + d + "/").test(line)) {
        fail('3 navigation target', rel + ' navigates to the deployment artifact directory "' + d + '/", which carries the production webhook: ' + line.trim().slice(0, 120));
      }
    }
  }
}
notes.push('invariant 3: ' + navChecked + ' navigation sites, none pointing at ' + PROD_ARTIFACT_DIRS.join('/') + '/');

// ── RESULT ─────────────────────────────────────────────────────────────────
console.log('harness isolation gate — ' + ROOT);
console.log('');
for (const n of notes) console.log('  ok   ' + n);
console.log('');
console.log('  production Edge Function invocations made by this test: 0 (reads files only)');
console.log('');
if (failures.length) {
  console.error('FAIL — ' + failures.length + ' isolation violation(s):');
  console.error('');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  console.error('A fleet validation run in this state could spend real Edge Function invocations.');
  console.error('Fix the violation before running any harness.');
  process.exit(1);
}
console.log('PASS — all three isolation invariants hold.');
