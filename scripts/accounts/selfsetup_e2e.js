#!/usr/bin/env node
// IN-APP LOGIN SETUP — the on-open "Set up your login" sheet (account-setup.js,
// loaded by push-client.js), in headless Chrome against REAL shells.
//
//   node scripts/accounts/selfsetup_e2e.js <storage_key> [<storage_key> …]
//
// Serves clients/<key>/index.html (read-only, never modified) with the repo's
// push-client.js and sw.js from 127.0.0.1. EVERY *.supabase.co request is
// intercepted and answered by a local fake of the push function — nothing
// reaches production. The browser's notification permission and push
// subscription are simulated in the page (headless Chrome has no push service),
// so what is under test is the sheet's behaviour, not the OS.
//
// Proves, per shell:
//   A  can set up: the sheet appears on open; one save sends email + password in the
//      POST body; "You're all set"; reopening never asks again.
//   B  "Later": hidden for 2 days, then offered again.
//   C  never shown: the server says needs a link (canSetup false) · account exists ·
//      no key on this phone.
//   D  errors keep the sheet open with a plain message; a too-short password never
//      reaches the server.
//   E  never on top of the notifications sheet: it waits until that one is answered.
//   F  the password is never stored; the key never appears in a URL; no page errors.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = process.argv.slice(2);
if (!KEYS.length) { console.error('usage: onetap_e2e.js <storage_key> …'); process.exit(2); }
const ROOT = path.join(__dirname, '..', '..');
const CHROME = { p: null };   // killed on every exit path, so a crash never leaves a browser on the port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_DIR = process.env.SHOT_DIR || '';   // optional: phone-size screenshots of the sheet
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let body = null, type = 'text/html';
  const m = /^\/clients\/([a-z0-9_]+)\/(index\.html)?$/.exec(u);
  if (m && fs.existsSync(path.join(ROOT, 'clients', m[1], 'index.html'))) body = fs.readFileSync(path.join(ROOT, 'clients', m[1], 'index.html'));
  else if (u === '/sw.js' || u === '/push-client.js' || u === '/account-setup.js') { body = fs.readFileSync(path.join(ROOT, u)); type = 'text/javascript'; }
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
  await new Promise((r) => srv.listen(9961, '127.0.0.1', r));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'selfsetup-e2e-'));
  const chrome = CHROME.p = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9963', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9963/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const handlers = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const checks = []; const errors = [];
  const check = (name, cond, detail) => checks.push({ name, pass: !!cond, ...(cond ? {} : { detail }) });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });

  // ── fake push function (scenario-driven) ──────────────────────────────────
  const SC = { oneTap: false, training: true, meals: true, registered: false, tTime: null, tDays: null,
               account: 'none', canSetup: true, setupReply: null };
  const acct = [];
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
      // Scope: POST calls (push + the account ops). The shells' own api GETs are out of scope here.
      if (request.method === 'POST' && /e2e-token|[?&](t|token)=/.test(request.url)) leaks.push(request.url);
      let body = '{"ok":true}';
      if (/\/push$/.test(request.url)) { try { body = JSON.stringify(pushReply(JSON.parse(request.postData || '{}'))); } catch { body = '{"ok":false}'; } }
      else if (/\/api$/.test(request.url) && request.method === 'POST') {
        let b = {}; try { b = JSON.parse(request.postData || '{}'); } catch {}
        if (b.type === 'accountSelfStatus') { acct.push({ type: b.type, hasToken: !!b.token }); body = JSON.stringify({ ok: true, account: SC.account, canSetup: SC.canSetup }); }
        else if (b.type === 'accountSelfSetup') {
          acct.push({ type: b.type, email: b.email, pwLen: String(b.password || '').length, hasToken: !!b.token, key: b.storageKey });
          body = JSON.stringify(SC.setupReply || { ok: true, email: String(b.email).trim().toLowerCase() });
          if (!SC.setupReply) SC.account = 'active';
        }
      }
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(body).toString('base64') }, s).catch(() => {});
    }
  });
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] }, s);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_OS }, s);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
  const ORIGIN = 'http://127.0.0.1:9961';
  const reset = async () => { await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' }, s); };
  const sheet = () => ev(`(() => { const a = document.getElementById('lip-ask'); return a ? { title: (a.querySelector('.lip-title')||{}).textContent, text: (a.querySelector('.lip-text')||{}).textContent, buttons: [...a.querySelectorAll('button')].map(b => b.textContent) } : null; })()`);
  const ls = (k) => ev(`localStorage.getItem(${JSON.stringify(k)})`);
  const tap = (label) => ev(`(() => { const b = [...document.querySelectorAll('#lip-ask button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

  const accSheet = () => ev(`(() => { const a = document.getElementById('lia-ask'); return a ? { title: (a.querySelector('.lia-title')||{}).textContent, text: (a.querySelector('.lia-text')||{}).textContent, err: (a.querySelector('.lia-err')||{}).textContent || '', buttons: [...a.querySelectorAll('button')].map(b => b.textContent) } : null; })()`);
  const fill = (em, pw) => ev(`(() => { const e = document.getElementById('lia-email'), p = document.getElementById('lia-password'); if (!e) return false; e.value = ${JSON.stringify(em)}; p.value = ${JSON.stringify(pw)}; document.querySelector('#lia-ask form').requestSubmit(); return true; })()`);
  const btn = (label, root = '#lia-ask') => ev(`(() => { const b = [...document.querySelectorAll('${root} button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  const types = () => acct.map((a) => a.type);
  // Cold starts vary: wait for the sheet (up to 10 s) wherever one is expected.
  const waitAcc = async () => { for (let i = 0; i < 40 && !(await accSheet()); i++) await sleep(250); return accSheet(); };

  // Warm-up: the very first page in a brand-new browser profile (cold cache, first
  // service-worker install) boots far slower than any later one. Load it once, discard.
  await send('Page.navigate', { url: `${ORIGIN}/clients/${KEYS[0]}/` }, s); await sleep(9000); await reset();

  for (const key of KEYS) {
    const url = `${ORIGIN}/clients/${key}/?t=e2e-token-${key}`;
    const open = async (u = url, ms = 7000) => { await send('Page.navigate', { url: u }, s); await sleep(ms); };
    const P = (n) => `${key}: ${n}`;
    const setLS = (k, v) => ev(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
    const fresh = async (sc) => { await reset(); Object.assign(SC, { oneTap: false, registered: false, account: 'none', canSetup: true, setupReply: null }, sc); acct.length = 0; calls.length = 0; };
    errors.length = 0;

    // ── A ──
    await fresh({});
    await open();
    let sh = await waitAcc();
    check(P('A1 sheet appears on open'), sh && sh.title === 'Set up your login', sh);
    check(P('A2 the status check carried the phone key in the body'), acct[0] && acct[0].type === 'accountSelfStatus' && acct[0].hasToken, acct);
    check(P('A3 fields: email + new password'), (await ev(`[document.getElementById('lia-email').autocomplete, document.getElementById('lia-password').autocomplete, document.getElementById('lia-password').type].join()`)) === 'email,new-password,password');
    await fill('  Client@Mail.com ', 'a-good-password'); await sleep(600);
    const sent = acct.find((a) => a.type === 'accountSelfSetup');
    check(P('A4 one save with email + password + key'), acct.filter((a) => a.type === 'accountSelfSetup').length === 1 && !!sent && sent.email === 'Client@Mail.com' && sent.pwLen === 15 && sent.hasToken && sent.key === key, sent);
    sh = await accSheet();
    check(P('A5 "You\'re all set" with the email'), sh && sh.title === "You're all set" && sh.text.includes('client@mail.com'), sh);
    check(P('A6 the password field is gone'), (await ev(`!document.getElementById('lia-password')`)) === true);
    await btn('Done'); await sleep(200);
    check(P('A7 Done closes it'), (await accSheet()) === null);
    acct.length = 0; await open();
    check(P('A8 reopening: no sheet, no further status call'), (await accSheet()) === null && acct.length === 0, acct);

    // ── B ──
    await fresh({});
    await open();
    check(P('B1 sheet shown'), !!(await waitAcc()));
    await btn('Later'); await sleep(200);
    check(P('B2 Later closes it'), (await accSheet()) === null && !types().includes('accountSelfSetup'));
    await open();
    check(P('B3 same day: not shown'), (await accSheet()) === null);
    await setLS(`li_account_setup_${key}`, JSON.stringify({ snoozedAt: Date.now() - 3 * 86400000 }));
    await open();
    check(P('B4 after 2 days: offered again'), !!(await waitAcc()));

    // ── C ──
    await fresh({ canSetup: false });
    await open();
    check(P('C1 needs a link (canSetup false): no sheet'), (await accSheet()) === null);
    acct.length = 0; await open();
    check(P('C2 …and it stops asking the server'), acct.length === 0, acct);
    await fresh({ account: 'active', canSetup: false });
    await open();
    check(P('C3 account already exists: no sheet'), (await accSheet()) === null);
    await fresh({});
    await open(`${ORIGIN}/clients/${key}/`);
    check(P('C4 no key on this phone: no sheet, no call'), (await accSheet()) === null && acct.length === 0, acct);

    // ── D ──
    await fresh({ setupReply: { ok: false, error: 'email_in_use' } });
    await open(); await waitAcc();
    await fill('taken@mail.com', 'a-good-password'); await sleep(600);
    sh = await accSheet();
    check(P('D1 email in use: stays open with a plain message'), sh && /already has a LOCKED IN login/.test(sh.err), sh);
    acct.length = 0;
    await fill('ok@mail.com', 'short'); await sleep(300);
    sh = await accSheet();
    check(P('D2 short password: caught on the phone, nothing sent'), acct.length === 0 && sh && /at least 8/.test(sh.err), sh);
    await fill('not-an-email', 'a-good-password'); await sleep(300);
    check(P('D3 bad email: caught on the phone, nothing sent'), acct.length === 0);
    await fresh({ setupReply: { ok: false, error: 'needs_invite' } });
    await open(); await waitAcc();
    await fill('x@mail.com', 'a-good-password'); await sleep(600);
    check(P('D4 server says needs a link: sheet closes for good'), (await accSheet()) === null && (JSON.parse((await ls(`li_account_setup_${key}`)) || '{}').needsInvite === true));

    // ── E ──
    await fresh({ oneTap: true });
    await open(url, 7000);
    check(P('E1 notifications sheet first, login sheet waits'), !!(await sheet()) && (await accSheet()) === null);
    await tap('Not now'); await sleep(1500);
    check(P('E2 after the notifications answer, the login sheet appears'), !!(await waitAcc()));

    // ── F ──
    const store = await ev(`JSON.stringify(Object.assign({}, localStorage))`);
    check(P('F1 the password is never stored'), !/a-good-password/.test(store));
    check(P('F2 the key never appears in a POST URL'), leaks.length === 0, leaks.slice(0, 2));
    check(P('F3 no page errors'), errors.length === 0, errors.slice(0, 3));
  }

  ws.close(); chrome.kill(); srv.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  let fail = 0;
  for (const c of checks) { console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '   ' + String(JSON.stringify(c.detail)).slice(0, 200)}`); if (!c.pass) fail++; }
  console.log(`\nselfsetup_e2e: ${checks.length - fail} passed, ${fail} failed, ${checks.length} total`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { CHROME.p && CHROME.p.kill(); } catch {} process.exit(1); });
