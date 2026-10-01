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

  // ── settings UI (shared push-client.js): rendered with stubbed server answers ─
  await open('http://127.0.0.1:9941/clients/_no_router/');
  const ui = await ev(`(async () => {
    const box = document.createElement('div'); document.body.appendChild(box);
    const p = LockedInPush.mount({ container: box, storageKey: 'x_test', getToken: () => 't', pushUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/push', swUrl: '../../sw.js' });
    await new Promise((r) => setTimeout(r, 300));
    const sent = [];
    const base = { optedIn: true, notificationsEnabled: true, timezone: 'Australia/Sydney', weighinAvailable: false, weighinEnabled: true, weighinTime: '07:30',
      checkinEnabled: true, checkinDow: 0, checkinTime: '09:00', programUpdatesEnabled: true, quietStart: '21:00', quietEnd: '07:00',
      daily: { available: true, trainingAvailable: true, mealsAvailable: true, mealSlotCount: 4 },
      trainingEnabled: false, trainingDays: [], trainingTime: null, trainingFollowupEnabled: false, trainingFollowupTime: null, mealsEnabled: false, mealTimes: [] };
    p.api = (type, extra) => { sent.push(extra && extra.prefs); const prefs = Object.assign({}, p.prefs, extra && extra.prefs); return Promise.resolve({ ok: true, prefs }); };
    const view = (prefs) => { p.prefs = prefs; p.lastError = ''; const c = document.createElement('div'); p._settings(c); return c; };
    const out = {};
    let c = view(base);
    out.text = c.textContent;
    out.blankSelects = [...c.querySelectorAll('select')].filter((s) => /Training reminder time|Meal \\d reminder time/.test(s.getAttribute('aria-label'))).every((s) => s.value === '');
    out.mealRows = [...c.querySelectorAll('select')].filter((s) => /^Meal \\d reminder time$/.test(s.getAttribute('aria-label'))).length;
    out.dayChips = c.querySelectorAll('[role=group] button').length;
    out.followupHiddenWhenOff = !/Follow-up time/.test(c.textContent);
    // switching training on with nothing set → explained, nothing sent
    p.render = () => {};
    c.querySelector('[aria-label="Training reminders"]').click();
    out.hintNoDays = p.lastError; out.sentAfterHint = sent.length;
    // quiet-hours warning + 3-slot plan + unavailable texts
    c = view(Object.assign({}, base, { trainingEnabled: true, trainingDays: [1], trainingTime: '22:30', mealTimes: ['08:00', '21:30'], daily: { available: true, trainingAvailable: true, mealsAvailable: true, mealSlotCount: 3 } }));
    out.quietWarnings = (c.textContent.match(/inside your quiet hours/g) || []).length;
    out.mealRows3 = [...c.querySelectorAll('select')].filter((s) => /^Meal \\d reminder time$/.test(s.getAttribute('aria-label'))).length;
    out.followupMin = (() => { const s = [...c.querySelectorAll('select')].find((x) => x.getAttribute('aria-label') === 'Follow-up time'); return s ? s.options[1].value : null; })();
    // out-of-order meal time refused client-side
    const m2 = [...c.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Meal 1 reminder time');
    m2.value = '23:00'; m2.dispatchEvent(new Event('change'));
    out.orderHint = p.lastError; out.sentAfterOrder = sent.length;
    c = view(Object.assign({}, base, { daily: { available: true, trainingAvailable: false, mealsAvailable: false, mealSlotCount: null } }));
    out.unavailable = c.textContent;
    c = view(Object.assign({}, base, { daily: { available: false, trainingAvailable: false, mealsAvailable: false, mealSlotCount: null } }));
    out.hidden = !/Training reminders|Meal reminders/.test(c.textContent);
    // a valid save goes through as one field
    c = view(base);
    const day = c.querySelector('[aria-label="Monday"]'); day.click();
    await new Promise((r) => setTimeout(r, 50));
    out.lastSent = JSON.stringify(sent[sent.length - 1]);
    return out;
  })()`);
  check('ui: training + meal rows shown when available', /Training reminders/.test(ui.text) && /Meal reminders/.test(ui.text) && /Training days/.test(ui.text), ui.text);
  check('ui: every time field starts blank (Choose…), nothing pre-filled', ui.blankSelects === true, ui);
  check('ui: one row per current feed (4) and 7 day chips', ui.mealRows === 4 && ui.dayChips === 7, ui);
  check('ui: follow-up controls hidden while training is off', ui.followupHiddenWhenOff, ui);
  check('ui: switching training on with no days/time explains and sends nothing', /Pick your training days/.test(ui.hintNoDays) && ui.sentAfterHint === 0, ui);
  check('ui: quiet-hours warning for a training time and a meal time inside quiet hours', ui.quietWarnings === 2, ui.quietWarnings);
  check('ui: 3-feed plan shows exactly 3 meal rows', ui.mealRows3 === 3, ui.mealRows3);
  check('ui: follow-up choices start 60 min after the reminder', ui.followupMin === '23:30', ui.followupMin);
  check('ui: out-of-order meal time refused before sending', /later than the one before/.test(ui.orderHint) && ui.sentAfterOrder === 0, ui);
  check('ui: unavailable plan explained in plain words', /Not available for your current program yet/.test(ui.unavailable) && /aren't available for your current plan/.test(ui.unavailable) && !/facts|null|variable|slot/i.test(ui.unavailable.replace(/Meal reminders aren't available for your current plan\./, '')), ui.unavailable);
  check('ui: outside the rollout nothing new is shown', ui.hidden, ui);
  check('ui: a day tap saves one field', ui.lastSent === '{"trainingDays":[1]}', ui.lastSent);

  const pass = checks.filter((c) => c.pass).length;
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  ' + JSON.stringify(c.detail)}`);
  console.log(`\ndeeplink_e2e: ${pass}/${checks.length} passed`);
  chrome.kill(); srv.close(); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* chrome still exiting */ }
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
