#!/usr/bin/env node
// Daily reminders V1 — deep-link test in headless Chrome against REAL shells.
//
//   node scripts/push/deeplink_e2e.js <storage_key> [<storage_key> …]
//
// Serves clients/<key>/index.html (read-only, never modified) with the repo's
// push-client.js and sw.js from 127.0.0.1. EVERY *.supabase.co request is
// intercepted and answered locally — nothing reaches production.
//
// Proves, per shell: cold start ?li=training / ?li=nutrition lands on that
// section after the shell's own boot; ?li=<invalid> and no li stay on home; the
// li parameter is always removed from the URL; an already-open app switches on
// the service worker's 'li-open' message; a page with no showSection (fallback)
// ignores the link without errors.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = process.argv.slice(2);
const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FALLBACK_PAGE = '<!doctype html><html><body><section class="section active" id="section-home">home</section>' +
  '<script src="../../push-client.js" defer></script></body></html>';

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let body = null, type = 'text/html';
  const m = /^\/clients\/([a-z0-9_]+)\/(index\.html)?$/.exec(u);
  if (m && m[1] === '_no_router') body = FALLBACK_PAGE;
  else if (m && fs.existsSync(path.join(ROOT, 'clients', m[1], 'index.html'))) body = fs.readFileSync(path.join(ROOT, 'clients', m[1], 'index.html'));
  else if (u === '/sw.js' || u === '/push-client.js') { body = fs.readFileSync(path.join(ROOT, u)); type = 'text/javascript'; }
  if (body === null) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
});

