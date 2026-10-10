#!/usr/bin/env node
// ONE-TAP reminders — the on-open "Turn on reminders" sheet, in headless Chrome
// against REAL shells.
//
//   node scripts/push/onetap_e2e.js <storage_key> [<storage_key> …]
//
// Serves clients/<key>/index.html (read-only, never modified) with the repo's
// push-client.js and sw.js from 127.0.0.1. EVERY *.supabase.co request is
// intercepted and answered by a local fake of the push function — nothing
// reaches production. The browser's notification permission and push
// subscription are simulated in the page (headless Chrome has no push service),
// so what is under test is the sheet's behaviour, not the OS.
//
// Proves, per shell:
//   A  rollout client, plan with training + meals: the sheet appears on open; the OS
//      permission is NOT requested until the tap; one tap → permission → subscribe →
//      "Reminders are on"; reopening the app shows no sheet.
//   B  "Not now": closes, stays closed on reopen, comes back ONCE after 7 days, then never.
//   C  never shown: outside the rollout (oneTap false) · permission already denied ·
//      iPhone Safari tab (not the Home Screen app) · already registered.
//   D  the OS "Don't Allow" answer: the sheet closes, nothing is subscribed.
//   E  wording follows the plan: no plan times → "Get reminders?" with no meal/training promise.
//   F  push calls carry the client token only in POST bodies (never a URL); no page errors.
//   G  Notifications settings (default schedule, Omar 2026-10-11): training shows its
//      days + time and the client can change both or reset to the plan; meals show
//      lunch + dinner read-only.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = process.argv.slice(2);
if (!KEYS.length) { console.error('usage: onetap_e2e.js <storage_key> …'); process.exit(2); }
const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_DIR = process.env.SHOT_DIR || '';   // optional: phone-size screenshots of the sheet
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let body = null, type = 'text/html';
  const m = /^\/clients\/([a-z0-9_]+)\/(index\.html)?$/.exec(u);
  if (m && fs.existsSync(path.join(ROOT, 'clients', m[1], 'index.html'))) body = fs.readFileSync(path.join(ROOT, 'clients', m[1], 'index.html'));
  else if (u === '/sw.js' || u === '/push-client.js') { body = fs.readFileSync(path.join(ROOT, u)); type = 'text/javascript'; }
  if (body === null) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
});

// In-page simulation of the OS permission + push subscription. State lives in
// localStorage so it survives reloads exactly like the real thing would.
const FAKE_OS = `(() => {
  const LS = window.localStorage;
  const get = (k, d) => { const v = LS.getItem(k); return v === null ? d : v; };
  try {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => get('__perm', 'default') });
    Notification.requestPermission = function () {
      LS.setItem('__permCalls', String(+get('__permCalls', '0') + 1));
      LS.setItem('__permDuringClick', String(+get('__permDuringClick', '0') + (window.__inClick ? 1 : 0)));
      LS.setItem('__perm', get('__permAnswer', 'granted'));
      return Promise.resolve(get('__perm', 'default'));
    };
    const fakeSub = (ep) => ({ endpoint: ep, toJSON: () => ({ endpoint: ep, keys: { p256dh: 'BPk', auth: 'au' } }),
      unsubscribe: () => { LS.removeItem('__sub'); return Promise.resolve(true); } });
    PushManager.prototype.getSubscription = function () { const ep = LS.getItem('__sub'); return Promise.resolve(ep ? fakeSub(ep) : null); };
    PushManager.prototype.subscribe = function () { const ep = 'https://fcm.googleapis.com/fcm/send/e2e-' + Date.now(); LS.setItem('__sub', ep); return Promise.resolve(fakeSub(ep)); };
  } catch (e) { window.__fakeOsError = String(e); }
  document.addEventListener('click', () => { window.__inClick = true; setTimeout(() => { window.__inClick = false; }, 0); }, true);
})();`;

