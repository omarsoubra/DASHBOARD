#!/usr/bin/env node
// Coach Workout Completion View V1 — headless-Chrome test of coach_dashboard.html.
//
//   node scripts/coach/coach_view_e2e.js PATCHED_DASHBOARD.html ORIGINAL_DASHBOARD.html
//
// The repo root is served from 127.0.0.1 (real clients_registry.json). EVERY
// *.supabase.co request is intercepted and answered locally; the completion
// summaries come from the REAL api code (COACH-WORKOUT-VIEW-V1 block) over
// fixture rows. Nothing reaches production.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const [, , PATCHED, ORIGINAL] = process.argv;
const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── real summarizer from the api source ────────────────────────────────────
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/api/index.ts'), 'utf8');
const block = SRC.slice(SRC.indexOf('// COACH-WORKOUT-VIEW-V1'), SRC.indexOf('// ═══════════════════════════════════════ END COACH-WORKOUT-VIEW-V1'));
const M = {};
new Function('exports', ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nexports.cwvSummarize=cwvSummarize;')(M);
const H = 3600e3, now = Date.now();
const r = (o) => ({ completion_ref: 'cmp_' + Math.random().toString(36).slice(2).padEnd(18, 'x'), phase_key: '1', day_index: 0, day_label: 'Day 1 — Push',
  session_kind: 'mandatory', exercises_prescribed: 6, exercises_logged: 6, sets_logged: 18, timezone: 'Australia/Sydney', status: 'completed', revoked_at: null, revoked_by: null, ...o,
  completed_at: new Date(o.at).toISOString(), recorded_at: new Date(o.at).toISOString(), local_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(o.at)) });
const zacRows = [
  r({ at: now - 2 * H, day_index: 1, day_label: 'Day 2 — Pull', exercises_logged: 2 }),
  r({ at: now - 3 * H, day_index: 5, day_label: 'Day 6 — OPTIONAL (Arms & Weak-Point)', session_kind: 'optional', exercises_logged: 0, sets_logged: 0 }),
  r({ at: now - 30 * H, status: 'revoked', revoked_at: new Date(now - 29 * H).toISOString(), revoked_by: 'client' }),
  r({ at: now - 9 * 24 * H }),
];
const COMPLETIONS = { zac: { displayName: 'Zac', ...M.cwvSummarize(zacRows, now) }, cruz_rehayem: { displayName: 'Cruz', ...M.cwvSummarize([], now) } };