(async () => {
  await new Promise((r) => srv.listen(9941, '127.0.0.1', r));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-e2e-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9943', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9943/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const handlers = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const checks = []; const errors = [];
  const check = (name, cond, detail) => checks.push({ name, pass: !!cond, ...(cond ? {} : { detail }) });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  const backend = [];
  handlers.push((d) => {
    if (d.sessionId !== s) return;
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text);
    if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, s).catch(() => {});
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params;
      backend.push(new URL(request.url).host);
      const body = /\/push$/.test(request.url) ? '{"ok":false,"error":"push_not_enabled"}' : '{"ok":true}';
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(body).toString('base64') }, s).catch(() => {});
    }
  });
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
  // Only the backend is intercepted (answered locally). Public CDN assets (fonts, chart lib) load as usual.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] }, s);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
  const open = async (url) => { await send('Page.navigate', { url }, s); await sleep(2200); };
  const active = () => ev(`(document.querySelector('.section.active')||{}).id||null`);

  for (const key of KEYS) {
    const base = `http://127.0.0.1:9941/clients/${key}/`;
    const T = '&t=e2e-token-' + key;
    errors.length = 0;
    await open(`${base}?${T.slice(1)}`);
    const baseline = errors.slice();            // the shell's own errors with no deep link (should be none)
    check(`${key}: baseline load has no page errors`, baseline.length === 0, baseline.slice(0, 2));
    for (const [li, want] of [['training', 'section-training'], ['nutrition', 'section-nutrition'], ['../../evil', 'section-home'], ['bogus', 'section-home']]) {
      errors.length = 0;
      await open(`${base}?li=${encodeURIComponent(li)}${T}`);
      check(`${key}: cold ?li=${li} → ${want}`, (await active()) === want, await active());
      check(`${key}: cold ?li=${li} → li removed from URL`, !(await ev('location.search')).includes('li='), await ev('location.href'));
      check(`${key}: cold ?li=${li} → no page errors added`, errors.length === 0, errors.slice(0, 2));
    }
    await open(`${base}?${T.slice(1)}`);
    check(`${key}: no li → home (unchanged behaviour)`, (await active()) === 'section-home', await active());
    // Already-open app: the message sw.js posts after focusing this window.
    for (const [sec, want] of [['nutrition', 'section-nutrition'], ['training', 'section-training'], ['evil', 'section-training']]) {
      await ev(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'li-open', section: ${JSON.stringify(sec)} } }))`);
      await sleep(300);
      check(`${key}: open app, message '${sec}' → ${want}`, (await active()) === want, await active());
    }
  }
  errors.length = 0;
  await open('http://127.0.0.1:9941/clients/_no_router/?li=training');
  check('fallback: page without showSection ignores the link, no errors, stays home', (await active()) === 'section-home' && errors.length === 0, { a: await active(), errors });
  check('fallback: li removed from URL', !(await ev('location.search')).includes('li='), await ev('location.href'));
  check('every backend request was answered locally (supabase.co only)', backend.length > 0 && backend.every((h) => /\.supabase\.co$/.test(h)), [...new Set(backend)]);

  // ── settings UI (shared push-client.js): plan-synced category toggles only ─
  await open('http://127.0.0.1:9941/clients/_no_router/');
  const ui = await ev(`(async () => {
    const box = document.createElement('div'); document.body.appendChild(box);
    const p = LockedInPush.mount({ container: box, storageKey: 'x_test', getToken: () => 't', pushUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/push', swUrl: '../../sw.js' });
    await new Promise((r) => setTimeout(r, 300));
    const sent = [];
    const base = { optedIn: true, notificationsEnabled: true, timezone: 'Australia/Sydney', weighinAvailable: false, weighinEnabled: true, weighinTime: '07:30',
      checkinEnabled: true, checkinDow: 0, checkinTime: '09:00', programUpdatesEnabled: true, quietStart: '21:00', quietEnd: '07:00',
      daily: { available: true, trainingAvailable: true, mealsAvailable: true }, trainingEnabled: false, mealsEnabled: false };
    p.api = (type, extra) => { sent.push(extra && extra.prefs); return Promise.resolve({ ok: true, prefs: Object.assign({}, p.prefs, extra && extra.prefs) }); };
    const view = (prefs) => { p.prefs = prefs; const c = document.createElement('div'); p._settings(c); return c; };
    const rows = (c) => [...c.querySelectorAll('.lip-row')].map((r) => r.firstChild.firstChild.textContent);
    const out = {};
    let c = view(base);
    out.rowsBoth = rows(c);
    out.textBoth = c.textContent;
    out.selects = [...c.querySelectorAll('select')].map((s) => s.getAttribute('aria-label'));
    out.timeInputsForSchedule = [...c.querySelectorAll('select,input')].filter((x) => /training|meal|follow/i.test(x.getAttribute('aria-label') || '')).length;
    c = view(Object.assign({}, base, { daily: { available: true, trainingAvailable: false, mealsAvailable: true } }));
    out.rowsNoTraining = rows(c);
    c = view(Object.assign({}, base, { daily: { available: true, trainingAvailable: true, mealsAvailable: false } }));
    out.rowsNoMeals = rows(c);
    c = view(Object.assign({}, base, { daily: { available: false, trainingAvailable: false, mealsAvailable: false } }));
    out.rowsOff = rows(c); out.textOff = c.textContent;
    c = view(base);
    p.render = () => {};
    c.querySelector('[aria-label="Training reminders"]').click();
    await new Promise((r) => setTimeout(r, 50));
    out.sent = JSON.stringify(sent);
    return out;
  })()`);
  check('ui: rows are exactly check-in, program updates, training, meals, quiet hours', ui.rowsBoth.join('|') === 'Weekly check-in|Program updates|Training reminders|Meal reminders|Quiet hours', ui.rowsBoth);
  check('ui: plan-synced wording, no internal schedule shown', /Synced with your training plan/.test(ui.textBoth) && /Synced with your meal plan/.test(ui.textBoth) && !/\d{1,2}:\d{2}\s*(AM|PM)?\s*(Meal|Training)|Meal 1|Training days|Follow-up/.test(ui.textBoth), ui.textBoth);
  check('ui: no training/meal/follow-up time controls exist', ui.timeInputsForSchedule === 0, ui.selects);
  check('ui: only quiet-hours (and check-in) time selects remain', ui.selects.every((l) => /Quiet hours|Check-in reminder time/.test(l)), ui.selects);
  check('ui: unknown training schedule → no Training row', ui.rowsNoTraining.join('|') === 'Weekly check-in|Program updates|Meal reminders|Quiet hours', ui.rowsNoTraining);
  check('ui: unknown meal schedule → no Meal row', ui.rowsNoMeals.join('|') === 'Weekly check-in|Program updates|Training reminders|Quiet hours', ui.rowsNoMeals);
  check('ui: outside the rollout → neither row, nothing new shown', ui.rowsOff.join('|') === 'Weekly check-in|Program updates|Quiet hours' && !/Synced/.test(ui.textOff), ui.rowsOff);
  check('ui: a toggle sends exactly one category switch', ui.sent === '[{"trainingEnabled":true}]', ui.sent);

  const pass = checks.filter((c) => c.pass).length;
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  ' + JSON.stringify(c.detail)}`);
  console.log(`\ndeeplink_e2e: ${pass}/${checks.length} passed`);
  chrome.kill(); srv.close(); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* chrome still exiting */ }
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