(async () => {
  await new Promise((r) => srv.listen(9951, '127.0.0.1', r));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'onetap-e2e-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9953', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9953/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const handlers = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const checks = []; const errors = [];
  const check = (name, cond, detail) => checks.push({ name, pass: !!cond, ...(cond ? {} : { detail }) });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });

  // ── fake push function (scenario-driven) ──────────────────────────────────
  const SC = { oneTap: true, training: true, meals: true, registered: false, tTime: null, tDays: null };
  const sets = [];
  const trainingView = () => ({ time: SC.tTime ?? '17:00', days: SC.tDays ?? [1, 2, 4, 5], source: SC.tTime || SC.tDays ? 'client' : 'default', custom: !!(SC.tTime || SC.tDays) });
  const calls = []; const leaks = [];
  function pushReply(body) {
    calls.push(body.type);
    switch (body.type) {
      case 'pushStatus': return { ok: true, storageKey: body.storageKey, vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', registered: SC.registered, deviceStatus: SC.registered ? 'active' : null, oneTap: SC.oneTap };
      case 'pushSubscribe': SC.registered = true; return { ok: true, deviceId: 'd1', created: true };
      case 'pushPrefsGet': return { ok: true, prefs: { optedIn: SC.registered, notificationsEnabled: SC.registered, timezone: 'Australia/Sydney', weighinAvailable: false, weighinEnabled: true, weighinTime: '07:30',
        checkinEnabled: true, checkinDow: 0, checkinTime: '09:00', programUpdatesEnabled: true, quietStart: '21:00', quietEnd: '07:00',
        daily: { available: SC.oneTap, trainingAvailable: SC.oneTap && SC.training, mealsAvailable: SC.oneTap && SC.meals,
                 ...(SC.oneTap && SC.training ? { training: trainingView() } : {}), ...(SC.oneTap && SC.meals ? { meals: { lunch: '12:30', dinner: '20:00' } } : {}) },
        trainingEnabled: SC.registered && SC.oneTap, mealsEnabled: SC.registered && SC.oneTap } };
      case 'pushPrefsSet': {
        sets.push(body.prefs);
        if ('trainingTime' in body.prefs) SC.tTime = body.prefs.trainingTime;
        if ('trainingDays' in body.prefs) SC.tDays = body.prefs.trainingDays;
        return pushReply({ ...body, type: 'pushPrefsGet' });
      }
      default: return { ok: true };
    }
  }
  handlers.push((d) => {
    if (d.sessionId !== s) return;
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text);
    if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, s).catch(() => {});
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params;
      // Scope: the push function (what this feature touches). The shells' own api GETs are out of scope here.
      if (/\/push(\?|$)/.test(request.url) && (/[?&](t|token)=/.test(request.url) || /e2e-token/.test(request.url))) leaks.push(request.url);
      let body = '{"ok":true}';
      if (/\/push$/.test(request.url)) { try { body = JSON.stringify(pushReply(JSON.parse(request.postData || '{}'))); } catch { body = '{"ok":false}'; } }
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(body).toString('base64') }, s).catch(() => {});
    }
  });
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] }, s);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_OS }, s);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
  const ORIGIN = 'http://127.0.0.1:9951';
  const reset = async () => { await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' }, s); };
  const sheet = () => ev(`(() => { const a = document.getElementById('lip-ask'); return a ? { title: (a.querySelector('.lip-title')||{}).textContent, text: (a.querySelector('.lip-text')||{}).textContent, buttons: [...a.querySelectorAll('button')].map(b => b.textContent) } : null; })()`);
  const ls = (k) => ev(`localStorage.getItem(${JSON.stringify(k)})`);
  const tap = (label) => ev(`(() => { const b = [...document.querySelectorAll('#lip-ask button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

  for (const key of KEYS) {
    const url = `${ORIGIN}/clients/${key}/?t=e2e-token-${key}`;
    const open = async (u = url) => { await send('Page.navigate', { url: u }, s); await sleep(3200); };
    const P = (n) => `${key}: ${n}`;
    const setLS = (k, v) => ev(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
    errors.length = 0; calls.length = 0;
    await send('Emulation.setUserAgentOverride', { userAgent: '' }, s).catch(() => {});

    // ── A: the one tap ──────────────────────────────────────────────────────
    await reset(); Object.assign(SC, { oneTap: true, training: true, meals: true, registered: false });
    await open();
    const shot = async (name) => { if (!SHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }, s); fs.writeFileSync(path.join(SHOT_DIR, `${key}_${name}.png`), Buffer.from(data, 'base64')); };
    if (SHOT_DIR) await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
    if (SHOT_DIR) await open();
    let sh = await sheet();
    await shot('1_ask');
    check(P('A1 sheet appears on open for a rollout client'), !!sh, sh);
    check(P('A2 title names workouts and meals (plan has both)'), sh && sh.title === 'Get reminders for your workouts and meals?', sh && sh.title);
    check(P('A3 two choices: Turn on reminders / Not now'), sh && sh.buttons.join('|') === 'Turn on reminders|Not now', sh && sh.buttons);
    check(P('A4 OS permission NOT requested before the tap'), (await ls('__permCalls')) === null, await ls('__permCalls'));
    check(P('A5 nothing subscribed before the tap'), !calls.includes('pushSubscribe'), calls);
    check(P('A6 the button press reached the sheet'), await tap('Turn on reminders'));
    await sleep(800);
    check(P('A7 OS permission requested exactly once'), (await ls('__permCalls')) === '1', await ls('__permCalls'));
    check(P('A8 …and from inside the tap'), (await ls('__permDuringClick')) === '1', await ls('__permDuringClick'));
    check(P('A9 subscribed once'), calls.filter((c) => c === 'pushSubscribe').length === 1, calls);
    sh = await sheet();
    await shot('2_done');
    check(P('A10 sheet confirms "Reminders are on"'), sh && sh.title === 'Reminders are on', sh);
    check(P('A11 confirmation names training + meal times'), sh && /training and meal times/.test(sh.text), sh && sh.text);
    await tap('Done'); await sleep(200);
    check(P('A12 Done closes the sheet'), (await sheet()) === null);
    const pill = await ev(`(() => { const p = document.querySelector('#li-push-settings .lip-pill'); return p ? p.textContent : null; })()`);
    check(P('A13 Notifications card now reads On'), pill === 'On', pill);
    await open();
    check(P('A14 reopening the app: no sheet'), (await sheet()) === null);
    check(P('A15 reopening: permission never asked again'), (await ls('__permCalls')) === '1', await ls('__permCalls'));

    // ── G: the Notifications settings (registered from A) ──────────────────
    const card = () => ev(`(() => { const c = document.querySelector('#li-push-settings .lip-card'); if (!c) return null;
      const rows = [...c.querySelectorAll('.lip-row')].map(r => r.textContent);
      return { rows, time: (c.querySelector('select[aria-label="Training reminder time"]')||{}).value || null,
               chips: [...c.querySelectorAll('.lip-day')].map(b => b.getAttribute('aria-label') + ':' + b.getAttribute('aria-pressed')).join(','),
               reset: !!c.querySelector('.lip-link') }; })()`);
    const openCard = () => ev(`(() => { const h = document.querySelector('#li-push-settings .lip-head'); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); return !!h; })()`);
    SC.tTime = null; SC.tDays = null; sets.length = 0;
    await openCard(); await sleep(300);
    let cd = await card();
    const trRow = cd && cd.rows.find((r) => r.startsWith('Training reminders'));
    check(P('G1 training row shows the default days'), trRow && trRow.includes('Mon, Tue, Thu, Fri'), cd && cd.rows);
    check(P('G2 training time shows 5:00 PM'), cd && cd.time === '17:00', cd && cd.time);
    check(P('G3 day chips: Mon/Tue/Thu/Fri on'), cd && cd.chips === 'Mon:true,Tue:true,Wed:false,Thu:true,Fri:true,Sat:false,Sun:false', cd && cd.chips);
    check(P('G4 meals row shows lunch + dinner, read-only'), cd && cd.rows.some((r) => r.startsWith('Meal reminders') && r.includes('Lunch 12:30 PM · Dinner 8:00 PM')) &&
      (await ev(`[...document.querySelectorAll('#li-push-settings .lip-row')].find(r => r.textContent.startsWith('Meal reminders')).querySelectorAll('select').length`)) === 0,
      cd && cd.rows.filter((r) => r.startsWith('Meal')));   // no time picker on the meal row
    await ev(`[...document.querySelectorAll('#li-push-settings .lip-day')].find(b => b.getAttribute('aria-label') === 'Sat').click()`); await sleep(400);
    check(P('G5 tapping Sat adds it'), JSON.stringify(sets.at(-1)) === JSON.stringify({ trainingDays: [1, 2, 4, 5, 6] }), sets.at(-1));
    cd = await card();
    check(P('G6 Sat now on; "Reset to my plan" offered'), cd && cd.chips.includes('Sat:true') && cd.reset, cd);
    await ev(`(() => { const s = document.querySelector('#li-push-settings select[aria-label="Training reminder time"]'); s.value = '18:30'; s.dispatchEvent(new Event('change')); })()`); await sleep(400);
    check(P('G7 changing the time saves it'), JSON.stringify(sets.at(-1)) === JSON.stringify({ trainingTime: '18:30' }), sets.at(-1));
    cd = await card();
    check(P('G8 time shown back as 6:30 PM'), cd && cd.time === '18:30', cd && cd.time);
    await ev(`document.querySelector('#li-push-settings .lip-link').click()`); await sleep(400);
    check(P('G9 reset sends both back to the plan in one save'), JSON.stringify(sets.at(-1)) === JSON.stringify({ trainingTime: null, trainingDays: null }), sets.at(-1));
    cd = await card();
    check(P('G10 back to the default'), cd && cd.time === '17:00' && !cd.reset && cd.chips.includes('Sat:false'), cd);
    SC.tDays = [3]; await open(); await openCard(); await sleep(300);
    const lone = await ev(`[...document.querySelectorAll('#li-push-settings .lip-day')].find(b => b.getAttribute('aria-label') === 'Wed').disabled`);
    check(P('G11 the last remaining day cannot be removed'), lone === true, lone);
    SC.tDays = null;

    // ── B: Not now → once more after 7 days → never ─────────────────────────
    await reset(); Object.assign(SC, { oneTap: true, registered: false });
    await open();
    check(P('B1 sheet shown'), !!(await sheet()));
    await tap('Not now'); await sleep(200);
    check(P('B2 Not now closes it'), (await sheet()) === null);
    check(P('B3 Not now asks the OS nothing'), (await ls('__permCalls')) === null && !calls.slice(-5).includes('pushSubscribe'));
    await open();
    check(P('B4 reopened the same week: no sheet'), (await sheet()) === null);
    const ask = JSON.parse(await ls(`li_push_ask_${key}`));
    await setLS(`li_push_ask_${key}`, JSON.stringify({ n: ask.n, at: Date.now() - 8 * 86400000 }));
    await open();
    check(P('B5 after 7 days: asked once more'), !!(await sheet()));
    await tap('Not now'); await sleep(200);
    await setLS(`li_push_ask_${key}`, JSON.stringify({ n: 2, at: Date.now() - 400 * 86400000 }));
    await open();
    check(P('B6 after a second Not now: never again'), (await sheet()) === null);

    // ── C: never shown ──────────────────────────────────────────────────────
    await reset(); Object.assign(SC, { oneTap: false, registered: false });
    await open();
    check(P('C1 outside the rollout: no sheet'), (await sheet()) === null);
    await reset(); Object.assign(SC, { oneTap: true, registered: false });
    await open(); await setLS('__perm', 'denied'); await open();
    check(P('C2 permission already denied: no sheet'), (await sheet()) === null);
    await reset(); Object.assign(SC, { oneTap: true, registered: true });
    await open(); await setLS('__perm', 'granted'); await setLS('__sub', 'https://fcm.googleapis.com/fcm/send/old'); await open();
    check(P('C3 already registered on this phone: no sheet'), (await sheet()) === null);
    await reset(); Object.assign(SC, { oneTap: true, registered: false });
    await send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' }, s);
    await open();
    check(P('C4 iPhone Safari tab (not Home Screen app): no sheet'), (await sheet()) === null);
    await send('Emulation.setUserAgentOverride', { userAgent: '' }, s);

    // ── D: the OS "Don't Allow" ─────────────────────────────────────────────
    await reset(); Object.assign(SC, { oneTap: true, registered: false });
    await open(); await setLS('__permAnswer', 'denied'); calls.length = 0;
    check(P('D1 sheet shown'), !!(await sheet()));
    await tap('Turn on reminders'); await sleep(800);
    check(P('D2 OS said no: sheet closes'), (await sheet()) === null);
    check(P('D3 OS said no: nothing subscribed'), !calls.includes('pushSubscribe'), calls);
    await open();
    check(P('D4 OS said no: never offered again'), (await sheet()) === null);

    // ── E: wording follows the plan ─────────────────────────────────────────
    await reset(); Object.assign(SC, { oneTap: true, training: false, meals: false, registered: false });
    await open();
    sh = await sheet();
    check(P('E1 no plan times: neutral title'), sh && sh.title === 'Get reminders?', sh);
    check(P('E2 no plan times: promises check-in + program updates only'), sh && /check-in day and when Omar updates your program/.test(sh.text) && !/meal|training/.test(sh.text), sh && sh.text);
    Object.assign(SC, { training: true, meals: false });
    await reset(); await open(); sh = await sheet();
    check(P('E3 training only: names workouts, not meals'), sh && sh.title === 'Get reminders for your workouts?' && !/meal/.test(sh.text), sh);
    Object.assign(SC, { training: true, meals: true });

    // ── F ───────────────────────────────────────────────────────────────────
    check(P('F1 the client token never appears in a push-function URL'), leaks.length === 0, leaks.slice(0, 2));
    check(P('F2 no page errors'), errors.length === 0, errors.slice(0, 3));
    check(P('F3 page OS simulation installed'), (await ev('window.__fakeOsError || null')) === null);
  }

  ws.close(); chrome.kill(); srv.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  let fail = 0;
  for (const c of checks) { console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '   ' + JSON.stringify(c.detail).slice(0, 200)}`); if (!c.pass) fail++; }
  console.log(`\nonetap_e2e: ${checks.length - fail} passed, ${fail} failed, ${checks.length} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