let SERVE = PATCHED, CWV_MODE = 'ok';
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/' || u === '/coach_dashboard.html') u = '__DASH__';
  const f = u === '__DASH__' ? SERVE : path.join(ROOT, u);
  if (!f.startsWith(ROOT) && f !== SERVE) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.json') ? 'application/json' : f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((ok) => srv.listen(9941, '127.0.0.1', ok));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-e2e-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9943', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9943/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((ok) => (ws.onopen = ok));
  let id = 0; const pending = new Map(); const handlers = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const R = { checks: [], errors: [], calls: { patched: [], original: [] } };
  const check = (n, c, d) => R.checks.push({ name: n, pass: !!c, ...(c ? {} : { detail: d }) });
  let MODE = 'patched';
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  handlers.push(async (d) => {
    if (d.sessionId !== s) return;
    if (d.method === 'Runtime.exceptionThrown') R.errors.push((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text);
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params;
      let body = request.method === 'GET' ? '{}' : '{"ok":true}';
      if (request.method === 'POST') {
        const b = JSON.parse(request.postData || '{}'); R.calls[MODE].push(b.type);
        if (b.type === 'rosterGet') body = JSON.stringify({ ok: true, roster: [], ts: 0 });
        else if (b.type === 'dashboard') body = JSON.stringify({ ok: true, dashboard: {} });
        else if (b.type === 'coachWorkoutCompletions') body = CWV_MODE === 'ok' ? JSON.stringify({ ok: true, clients: COMPLETIONS }) : '{"ok":false,"error":"unknown_type"}';
      }
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, s);
    }
  });
  await send('Runtime.enable', {}, s); await send('Page.enable', {}, s);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] }, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('sbo_coach_token', 'test-coach-token'); } catch (e) {}` }, s);
  const ev = async (x) => { const q = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, s); if (q.exceptionDetails) throw new Error(x.slice(0, 70) + ': ' + (q.exceptionDetails.exception || {}).description); return q.result.value; };
  const load = async () => { await send('Page.navigate', { url: 'http://127.0.0.1:9941/coach_dashboard.html' }, s); await sleep(3500); };
  const panel = async (key, tab) => { await ev(`(openDetail('${key}'), switchDetailTab('${key}','${tab}'), true)`); await sleep(900); return ev(`document.getElementById('detail-panel').innerHTML`); };
  const stripCard = (h) => h.replace(/\n\s*<div class="cd3-card">\s*<div class="cd3-card-h">Workout completions<\/div>[\s\S]*?<\/div>\s*<\/div>\s*\n/, '\n');
  try {
    await load();
    check('clients from the registry loaded', await ev(`COACH.clients.some(c => c.storageKey === 'zac') && COACH.clients.some(c => c.storageKey === 'cruz_rehayem')`));
    const zp = await panel('zac', 'progress');
    const zt = await ev(`(document.getElementById('cwv-card')||{}).innerText || ''`);
    check('card shown in the Progress tab', /Workout completions/.test(zp));
    check('latest = newest ACTIVE completion (day label, phase, kind, partial logging)', /Latest:.*Phase 1 · Day 2 — Pull · mandatory · 2 of 6 exercises logged/.test(zt), zt.slice(0, 300));
    check('this week / previous week shown with calendar-week dates + timezone', /This week \(.+\): \d+ · Previous week \(.+\): \d+ · calendar weeks, Australia\/Sydney/.test(zt), zt);
    check('revoked counted separately', /1 undone by the client \(kept in history, not counted\)/.test(zt));
    await ev(`(document.querySelector('#cwv-card details').open = true, true)`); await sleep(200);
    const hist = await ev(`[...document.querySelectorAll('#cwv-card tr')].slice(1).map(r => r.innerText.replace(/\\s+/g,' ').trim())`);
    check('history lists all 4 events incl. the revoked one', hist.length === 4, hist);
    check('revoked row marked "Undone by client"', hist.some((x) => /↺ Undone by client/.test(x)) && hist.filter((x) => /✓ Completed/.test(x)).length === 3, hist);
    check('optional session + zero logging rendered', hist.some((x) => /OPTIONAL.*optional.*0\/6/.test(x)), hist);
    check('explainer: no completion ≠ missed', /does not mean a session was missed/.test(zt));
    const low = zt.toLowerCase().replace('does not mean a session was missed', '');
    for (const w of ['missed', 'behind', 'non-compliant', 'noncompliant', 'inactive', 'adherence', '%']) check('no judgement wording: ' + w, !low.includes(w));
    const cp = await panel('cruz_rehayem', 'progress');
    const ct = await ev(`(document.getElementById('cwv-card')||{}).innerText || ''`);
    check('zero-completion client: "No recorded completions yet."', /No recorded completions yet\./.test(ct), ct);
    check('one request served both clients (cached)', R.calls.patched.filter((t) => t === 'coachWorkoutCompletions').length === 1, R.calls.patched);
    const patchedOverview = await panel('zac', 'overview');
    const patchedProgress = stripCard(await panel('zac', 'progress'));
    // ── unavailable api (e.g. before the api deploy) degrades to a message ──
    CWV_MODE = 'down'; await load();
    await panel('zac', 'progress');
    check('api unavailable → "unavailable right now", page still works', /unavailable right now/.test(await ev(`document.getElementById('cwv-card').innerText`)));
    CWV_MODE = 'ok';
    // ── ORIGINAL dashboard, same fixtures: everything else identical ─────
    MODE = 'original'; SERVE = ORIGINAL; await load();
    const origOverview = await panel('zac', 'overview');
    const origProgress = await panel('zac', 'progress');
    check('Overview tab byte-identical to the original dashboard', patchedOverview === origOverview);
    const norm = (h) => h.replace(/\s+/g, ' ');
    check('Progress tab identical except the added card (whitespace-normalised)', norm(patchedProgress) === norm(origProgress), { p: patchedProgress.length, o: origProgress.length });
    const writes = ['rosterPut', 'overridePut', 'clientCreate', 'issueClientToken', 'setAccessStatus', 'progressionApply', 'entitlementGrant', 'entitlementRevoke'];
    const extra = R.calls.patched.filter((t) => !R.calls.original.includes(t));
    check('only extra request is the read-only coachWorkoutCompletions', extra.every((t) => t === 'coachWorkoutCompletions'), extra);
    const count = (arr, t) => arr.filter((x) => x === t).length;
    check('patched dashboard sends no write the original does not (rosterPut on load is pre-existing)',
      writes.every((t) => count(R.calls.patched, t) <= count(R.calls.original, t) * 2), { patched: R.calls.patched.filter((t) => writes.includes(t)), original: R.calls.original.filter((t) => writes.includes(t)) });
  } catch (e) { R.errors.push('driver: ' + e.message); }
  R.pass = R.checks.filter((c) => c.pass).length; R.fail = R.checks.length - R.pass;
  console.log(JSON.stringify(R, null, 1));
  ws.close(); chrome.kill('SIGTERM'); srv.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(R.fail || R.errors.length ? 1 : 0);
})();
