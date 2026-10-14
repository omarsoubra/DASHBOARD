// COACH DASHBOARD UI regression harness: coach_dashboard.html in headless Chrome against a FAKE backend.
//
// SAFETY: the dashboard syncs its roster to the live Supabase backend, and a fresh browser pointed at the real backend
// once wiped production data. Nothing here can reach a real network:
//   1. an init script, injected before any page script, replaces fetch / XMLHttpRequest / sendBeacon / EventSource /
//      WebSocket. *.supabase.co calls are answered from tests/coach_ui_fixture.js; any other non-local URL is refused
//      and recorded as a test failure. Service-worker registration, Notification and push subscription are faked.
//   2. underneath, the CDP Fetch domain intercepts EVERY request of the tab: 127.0.0.1 continues, the three static CDN
//      assets the page links (Chart.js, its date adapter, Google Fonts css) are answered with local stubs, everything
//      else (including a supabase.co call that somehow slipped past layer 1) is failed and recorded as a test failure.
//   3. files are served from this worktree on 127.0.0.1; clients_registry.json and clients/<key>/ are fixture-only,
//      so no real client page or registry is ever loaded.
// The page starts logged in with a FAKE coach token. Every API 'type' is recorded per page; any write type (rosterPut,
// checkinDraftMark, ...) fired just from viewing is a failure (one step deliberately exercises Copy reply and allows
// exactly checkinDraftMark).
//
// usage: node tests/coach_ui.test.js [--shots <dir>] [--only v2|phone|classic] [--strict] [--verbose]
//   --shots   save a screenshot per page (desktop 1440x900 and phone 390x844)
//   --strict  KNOWN page bugs (printed under "Known issues") fail the run too
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const { build, EXPECT, NEVER_IN_QUEUE } = require('./coach_ui_fixture');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SHOTS = opt('--shots') ? path.resolve(opt('--shots')) : null;
const ONLY = opt('--only');
const STRICT = argv.includes('--strict');

const TOKEN = 'coach-ui-harness-FAKE-token-0000';
const FX = build(Date.now());

// Reads the page may make while merely viewing. Anything else is treated as a write.
const READ_TYPES = ['dashboard', 'rosterGet', 'checkinDraftsGet', 'healthGet', 'accountList', 'intakeList', 'coachWorkoutCompletions',
  'clientProgram', 'progressionHistory', 'progressionCompute', 'weightLog', 'photosGet', 'overrideGet', 'coachPushStatus', 'registryGetPrivate',
  'coachClientHistory', 'entitlementsGet', 'intakeGet', 'legacyQueueGet'];

// Static third-party assets coach_dashboard.html links in <head>; served from local stubs, never fetched.
const CHART_STUB = `(function(){function C(ctx,cfg){this.ctx=ctx;this.config=cfg||{};this.data=(cfg&&cfg.data)||{};this.options=(cfg&&cfg.options)||{};C.__instances.push(this);}
C.__instances=[];C.__stub=true;C.prototype.destroy=function(){this.destroyed=true;};C.prototype.update=function(){};C.prototype.resize=function(){};
C.register=function(){};C.defaults={font:{},color:'',plugins:{legend:{labels:{}},tooltip:{}},scales:{}};window.Chart=C;})();`;
const STATIC_STUBS = [
  { re: /^https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@[^/]+\/dist\/chart\.umd\.min\.js$/, type: 'text/javascript', body: CHART_STUB },
  { re: /^https:\/\/cdn\.jsdelivr\.net\/npm\/chartjs-adapter-date-fns@[^/]+\/dist\/chartjs-adapter-date-fns\.bundle\.min\.js$/, type: 'text/javascript', body: '/* stub */' },
  { re: /^https:\/\/fonts\.googleapis\.com\/css2\?/, type: 'text/css', body: '/* stub */' },
];

// ─────────────────────────────── page-side fake backend + network lock ───────────────────────────────
const INIT = String.raw`
(function () {
  var FX = __FX__, TOKEN = __TOKEN__, READ = __READ__;
  var U = window.__ui = { doc: Math.random().toString(36).slice(2), calls: [], blocked: [], opened: [], copied: [], notif: [], sw: [], dialogs: [], inflight: 0, lastEnd: 0, tokenMismatch: 0 };
  // storage: ?fresh=1 wipes everything; every load (re)seeds the fake login + fixture roster, already "synced" with the
  // fake cloud at the same timestamp, so the page has no reason to push the roster.
  try {
    if (/[?&]fresh=1/.test(location.search)) { localStorage.clear(); sessionStorage.clear(); }
    // fake cloud: what rosterPut stored (kept across reloads like the real server), else the fixture
    var cloud = null; try { cloud = JSON.parse(localStorage.getItem('__fx_cloud') || 'null'); } catch (e) {}
    if (cloud && cloud.roster) { FX.roster = cloud.roster; FX.rosterTs = cloud.ts; }
    localStorage.setItem('sbo_coach_token', TOKEN);
    localStorage.setItem('coach_clients_v1', JSON.stringify(FX.roster));
    localStorage.setItem('coach_clients_v1_ts', String(FX.rosterTs));
    localStorage.setItem('coach_clients_v1_synced_ts', String(FX.rosterTs));
  } catch (e) {}

  function kind(u) {
    var x; try { x = new URL(String(u), location.href); } catch (e) { return 'external'; }
    if (x.protocol === 'data:' || x.protocol === 'blob:' || x.protocol === 'about:') return 'local';
    if (x.origin === location.origin) return 'local';
    if (/(^|\.)supabase\.co$/.test(x.hostname)) return 'supabase';
    return 'external';
  }
  function block(api, u) { U.blocked.push({ api: api, url: String(u).slice(0, 200), hash: location.hash }); }

  var drafts = JSON.parse(JSON.stringify(FX.drafts));
  function per(map, b, fallback) { var k = String(b.storageKey || b.client || '').toLowerCase(); return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : fallback; }
  function answer(fn, b) {
    var t = b.type;
    if (fn === 'push') {
      if (t === 'coachPushStatus') return { ok: true, vapidPublicKey: 'BJ3Yk2k5RkVfYWtlLXZhcGlkLWtleS1ub3QtcmVhbC0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA', registered: false, devices: 0 };
      return { ok: false, error: 'harness_refused' };
    }
    switch (t) {
      case 'dashboard': return { ok: true, dashboard: FX.dashboard };
      case 'rosterGet': return { ok: true, ts: FX.rosterTs, roster: FX.roster };
      case 'rosterPut': { FX.roster = b.roster; FX.rosterTs = Number(b.ts) || Date.now(); try { localStorage.setItem('__fx_cloud', JSON.stringify({ ts: FX.rosterTs, roster: FX.roster })); } catch (e) {} return { ok: true }; }
      case 'checkinDraftsGet': return { ok: true, drafts: drafts };
      case 'healthGet': return { ok: true, rows: FX.health.rows, status: FX.health.status, targets: FX.health.targets || {} };
      case 'accountList': return { ok: true, clients: FX.accounts };
      case 'intakeList': return { ok: true, intakes: FX.intakes };
      case 'coachWorkoutCompletions': return { ok: true, generatedAt: new Date().toISOString(), windowDays: 42, clients: FX.cwv };
      case 'clientProgram': { var p = per(FX.programs, b, null); return p ? { ok: true, program: p } : { ok: false, error: 'program_missing' }; }
      case 'progressionHistory': return { ok: true, history: per(FX.progressionHistory, b, {}), storageKey: b.storageKey };
      case 'progressionCompute': return { ok: true, decisions: [] };
      case 'weightLog': return per(FX.weightLogs, b, []);
      case 'photosGet': return { ok: true, photos: per(FX.photos, b, []), signedUrlTtlSec: 3600, baselineIntakeIds: [], multipleBaselines: false };
      case 'overrideGet': return { ok: true };
      case 'checkinDraftMark': {
        var d = drafts.filter(function (x) { return x.client_key === b.clientKey && x.checkin_ts === b.checkinTs; })[0];
        if (!d) return { ok: false, error: 'not_found' };
        d.sent_at = b.sent === false ? null : new Date().toISOString();
        return { ok: true, sent_at: d.sent_at };
      }
      default: return { ok: true };
    }
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var u = String((input && input.url) || input), k = kind(u);
    if (k === 'local') return realFetch(input, init);
    if (k !== 'supabase') { block('fetch', u); return Promise.reject(new TypeError('coach_ui harness: network blocked ' + u)); }
    var b = {}; try { b = JSON.parse((init && init.body) || '{}'); } catch (e) {}
    var fn = /\/functions\/v1\/push(\b|$)/.test(u) ? 'push' : /\/functions\/v1\/api(\b|$)/.test(u) ? 'api' : 'other';
    if (b.coachToken !== TOKEN) U.tokenMismatch++;
    U.calls.push({ fn: fn, type: b.type || '(none)', hash: location.hash, write: READ.indexOf(b.type) < 0, at: Date.now() });
    U.inflight++;
    var r = answer(fn, b);
    return new Promise(function (res) {
      setTimeout(function () {
        U.inflight--; U.lastEnd = Date.now();
        res(new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }, 15);
    });
  };
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (kind(this.__u) !== 'local') { block('xhr', this.__u); var x = this; setTimeout(function () { try { x.dispatchEvent(new ProgressEvent('error')); } catch (e) {} }, 0); return; }
    return XS.apply(this, arguments);
  };
  try { navigator.sendBeacon = function (u) { if (kind(u) !== 'local') { block('beacon', u); return false; } return true; }; } catch (e) {}
  window.EventSource = function (u) { block('eventsource', u); throw new Error('coach_ui harness: EventSource blocked'); };
  window.WebSocket = function (u) { block('websocket', u); throw new Error('coach_ui harness: WebSocket blocked'); };
  // service worker / push / notifications: inert fakes (nothing registers, nothing subscribes)
  var reg = { pushManager: {
      getSubscription: function () { return Promise.resolve(null); },
      subscribe: function () { U.notif.push('subscribe'); return Promise.reject(new Error('push disabled in test')); },
      permissionState: function () { return Promise.resolve('denied'); } },
    showNotification: function () { U.notif.push('showNotification'); return Promise.resolve(); }, active: null };
  var swFake = { register: function (u) { U.sw.push(String(u)); return Promise.reject(new Error('service worker disabled in test')); },
    ready: Promise.resolve(reg), controller: null, getRegistration: function () { return Promise.resolve(undefined); },
    getRegistrations: function () { return Promise.resolve([]); }, addEventListener: function () {}, removeEventListener: function () {} };
  try { Object.defineProperty(navigator, 'serviceWorker', { value: swFake, configurable: true }); } catch (e) {}
  function N(title) { U.notif.push('new Notification: ' + title); }
  N.permission = 'default';
  N.requestPermission = function () { U.notif.push('requestPermission'); return Promise.resolve('denied'); };
  window.Notification = N;
  if (!('PushManager' in window)) window.PushManager = function () {};
  // no popups / dialogs / clipboard side effects
  window.open = function (u) { U.opened.push(String(u)); return null; };
  window.confirm = function (m) { U.dialogs.push('confirm: ' + m); return false; };
  window.prompt = function (m) { U.dialogs.push('prompt: ' + m); return null; };
  window.alert = function (m) { U.dialogs.push('alert: ' + m); };
  window.print = function () { U.dialogs.push('print'); };
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { U.copied.push(String(t)); return Promise.resolve(); } }, configurable: true }); } catch (e) {}
})();`
  .replace('__FX__', () => JSON.stringify(FX)).replace('__TOKEN__', JSON.stringify(TOKEN)).replace('__READ__', JSON.stringify(READ_TYPES));

// ─────────────────────────────── local server ───────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PHOTO = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#d9dce3"/><text x="150" y="200" font-size="22" text-anchor="middle" fill="#555">fixture photo</text></svg>';
function serve() {
  const keys = new Set(FX.roster.map((c) => c.storageKey));
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/clients_registry.json') { res.writeHead(200, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify(FX.registry)); }
    if (u === '/__fixture/photo.svg') { res.writeHead(200, { 'Content-Type': MIME['.svg'] }); return res.end(PHOTO); }
    const m = u.match(/^\/clients\/([^/]+)\/(index\.html)?$/);
    if (m && keys.has(m[1]) && FX.pageStatus[m[1]] !== 404) {
      // fixture page carries the generator's phase labels + unlock codes (KWAME20 / KWAME30) - never a real client page
      const K = m[1].split('_')[0].toUpperCase();
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end('<!doctype html><title>fixture client page</title><script>var P = {\n  2: {\n    label: "Build", weeks: "5–8",\n  },\n  3: {\n    label: "Peak", weeks: "9–12",\n  },\n};\n' +
        'var CLIENT_CONFIG = { phases: {\n    2: { unlockCode: \'' + K + '20\', unlockAfterDays: 28 },\n    3: { unlockCode: \'' + K + '30\', unlockAfterDays: 56 },\n  } };</script>');
    }
    if (u.startsWith('/clients/')) { res.writeHead(404); return res.end(); }               // never serve a real client page
    let f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
    if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ─────────────────────────────── reporting ───────────────────────────────
const results = [], known = [], apiByPage = {};
let group = '';
const t = (name, cond, detail) => {
  results.push({ group, name, ok: !!cond });
  if (cond) console.log('  ok   ' + name);
  else console.log('  FAIL ' + name + (detail !== undefined ? '  -- ' + JSON.stringify(detail).slice(0, 600) : ''));
};
// A genuine bug in the CURRENT page: reported, fails only with --strict (the harness must not fix the page).
const knownBug = (name, holds, detail) => {
  if (holds) { t(name, true); return; }
  known.push({ group, name, detail });
  if (STRICT) t('[known bug] ' + name, false, detail);
  else console.log('  KNOWN ' + name + (detail !== undefined ? '  -- ' + JSON.stringify(detail).slice(0, 400) : ''));
};

(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init();
  const warns = [], netBlocked = [], netStubbed = [], logs = [];
  c.on((m, p) => {
    if (m === 'Runtime.consoleAPICalled' && (p.type === 'warning' || p.type === 'warn')) warns.push(p.args.map((a) => a.value != null ? a.value : a.description).join(' ').slice(0, 300));
    if (m === 'Runtime.consoleAPICalled' && p.type === 'log') logs.push(p.args.map((a) => a.value != null ? a.value : a.description).join(' ').slice(0, 200));
    if (m === 'Fetch.requestPaused') {
      const url = p.request.url;
      if (url.startsWith(base + '/') || url === base) { c.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
      const stub = STATIC_STUBS.find((s) => s.re.test(url));
      if (stub) {
        netStubbed.push(url);
        c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: stub.type }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(stub.body).toString('base64') }).catch(() => {});
        return;
      }
      netBlocked.push(url.slice(0, 200));
      c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
    if (m === 'Network.webSocketCreated') netBlocked.push('websocket ' + p.url);
  });
  await c.send('Network.enable');
  await c.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.addInit(INIT);

  const ev = (js) => page.eval(js);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idle = async (min = 350) => {
    await sleep(min);
    for (let i = 0; i < 40; i++) {
      const s = await ev(`(function(){ var u = window.__ui; return u ? { f: u.inflight, e: Date.now() - u.lastEnd } : { f: 0, e: 1e9 }; })()`).catch(() => ({ f: 0, e: 1e9 }));
      if (s.f === 0 && s.e > 250) return;
      await sleep(100);
    }
  };
  const J = JSON.stringify;
  const txt = (sel) => ev(`(function(){ var e = document.querySelector(${J(sel)}); return e ? e.innerText.trim() : null; })()`);
  const count = (sel) => ev(`document.querySelectorAll(${J(sel)}).length`);
  const exists = (sel) => ev(`!!document.querySelector(${J(sel)})`);
  const visible = (sel) => ev(`(function(){ var e = document.querySelector(${J(sel)}); if (!e) return false; var r = e.getBoundingClientRect(); var s = getComputedStyle(e); return !e.closest('[hidden]') && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; })()`);
  const click = (sel) => ev(`(function(){ var e = document.querySelector(${J(sel)}); if (!e) return false; e.click(); return true; })()`);
  const go = async (hash, ms) => { await ev(`location.hash = ${J(hash)}; 1`); await idle(ms || 450); };
  const typeInto = (sel, value) => ev(`(function(){ var e = document.querySelector(${J(sel)}); if (!e) return false; e.focus(); e.value = ${J(value)};
    e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const VK = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 };
  const key = async (k) => {
    const code = VK[k] || k.toUpperCase().charCodeAt(0);
    const text = k.length === 1 ? k : undefined;
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k.length === 1 ? (/\d/.test(k) ? 'Digit' + k : 'Key' + k.toUpperCase()) : k, windowsVirtualKeyCode: code, text });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code });
    await sleep(120);
  };
  const blurAll = () => ev(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1)`);
  let vp = 'desktop';
  const viewport = async (name) => {
    vp = name;
    if (name === 'phone') await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    else await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    await sleep(150);
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, vp + '_' + name.replace(/[^a-z0-9_-]+/gi, '_') + '.png'), Buffer.from(r.data, 'base64'));
  };

  // A page/step: everything inside it must leave no console error, no swallowed render failure, no network escape and
  // no write call (except the explicitly allowed types). The API types it called are recorded for the summary.
  const BENIGN_WARN = /\[coach push\] Error: permission denied|^pullRoster|\[registry\]/;
  const step = async (name, fn, o) => {
    o = o || {};
    group = name; console.log('\n' + name);
    const st0 = await ev(`window.__ui ? { d: __ui.doc, c: __ui.calls.length, b: __ui.blocked.length } : { d: null, c: 0, b: 0 }`).catch(() => ({ d: null, c: 0, b: 0 }));
    const m0 = { e: page.errors.length, w: warns.length, n: netBlocked.length };
    try { await fn(); } catch (e) { t('step ran without a harness error', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
    await idle(250);
    const same = (await ev(`window.__ui ? __ui.doc : null`).catch(() => null)) === st0.d;   // a reload/navigation starts a fresh log
    const calls = await ev(`__ui.calls.slice(${same ? st0.c : 0})`).catch(() => []);
    const blocked = await ev(`__ui.blocked.slice(${same ? st0.b : 0})`).catch(() => []);
    const errs = page.errors.slice(m0.e).filter((x) => !/Failed to load resource|favicon/i.test(x));
    const badWarn = warns.slice(m0.w).filter((w) => !BENIGN_WARN.test(w) && (/\[ui-v2|failed|error|exception|undefined/i.test(w)));
    t(name + ': no console errors / uncaught exceptions', errs.length === 0, errs);
    t(name + ': no swallowed render failures (console.warn)', badWarn.length === 0, badWarn);
    t(name + ': no request escaped to the network', blocked.length === 0 && netBlocked.length === m0.n, blocked.concat(netBlocked.slice(m0.n)));
    const allow = o.writes || [];
    const writes = calls.filter((x) => x.write && allow.indexOf(x.type) < 0).map((x) => x.type);
    t(name + ': no write calls' + (allow.length ? ' (except ' + allow.join(', ') + ')' : ''), writes.length === 0, writes);
    const types = [...new Set(calls.map((x) => (x.fn === 'push' ? 'push:' : '') + x.type))];
    apiByPage[name] = (apiByPage[name] || []).concat(types.filter((x) => !(apiByPage[name] || []).includes(x)));
    if (o.shot) await shot(o.shot);
  };
  const boot = async (query) => {
    await page.goto(`${base}/coach_dashboard.html${query}`);
    await idle(1200);
    await idle(400);
  };
  const tqRows = () => ev(`[].map.call(document.querySelectorAll('#v2-tq-list .v2-tq-row'), function (r) {
    return { key: r.getAttribute('data-tqk'), why: (r.querySelector('.v2-tq-why') || {}).innerText, label: (r.querySelector('[data-tqgo]') || {}).innerText,
             all: (r.querySelector('.v2-tq-why') || { title: '' }).title, hot: r.classList.contains('is-act') }; })`);
  const tqFilter = async (f) => { await click(`[data-tqf="${f}"]`); await idle(200); };
  const backToToday = async () => {
    await ev(`(function(){ try { closeReviewModal(); } catch (e) {} try { closeClientForm(); } catch (e) {} try { _cd3CloseCompose && _cd3CloseCompose(); } catch (e) {}
      var x = document.querySelector('#v2-tq-panel [data-tqclose]'); if (x && !document.getElementById('v2-tq-panel').hidden) x.click(); return 1; })()`);
    await go('#/today');
  };

  try {
    // ═══════════════════════════════ PASS 1: V2 shell (default), desktop 1440x900 ═══════════════════════════════
    if (!ONLY || ONLY === 'v2') {
      await viewport('desktop');
      await step('V2 boot', async () => {
        await boot('?fresh=1#/today');
        t('V2 shell is on by default (body.ui-v2, #v2-shell visible)', await ev(`document.body.classList.contains('ui-v2') && !document.getElementById('v2-shell').hidden`));
        t('starts logged in with the fake token (login overlay hidden)', await ev(`getComputedStyle(document.getElementById('login-overlay')).display === 'none'`));
        const types = await ev(`__ui.calls.map(function (x) { return x.type; })`);
        t('boot loads dashboard + rosterGet + checkinDraftsGet + healthGet', ['dashboard', 'rosterGet', 'checkinDraftsGet', 'healthGet'].every((x) => types.includes(x)), types);
        t('every API call carried the fake coach token', (await ev(`__ui.tokenMismatch`)) === 0);
        t('roster is the fixture roster (no default clients seeded)', (await ev(`COACH.clients.length`)) === FX.roster.length && !(await ev(`COACH.clients.some(function (c) { return c.storageKey === 'amir'; })`)));
        t('service worker registration was neutralised', (await ev(`__ui.sw.length`)) >= 1 && (await ev(`!navigator.serviceWorker.controller`)));
        t('only the 3 static CDN assets were requested off-host, and they were stubbed', netStubbed.length >= 1 && netStubbed.every((u) => STATIC_STUBS.some((s) => s.re.test(u))), netStubbed);
      });

      // ── TODAY ──
      await step('Today', async () => {
        await go('#/today', 600);
        const dt = await ev(`document.getElementById('v2-date').textContent`);
        t('#v2-date greeting is set', /Good (morning|afternoon|evening) · /.test(dt), dt);
        const first = (await tqRows()).map((r) => r.key);
        knownBug('agent drafts (reply / journey / sent) show on the FIRST Today render after load', first.includes('jonah_r') && first.includes('tomasz_b'), { firstRender: first });
        await go('#/clients', 200); await go('#/today', 500);   // any re-render picks the drafts up
        const greet = await txt('#v2-greet');
        t('#v2-greet headline counts clients needing you + on track', /need(s)? you|Nothing urgent|All clear/.test(greet) && /on track/.test(greet), greet);
        const pulse = await txt('#v2-tq-pulse');
        t('#v2-tq-pulse summarises the last 24 h and links to #/activity', /Last 24 h/.test(pulse) && /PR/.test(pulse) && (await ev(`document.getElementById('v2-tq-pulse').getAttribute('href')`)) === '#/activity', pulse);
        t('4 filter cards', (await count('#v2-tq-cards [data-tqf]')) === 4);
        t('reviewed-this-week bar', /Reviewed this week/.test(await txt('#v2-tq-touch')) && /\d+ \/ \d+/.test(await txt('#v2-tq-touch')));
        const rows = await tqRows();
        const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
        t('queue "Need you today" has rows', rows.length >= 8, rows.length);
        t('each client appears at most once', new Set(rows.map((r) => r.key)).size === rows.length);
        for (const [k, e] of Object.entries(EXPECT).filter(([, e]) => e.list === 'today')) {
          const r = byKey[k];
          t(`today: ${k} -> top reason "${e.src}", button "${e.label}"`, r && r.label === e.label, r || 'missing');
        }
        t('red attention row is hot (red dot)', byKey.marcus_vell && byKey.marcus_vell.hot);
        t('AI review on the check-in row: AI chip + verdict + reason + "reply drafted" (Priya)', byKey.priya_n && /^AI/.test(byKey.priya_n.why) && /^AI · (REVIEW|FLAG|OK)Check-in wk \d+ · .+ · .{10,}/.test(byKey.priya_n.why) && /reply drafted/.test(byKey.priya_n.all), byKey.priya_n);
        t('a drafted reply for a NEW check-in is not listed twice', byKey.priya_n && !/AI reply drafted, ready to send/.test(byKey.priya_n.all), byKey.priya_n);
        t('every new check-in row carries an AI verdict', rows.filter((r) => /^(AI · \w+)?Check-in wk/.test(r.why)).every((r) => /^AI · (REVIEW|FLAG|OK)/.test(r.why)), rows.map((r) => r.all.split('\n')[0]));
        t('never queued: onboarding / paused / archived / on-track clients', NEVER_IN_QUEUE.every((k) => !byKey[k]), rows.map((r) => r.key));
        t('inactive 14+ days footer (Owen)', /1 inactive 14\+ days/.test(await txt('#v2-tq-foot')), await txt('#v2-tq-foot'));
        t('"Waiting on client" shows Ravi (sent 5 h ago)', (await visible('#v2-tq-waitsec')) && /Ravi Menon/.test(await txt('#v2-tq-wait')) && /5h \/ 24h/.test(await txt('#v2-tq-wait')), await txt('#v2-tq-wait'));
        t('Nadia (sent 30 h ago, nothing since) is a queue row, not waiting', !/Nadia/.test(await txt('#v2-tq-wait')) && byKey.nadia_k && /Nothing from them 30 h/.test(byKey.nadia_k.why), byKey.nadia_k);
        const wins = await txt('#v2-tq-wins');
        t('"Wins this week" lists the PRs (Priya hip thrust, Kwame deadlift)', (await visible('#v2-tq-winsec')) && /Priya/.test(wins) && /Hip Thrust PR/.test(wins) && /Kwame/.test(wins), wins);
        t('sidebar badges: Today and Check-ins', /^\d+$/.test(await txt('#v2-badge-today')) && /^\d+$/.test(await txt('#v2-badge-checkins')));
        t('coach 7am bell is offered (fake push status)', await visible('#v2-m-bell') && /Alert me at 7am/.test(await txt('#v2-m-bell')), await txt('#v2-m-bell'));
      }, { shot: 'today' });

      await step('Today filters', async () => {
        const n = await ev(`[].map.call(document.querySelectorAll('[data-tqf]'), function (b) { return [b.dataset.tqf, +b.querySelector('.n').textContent]; })`);
        for (const [f, num] of n) {
          await tqFilter(f);
          const pressed = await ev(`document.querySelector('[data-tqf="${f}"]').getAttribute('aria-pressed')`);
          const rows = await tqRows();
          t(`filter "${f}": pressed, title set, ${f === 'ok' ? 'on-track empty state' : 'row count = card count (' + num + ')'}`,
            pressed === 'true' && (f === 'ok' ? /clients on track/.test(await txt('#v2-tq-list')) && num >= 1 : rows.length === num), { f, num, rows: rows.length, title: await txt('#v2-tq-title') });
          if (f === 'checkin') t('filter "checkin" holds Priya, Isla, Tomasz', ['priya_n', 'isla_b', 'tomasz_b'].every((k) => rows.some((r) => r.key === k)), rows.map((r) => r.key));
          if (f === 'week') {
            t('filter "week" holds Amara (Apple Health short sleep) and Ravi (Apple Health sync stopped)', rows.some((r) => r.key === 'amara_d' && /Sleeping 5h \d\d avg the last 3 nights/.test(r.why)) && rows.some((r) => r.key === 'ravi_m' && /Apple Health/.test(r.why)), rows);
            const tip = await ev(`document.querySelector('.v2-tq-row[data-tqk="amara_d"] .v2-tq-why').getAttribute('title')`);
            t('Amara also carries "steps down" and "gone quiet" (+2)', /Steps down 5\d% this week \(4,000\/day\)/.test(tip) && /Gone quiet/.test(tip), tip);
          }
          await shot('today_filter_' + f);
        }
        await tqFilter('today');
      });

      // main button per source
      const opens = {
        'review-modal': async (k) => (await ev(`document.getElementById('cc-review-modal').classList.contains('open')`)) && new RegExp(FX.roster.find((c) => c.storageKey === k).displayName).test(await txt('#cc-review-title')),
        'checkin-review': async (k) => (await ev(`location.hash`)).startsWith('#/check-ins/' + k + '/') && (await visible('#v2-ci-panel')) && (await exists('#v2-ci-panel .v2-ci-shell')),
        client: async (k) => (await ev(`location.hash`)) === '#/clients/' + k && (await exists(`#v2-cl-detail .v2-cd[data-key="${k}"]`)),
        code: async (k) => { await idle(400); const box = await txt('#v2-tq-panel .v2-tq-codebox'); const msg = await ev(`(document.querySelector('#v2-tq-panel textarea') || {}).value || ''`);
          return (await visible('#v2-tq-panel')) && /KWAME20/.test(box) && /Phase 2 \(Build\)/.test(msg) && /enter code: KWAME20/.test(msg) && (await exists('#v2-tq-panel [data-tqc="copy"]')); },
        recovery: async (k) => { const p = await txt('#v2-tq-panel'); const msg = await ev(`(document.querySelector('#v2-tq-panel textarea') || {}).value || ''`);
          return (await visible('#v2-tq-panel')) && /Zara Kim/.test(p) && /65 bpm vs their usual 57 \(\+8\)/.test(p) && /lighter week/.test(msg) && !/sick|ill|virus|heart rate/i.test(msg); },
        offer: async (k) => (await visible('#v2-tq-panel')) && /Sofia/.test(await txt('#v2-tq-panel')) && /call/i.test(await ev(`document.querySelector('#v2-tq-panel textarea').value`))
          && (await ev(`!!document.querySelector('#v2-tq-panel [data-tqo="client"], #v2-tq-panel [data-tqsend]')`)),
        journey: async (k) => (await visible('#v2-tq-panel')) && /Jonah Reyes/.test(await txt('#v2-tq-panel')) && /two weeks left/.test(await ev(`document.querySelector('#v2-tq-panel textarea').value`)),
      };
      for (const [k, e] of Object.entries(EXPECT).filter(([, e]) => e.list === 'today')) {
        await step(`Today main button: ${e.src} (${k})`, async () => {
          await backToToday();
          await click(`[data-tqgo="${k}"]`); await idle(500);
          const okOpen = await opens[e.opens](k);
          const where = { hash: await ev('location.hash'), reviewModal: await ev(`document.getElementById('cc-review-modal').classList.contains('open')`), ciPanel: await visible('#v2-ci-panel') };
          if (e.opens === 'checkin-review') knownBug(`"${e.label}" on a ${e.src} row opens the check-in review (#/check-ins/${k}/<iso>)`, okOpen, where);
          else t(`"${e.label}" opens the ${e.opens.replace('-', ' ')}`, okOpen, where);
          if (e.opens === 'code') {
            await shot('today_code_panel');
            await click('#v2-tq-panel [data-tqc="code"]'); await idle(150);
            t('Copy code puts just the code on the clipboard', (await ev(`__ui.copied[__ui.copied.length - 1]`)) === 'KWAME20', await ev(`__ui.copied.slice(-1)`));
          }
          if (e.opens === 'journey' || e.opens === 'offer' || e.opens === 'code' || e.opens === 'recovery') { await click('#v2-tq-panel [data-tqclose]'); await idle(150); t('journey panel closes with ✕', !(await visible('#v2-tq-panel'))); }
          if (e.opens === 'review-modal') { await ev(`closeReviewModal(); 1`); t('review modal closes', !(await ev(`document.getElementById('cc-review-modal').classList.contains('open')`))); }
        }, { shot: 'today_open_' + e.src });
      }
      await step('Check-ins filter: every row leads with its check-in and the AI verdict', async () => {
        await backToToday(); await click('[data-tqf="checkin"]'); await idle(200);
        const rows = await tqRows(), owen = rows.find((r) => r.key === 'owen_c');
        t('Owen (also flagged for something else) shows his check-in + AI verdict here', owen && /^AI · (REVIEW|FLAG|OK)Check-in wk/.test(owen.why), owen);
        t('the Check-ins button opens the check-in review', owen && /Review/.test(owen.label));
        await click('[data-tqf="today"]'); await idle(150);
      });
      await step('Check-in review: Apple Health week + why the scale is not moving (Marcus, cut)', async () => {
        await backToToday();
        await ev(`(function () { var l = _checkInsForClient(_dashboardData.marcus_vell); window.openCheckInReview('marcus_vell', l[0].timestamp); return 1; })()`); await idle(700);
        const h = await txt('.cc-ci-health');
        t('health block: steps, sleep, active kcal, resting HR for the week before the check-in', /Apple Health/.test(await txt('#v2-ci-panel .sec-health h3')) && /3,800/.test(h) && /5h 40/.test(h) && /65 bpm/.test(h), h);
        t('steps drop called out with the size of the drop', /Steps down 64% on the week before \(3,800\/day vs 10,500\)/.test(h), h);
        t('"Likely why the scale isn’t moving": steps fell + kcal estimate, and short sleep', /Likely why/.test(h) && /Steps fell to 3,800\/day \(from 10,500\): about \d+ kcal a day less burned/.test(h) && /short sleep raises hunger/.test(h), h);
        t('resting heart rate up on their usual is flagged', /Resting heart rate up 7 bpm/.test(h), h);
        await ev(`closeCheckInReview(); 1`); await idle(300);
        await ev(`(function () { var l = _checkInsForClient(_dashboardData.isla_b); window.openCheckInReview('isla_b', l[0].timestamp); return 1; })()`); await idle(700);
        t('no Apple Health block for a client who is not connected (Isla)', !(await exists('.cc-ci-health')));
        await ev(`closeCheckInReview(); 1`); await idle(300);
      }, { shot: 'checkin_review_health' });
      await step('Step targets + early warning (Zara)', async () => {
        await backToToday();
        const z = (await tqRows()).find((r) => r.key === 'zara_k');
        t('recovery dip row: resting HR +8 (65 vs usual 57), sleep 5h 40, "lighter week?"', z && /Recovery dip: resting HR \+8 bpm \(65 vs usual 57\), sleep 5h 40 · lighter week\?/.test(z.why), z);
        t('...and her under-target steps ride along (6,000/day vs 9,500)', z && /Under step target: 6,000\/day vs 9,500/.test(z.all), z);
        t('recovery dip is "need you today" but not red (an offer, not an alarm)', z && !z.hot);
        await ev(`(function () { var l = _checkInsForClient(_dashboardData.marcus_vell); window.openCheckInReview('marcus_vell', l[0].timestamp); return 1; })()`); await idle(700);
        t('check-in review shows the step target next to the steps', /target 12,000/.test(await txt('.cc-ci-health')));
        await ev(`closeCheckInReview(); 1`); await idle(300);
      });
      await step('AI review flags a check-in: it turns red and jumps above reviews', async () => {
        await backToToday();
        await ev(`(function () { var orig = window._apPriority; window.__apOrig = orig; window._apPriority = function (c, sum, m) { var r = orig(c, sum, m);
          return c.storageKey === 'isla_b' ? Object.assign({}, r, { priority: 'NEEDS_ATTENTION', reason: 'Sleep 4h avg and stress 9/10 this week.' }) : r; };
          UIV2.renderToday(); return 1; })()`); await idle(300);
        const rows = await tqRows(), i = rows.findIndex((r) => r.key === 'isla_b'), pr = rows.findIndex((r) => r.key === 'priya_n');
        t('flagged check-in row: red dot + "AI · FLAG" + the AI reason', i >= 0 && rows[i].hot && /^AI · FLAG/.test(rows[i].why) && /Sleep 4h avg/.test(rows[i].why), rows[i]);
        t('...and it sits above the check-ins the AI only wants reviewed', i >= 0 && pr >= 0 && i < pr, { isla: i, priya: pr });
        await ev(`window._apPriority = window.__apOrig; UIV2.renderToday(); 1`);
      }, { shot: 'today_ai_flag' });
      await step('Offer with no journey draft: a ready Block 2 call message from the client\'s numbers', async () => {
        await backToToday();
        await ev(`Object.keys(CI_DRAFTS).forEach(function (k) { if (CI_DRAFTS[k].client_key === 'sofia_m') delete CI_DRAFTS[k]; }); 1`);
        await click('[data-tqgo="sofia_m"]'); await idle(300);
        const msg = await ev(`(document.querySelector('#v2-tq-panel textarea') || {}).value || ''`);
        t('panel opens with a drafted message (weeks done + 10-min call, no price)', (await visible('#v2-tq-panel')) && /^Hey Sofia, 16 weeks done/.test(msg) && /10-min call/.test(msg) && !/\$/.test(msg), msg);
        t('Copy / Open client page offered', (await count('#v2-tq-panel [data-tqo]')) >= 2);
        await click('#v2-tq-panel [data-tqo="client"]'); await idle(400);
        t('Open client page -> #/clients/sofia_m', (await ev('location.hash')) === '#/clients/sofia_m');
      }, { shot: 'today_offer_generated' });
      await step('Today ••• menu, wins panel, search', async () => {
        await backToToday();
        await click('[data-tqmore="kwame_a"]'); await idle(150);
        t('••• opens a menu with done / snooze / client', (await count('.v2-tq-menu [data-tqm]')) === 3);
        await ev(`document.body.click(); 1`); await idle(100);
        t('clicking elsewhere closes the menu', !(await exists('.v2-tq-menu')));
        await click('[data-tqmore="kwame_a"]'); await idle(100); await click('.v2-tq-menu [data-tqm="client"]'); await idle(400);
        t('••• Open client -> #/clients/kwame_a', (await ev('location.hash')) === '#/clients/kwame_a');
        await backToToday();
        await click('[data-tqwin]'); await idle(200);
        t('a win opens the "nice work" panel with a drafted message', (await visible('#v2-tq-panel')) && /PR/.test(await txt('#v2-tq-panel .sub')) && /proud of you/.test(await ev(`document.querySelector('#v2-tq-panel textarea').value`)));
        await shot('today_win_panel');
        await click('#v2-tq-scrim'); await idle(150);
        t('scrim click closes the panel', !(await visible('#v2-tq-panel')));
        await typeInto('#v2-search', 'pri'); await idle(150);
        t('search "pri" lists Priya', (await visible('#v2-search-results')) && /Priya Nandakumar/.test(await txt('#v2-search-results')));
        await typeInto('#v2-search', 'zzzz'); await idle(100);
        t('search with no hits says so', /No client matches/.test(await txt('#v2-search-results')));
        await typeInto('#v2-search', 'grace'); await idle(100);
        t('search also finds archived clients, labelled archived', /Grace Okafor/.test(await txt('#v2-search-results')) && /archived/.test(await txt('#v2-search-results')));
        await ev(`(function(){ var r = document.querySelector('#v2-search-results .v2-sr-row'); r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return 1; })()`); await idle(400);
        t('picking a search result opens that client', (await ev('location.hash')) === '#/clients/grace_o');
        await backToToday();
        await click('#v2-m-bell'); await idle(300);
        for (let i = 0; i < 20 && !/blocked/i.test(await txt('#v2-m-bell')); i++) await idle(100);   // the permission promise settles asynchronously
        t('bell asks permission only on tap; denied -> no subscribe, no write', (await ev(`__ui.notif.indexOf('requestPermission') >= 0 && __ui.notif.indexOf('subscribe') < 0`)) && /blocked/i.test(await txt('#v2-m-bell')), await ev(`__ui.notif`));
        await ev(`UIV2.toggleCollapse(); 1`); const col1 = await ev(`document.body.classList.contains('v2-collapsed')`);
        await ev(`UIV2.toggleCollapse(); 1`); const col2 = await ev(`document.body.classList.contains('v2-collapsed')`);
        t('sidebar collapse toggles', col1 !== col2);
      });

      await step('Today done / snooze / keyboard', async () => {
        await backToToday(); await blurAll();
        let rows = await tqRows();
        const first = rows[0] && rows[0].key;
        await key('ArrowDown'); await key('ArrowDown'); await key('ArrowUp');
        t('ArrowDown/ArrowUp moves the selection', (await ev(`[].findIndex.call(document.querySelectorAll('.v2-tq-row'), function (r) { return r.classList.contains('sel'); })`)) === 1);
        await key('2'); await idle(150);
        t('key "2" switches to Check-ins & replies', (await ev(`document.querySelector('[data-tqf="checkin"]').getAttribute('aria-pressed')`)) === 'true');
        await key('3'); await key('4'); await key('1'); await idle(150);
        t('key "1" back to Need you today', (await ev(`document.querySelector('[data-tqf="today"]').getAttribute('aria-pressed')`)) === 'true');
        // done via keyboard on the selected row
        await ev(`(function(){ var r = document.querySelector('.v2-tq-row[data-tqk="felix_w"]'); r.click(); return 1; })()`); await idle(100);
        t('clicking a row (not its buttons) selects it', await ev(`document.querySelector('.v2-tq-row[data-tqk="felix_w"]').classList.contains('sel')`));
        await key('d'); await idle(600);
        t('"d" marks the selected row done and removes it', !(await exists('.v2-tq-row[data-tqk="felix_w"]')));
        await click('[data-tqmore="sofia_m"]'); await idle(100); await click('.v2-tq-menu [data-tqm="snooze"]'); await idle(600);
        t('••• Snooze removes the row', !(await exists('.v2-tq-row[data-tqk="sofia_m"]')));
        await click('[data-tqmore="nadia_k"]'); await idle(100); await click('.v2-tq-menu [data-tqm="done"]'); await idle(600);
        t('••• Mark done removes the row', !(await exists('.v2-tq-row[data-tqk="nadia_k"]')));
        await blurAll(); await ev(`(function(){ var r = document.querySelector('.v2-tq-row[data-tqk="kwame_a"]'); r.click(); return 1; })()`);
        await key('s'); await idle(600);
        t('"s" snoozes the selected row', !(await exists('.v2-tq-row[data-tqk="kwame_a"]')));
        t('done / snooze stored in localStorage v2_tq_state_v1', await ev(`(function(){ var s = JSON.parse(localStorage.getItem('v2_tq_state_v1') || '{}'); return !!(s.felix_w && s.felix_w.done && s.sofia_m && s.sofia_m.until && s.nadia_k && s.kwame_a); })()`));
        t('done / snooze also saved on the client in the synced roster (todayState) and pushed (rosterPut)',
          await ev(`(function(){ var l = JSON.parse(localStorage.getItem(LS_CLIENTS) || '[]'); var g = function (k) { return (l.find(function (c) { return c.storageKey === k; }) || {}).todayState; };
            return !!(g('felix_w') && g('felix_w').done && g('sofia_m') && g('sofia_m').until && g('nadia_k') && g('kwame_a')); })()`)
          && (await ev(`__ui.calls.filter(function (c) { return c.type === 'rosterPut'; }).length`)) >= 4);
        // Enter opens the selected row's flow
        await blurAll(); await ev(`(function(){ var r = document.querySelector('.v2-tq-row[data-tqk="marcus_vell"]'); r.click(); return 1; })()`);
        await key('Enter'); await idle(300);
        t('Enter opens the selected row (Marcus -> review modal)', await ev(`document.getElementById('cc-review-modal').classList.contains('open')`));
        await ev(`closeReviewModal(); 1`);
        rows = await tqRows();
        t('keyboard triage left the other rows in place', rows.length >= 4 && rows[0].key !== undefined, { first, now: rows.map((r) => r.key) });
      }, { writes: ['rosterPut'] });
      await step('Today state survives a reload', async () => {
        await boot('#/today');      // no ?fresh -> localStorage kept
        await go('#/clients', 200); await go('#/today', 500);
        const keys = (await tqRows()).map((r) => r.key);
        t('done + snoozed rows stay hidden after reload', !['felix_w', 'sofia_m', 'nadia_k', 'kwame_a'].some((k) => keys.includes(k)) && keys.includes('marcus_vell'), keys);
        // another device: no local done/snooze copy; it loads the roster from the (fake) cloud
        await ev(`localStorage.removeItem('v2_tq_state_v1'); 1`); await boot('?device=2#/today'); await go('#/clients', 200); await go('#/today', 600);
        const other = (await tqRows()).map((r) => r.key);
        t('another device (no local copy) still hides them: the synced roster carries done / snooze', !['felix_w', 'sofia_m', 'nadia_k', 'kwame_a'].some((k) => other.includes(k)), other);
        await ev(`(function(){ var l = loadClients(); l.forEach(function (c) { delete c.todayState; }); localStorage.setItem(LS_CLIENTS, JSON.stringify(l)); COACH.clients = l;
          var cl = JSON.parse(localStorage.getItem('__fx_cloud') || 'null'); if (cl) { cl.roster.forEach(function (c) { delete c.todayState; }); localStorage.setItem('__fx_cloud', JSON.stringify(cl)); } return 1; })()`);
        await go('#/clients'); await go('#/today', 600);
        const back = (await tqRows()).map((r) => r.key);
        t('clearing the state brings them back', ['felix_w', 'sofia_m', 'nadia_k', 'kwame_a'].every((k) => back.includes(k)), back);
      });

      // ── ACTIVITY ──
      await step('Activity', async () => {
        await go('#/activity', 500);
        t('Activity page is the active page', await ev(`document.getElementById('v2-page-activity').classList.contains('active')`));
        t('sidebar Activity link is current', await ev(`document.querySelector('.v2-nav[data-route="activity"]').classList.contains('active')`));
        const n = await count('#v2-activity .v2-row');
        t('feed has rows', n >= 10, n);
        const feed = await txt('#v2-activity');
        t('feed has lifts, meals, weigh-ins and a PR', /Lift/.test(feed) && /Meal/.test(feed) && /Weigh-in/.test(feed) && /PR/.test(feed));
        t('#v2-act-sub counts events', /\d+ in the last 24 h/.test(await txt('#v2-act-sub')));
        knownBug('meal rows show the meal name (no "undefined")', !/undefined/.test(feed), feed.split('\n').filter((l) => /undefined/.test(l)).slice(0, 2));
        await click('#v2-activity .v2-row[data-act="open"]'); await idle(400);
        t('tapping a feed row opens that client', /^#\/clients\/[a-z_]+$/.test(await ev('location.hash')));
      }, { shot: 'activity' });

      // ── CLIENTS list ──
      await step('Clients', async () => {
        await go('#/clients', 500);
        const n = await count('#v2-cl-rows .v2-cl-row[data-key]');
        const current = FX.roster.filter((c) => c.programStatus !== 'archived').length;
        t(`roster shows ${current} current clients (archived hidden)`, n === current, n);
        t('subtitle counts lifecycle groups', /current · 1 onboarding · 1 paused · 1 archived/.test(await txt('#v2-cl-sub')), await txt('#v2-cl-sub'));
        t('rows carry weight, check-in and review cells', /kg/.test(await txt('#v2-cl-rows')) && (await count('#v2-cl-rows .c-ci')) === n);
        t('attention reason shown on Action rows ("Next: …")', (await count('#v2-cl-rows .c-why')) >= 1);
        const sel = async (id, v) => { await ev(`(function(){ var s = document.getElementById(${J(id)}); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await idle(150); };
        const keys = () => ev(`[].map.call(document.querySelectorAll('#v2-cl-rows .v2-cl-row[data-key]'), function (r) { return r.dataset.key; })`);
        await sel('v2-cl-status', 'all'); t('Status: All shows every client', (await keys()).length === FX.roster.length);
        await sel('v2-cl-status', 'lc_archived'); t('Status: Archived -> Grace', J(await keys()) === J(['grace_o']), await keys());
        await sel('v2-cl-status', 'lc_paused'); t('Status: Paused -> Diego', J(await keys()) === J(['diego_f']), await keys());
        await sel('v2-cl-status', 'lc_onboarding'); t('Status: Onboarding -> Hana', J(await keys()) === J(['hana_s']), await keys());
        await sel('v2-cl-status', 'lc_current');
        await sel('v2-cl-attn', 'attention'); t('Attention: Needs attention includes Marcus', (await keys()).includes('marcus_vell'), await keys());
        await sel('v2-cl-attn', 'checkin_overdue'); t('Attention: Check-in overdue includes Leila', (await keys()).includes('leila_h'), await keys());
        await sel('v2-cl-attn', '');
        await sel('v2-cl-sort', 'name');
        const names = await ev(`[].map.call(document.querySelectorAll('#v2-cl-rows .c-name b'), function (b) { return b.textContent; })`);
        t('Sort: Name is alphabetical', J(names) === J(names.slice().sort((a, b) => a.localeCompare(b))), names);
        await sel('v2-cl-sort', 'attention');
        await typeInto('#v2-cl-search', 'marcus'); await idle(150);
        t('search "marcus" -> Marcus only', J(await keys()) === J(['marcus_vell']), await keys());
        await typeInto('#v2-cl-search', 'glute'); await idle(150);
        t('search matches programme type too', (await keys()).includes('priya_n'));
        await typeInto('#v2-cl-search', ''); await idle(150);
        await click('#v2-cl-rows [data-menu="priya_n"]'); await idle(150);
        t('row ⋮ menu opens with review / open / edit / sms / whatsapp', !(await ev(`document.getElementById('v2-cl-menu').hidden`)) && (await count('#v2-cl-menu [data-mact]')) >= 5);
        await shot('clients_menu');
        await ev(`document.body.click(); 1`); await idle(100);
        t('menu closes on outside click', await ev(`document.getElementById('v2-cl-menu').hidden`));
        await click('#v2-cl-rows .v2-cl-row[data-key="ben_t"] .c-name'); await idle(400);
        t('clicking a row opens the client page', (await ev('location.hash')) === '#/clients/ben_t');
        await go('#/clients');
      }, { shot: 'clients' });

      // ── CLIENT DETAIL: overview of every client, every tab of the rich ones ──
      await step('Client detail: overview for every client', async () => {
        for (const cl of FX.roster) {
          await go('#/clients/' + cl.storageKey, 350);
          const ok = await ev(`(function(){ var d = document.querySelector('#v2-cl-detail .v2-cd[data-key="${cl.storageKey}"]'); return !!d && !document.getElementById('v2-cl-detail').hidden &&
            d.querySelector('h1').textContent === ${J(cl.displayName)} && d.querySelector('.v2-cd-body').innerText.trim().length > 40; })()`);
          t(`${cl.storageKey}: overview renders (name, chips, stats, body)`, ok);
        }
      }, { shot: 'client_overview' });
      const TABS = ['overview', 'progress', 'nutrition', 'training', 'checkins', 'account', 'history'];
      for (const k of ['priya_n', 'kwame_a', 'hana_s', 'grace_o']) {
        for (const tab of TABS) {
          await step(`Client ${k} / ${tab}`, async () => {
            await go(`#/clients/${k}${tab === 'overview' ? '' : '/' + tab}`, 600);
            t('tab active + body non-empty', await ev(`(function(){ var d = document.querySelector('#v2-cl-detail .v2-cd[data-key="${k}"]'); var a = d && d.querySelector('.v2-cd-tab.active');
              return !!a && a.getAttribute('href').indexOf(${J(tab === 'overview' ? '' : '/' + tab)}) >= 0 && d.querySelector('.v2-cd-body').innerText.trim().length > 20; })()`));
            const body = await ev(`(document.querySelector('#v2-cl-detail .v2-cd-body') || {}).textContent || ''`);
            if (tab === 'progress') {
              const hc = await txt(`[data-health-key="${k}"]`);
              if (k === 'kwame_a') {
                t('weight chart built (Chart stub instance with data)', await ev(`!!(window.Chart && Chart.__instances.length && Chart.__instances[Chart.__instances.length - 1].data.datasets[0].data.length > 3)`));
                t('Apple Health card: averages, 14-day bars, sleep line, devices', /Steps \/ day/.test(hc) && /Resting HR/.test(hc) && /asleep/.test(hc) && /Apple Watch/.test(hc), hc);
              }
              if (k === 'hana_s') t('Apple Health card: pending link', /waiting for the client/.test(hc), hc);
              if (k === 'grace_o') t('Apple Health card: not connected + create link button', /Not connected/.test(hc) && /Create Apple Health link/.test(hc), hc);
              if (k === 'priya_n') t('progress photos loaded from photosGet', (await count(`#v2-cl-detail img[src*="__fixture/photo.svg"]`)) >= 1, await txt('#v2-cl-detail .v2-cd-body'));
            }
            if (tab === 'training' && k === 'priya_n') {
              t('workout completions card (coachWorkoutCompletions)', /Latest:/.test(await txt('#cwv-card')) && /undone by the client/.test(await txt('#cwv-card')), await txt('#cwv-card'));
              t('personal records + substitution shown', /Hip Thrust/.test(body) && /Bulgarian Split Squat/.test(body), body.slice(0, 900));
            }
            if (tab === 'checkins' && k === 'priya_n') t('check-in comparison + "Open latest check-in"', /Open latest check-in/.test(body));
            if (tab === 'account') t('account tab shows contact + lifecycle', /Lifecycle/.test(body) && /Email/.test(body));
          }, { shot: `client_${k}_${tab}` });
        }
      }
      await step('Client detail: Ravi Apple Health sync stopped', async () => {
        await go('#/clients/ravi_m/progress', 600);
        t('Apple Health card warns "Sync stopped" + shows Garmin', /Sync stopped/.test(await txt('[data-health-key="ravi_m"]')) && /Garmin/.test(await txt('[data-health-key="ravi_m"]')), await txt('[data-health-key="ravi_m"]'));
      });
      await step('Client detail: interactions', async () => {
        await go('#/clients/priya_n', 500);
        await ev(`document.querySelector('#v2-cl-detail .cd3-more-btn').click(); 1`); await idle(100);
        t('⋮ More menu opens', await ev(`(function(){ var m = document.querySelector('#v2-cl-detail .cd3-more-menu'); return !!m && getComputedStyle(m).display !== 'none'; })()`));
        await ev(`_cd3CloseMoreMenus(); 1`);
        await ev(`[].filter.call(document.querySelectorAll('#v2-cl-detail .v2-cd-actions .v2-btn'), function (b) { return /Draft response/.test(b.textContent); })[0].click(); 1`); await idle(200);
        t('Draft response opens the composer with text', (await ev(`document.getElementById('cd3-compose-overlay').classList.contains('open')`)) && (await ev(`document.getElementById('cd3-compose-text').value.length > 20`)));
        await shot('compose');
        await ev(`_cd3CloseCompose(); 1`);
        t('composer closes', !(await ev(`document.getElementById('cd3-compose-overlay').classList.contains('open')`)));
        await go('#/clients/priya_n/training', 500);
        await ev(`(function(){ var d = [].filter.call(document.querySelectorAll('#v2-cl-detail details.cd3-collapsible'), function (x) { return /Auto-progression/.test(x.textContent); })[0]; d.open = true; return 1; })()`); await idle(600);
        t('auto-progression loads program + history (clientProgram, progressionHistory)', /Hip Thrust/.test(await txt('#v2-cl-detail .v2-cd-body')));
        await go('#/clients/priya_n/account', 400);
        await ev(`[].filter.call(document.querySelectorAll('#v2-cl-detail button'), function (b) { return /Open access/.test(b.textContent); })[0].click(); 1`); await idle(600);
        t('"Open access & App login" opens the edit form with account status (accountList)', (await ev(`document.getElementById('client-form-overlay').classList.contains('open')`)) && /Active —|Invite sent|No account yet/.test(await txt('#cf-account-current')), await txt('#cf-account-current'));
        await shot('edit_client_form');
        await ev(`closeClientForm(); 1`);
        await go('#/clients/no_such_client', 300);
        t('unknown client key -> "Client not found"', /Client not found/.test(await txt('#v2-cl-detail')));
        await go('#/clients', 300);
      });
      await step('Add client form', async () => {
        await go('#/clients', 300);
        await click('#v2-cl-list .v2-btn.primary'); await idle(200);
        t('"+ Add client" opens the form in NEW mode', (await ev(`document.getElementById('client-form-overlay').classList.contains('open')`)) && /NEW/.test(await txt('#cf-mode-badge')) && /Add client/.test(await txt('#client-form-title')));
        await typeInto('#cf-name', 'Test Person');
        await ev(`(function(){ var e = document.getElementById('cf-name'); e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await idle(150);
        t('typing a name derives a storage key', /test_person/.test(await ev(`document.getElementById('cf-storage').value`)), await ev(`document.getElementById('cf-storage').value`));
        await shot('add_client_form');
        await ev(`closeClientForm(); 1`); await idle(100);
        t('form closes without saving', !(await ev(`document.getElementById('client-form-overlay').classList.contains('open')`)) && (await ev(`COACH.clients.length`)) === FX.roster.length);
      });

      // ── CHECK-INS ──
      await step('Check-ins', async () => {
        await go('#/check-ins', 500);
        t('subtitle counts new / reviewed / overdue / historical', /\d+ new · \d+ reviewed · \d+ overdue · \d+ historical/.test(await txt('#v2-ci-sub')), await txt('#v2-ci-sub'));
        const rowKeys = () => ev(`[].map.call(document.querySelectorAll('#v2-ci-rows .v2-ci-row'), function (r) { return r.dataset.key || (r.querySelector('.v2-ci-name') || {}).textContent; })`);
        await click('#v2-ci-tabs [data-tab="new"]'); await idle(150);
        let k = await rowKeys();
        t('New: Priya + Isla', k.includes('priya_n') && k.includes('isla_b'), k);
        t('Priya row: "Reply ready" chip', /Reply ready/.test(await txt('#v2-ci-rows .v2-ci-row[data-key="priya_n"]')));
        t('Isla row: sleep / stress flags', /sleep low/.test(await txt('#v2-ci-rows .v2-ci-row[data-key="isla_b"]')) && /stress high/.test(await txt('#v2-ci-rows .v2-ci-row[data-key="isla_b"]')));
        await click('#v2-ci-tabs [data-tab="overdue"]'); await idle(150);
        t('Overdue: Leila', /Leila Haddad/.test(await txt('#v2-ci-rows')), await txt('#v2-ci-rows'));
        await click('#v2-ci-tabs [data-tab="reviewed"]'); await idle(150);
        k = await rowKeys(); t('Reviewed: Tomasz, Ravi (with Reply ready / Replied chips)', k.includes('tomasz_b') && k.includes('ravi_m') && /Replied/.test(await txt('#v2-ci-rows')), k);
        await click('#v2-ci-tabs [data-tab="historical"]'); await idle(150);
        t('Historical: Elena\'s pre-rollout check-in', /Elena Petrova/.test(await txt('#v2-ci-rows')));
        await click('#v2-ci-tabs [data-tab="new"]'); await idle(150);
        await typeInto('#v2-ci-search', 'isla'); await idle(150);
        k = await rowKeys(); t('search filters the queue', J(k) === J(['isla_b']), k);
        await typeInto('#v2-ci-search', ''); await idle(150);
      }, { shot: 'checkins' });
      await step('Check-in review (agent reply)', async () => {
        await click('#v2-ci-rows .v2-ci-row[data-key="priya_n"]'); await idle(500);
        t('review panel open on #/check-ins/priya_n/<iso>', (await visible('#v2-ci-panel')) && (await ev('location.hash')).startsWith('#/check-ins/priya_n/'), await ev(`({ hash: location.hash, hidden: document.getElementById('v2-ci-review').hidden, active: _cc_activeCiKey, shell: !!document.querySelector('#v2-ci-panel .v2-ci-shell'), disp: getComputedStyle(document.getElementById('v2-ci-review')).display, cls: document.body.className })`));
        t('"Suggested reply" with the agent draft', /Suggested reply/.test(await txt('#v2-ci-panel')) && /Greek yoghurt/.test(await ev(`document.querySelector('#v2-ci-panel .v2-rd-text').value`)));
        await click('#v2-ci-panel [data-rd-more]'); await idle(100);
        t('"1 more" reveals the extra coach note', (await count('#v2-ci-panel .v2-rd-extra:not([hidden])')) === 1);
        await typeInto('#cc-ci-note', 'harness note'); await idle(100);
        t('typing a note keeps a local draft (sessionStorage), no server write', await ev(`Object.keys(sessionStorage).some(function (k) { return k.indexOf('v2ci_draft_priya_n|') === 0; })`));
        await shot('checkin_review_reply');
        await click('#v2-ci-panel [data-close]'); await idle(300);
        t('✕ closes the review', !(await visible('#v2-ci-panel')));
      });
      await step('Check-in review: Copy reply marks it sent (write allowed: checkinDraftMark)', async () => {
        await go('#/check-ins/priya_n/' + encodeURIComponent(FX.ciTs.priya), 500);
        await click('#v2-ci-panel [data-rd-copy]'); await idle(400);
        t('Copy puts the edited draft on the clipboard', /Greek yoghurt/.test(await ev(`__ui.copied[__ui.copied.length - 1] || ''`)));
        t('…and records it sent (checkinDraftMark)', /marked sent/.test(await txt('#v2-ci-panel .v2-rd-state')) && (await ev(`__ui.calls.some(function (c) { return c.type === 'checkinDraftMark'; })`)));
        await click('#v2-ci-panel [data-rd-unsend]'); await idle(400);
        t('Undo marks it not sent again', /Marks it sent when you use it/.test(await txt('#v2-ci-panel .v2-rd-state')), await txt('#v2-ci-panel .v2-rd-state'));
        await ev(`history.back(); 1`); await idle(300); await go('#/check-ins', 300);
      }, { writes: ['checkinDraftMark'] });
      await step('Check-in review (autopilot, no draft)', async () => {
        await go('#/check-ins/isla_b/' + encodeURIComponent(FX.ciTs.isla), 500);
        t('autopilot assessment + outcome + next action sections', /Autopilot assessment/.test(await txt('#v2-ci-panel')) && (await exists('#v2-ci-panel #cc-ci-outcome')) && (await exists('#v2-ci-panel #cc-ci-next-action')));
        t('client responses shown', /Exams/.test(await txt('#v2-ci-panel')));
        await click('#v2-ci-panel [data-compose]'); await idle(200);
        t('"Message via WhatsApp / SMS…" opens the composer', await ev(`document.getElementById('cd3-compose-overlay').classList.contains('open')`));
        await ev(`_cd3CloseCompose(); 1`);
        await shot('checkin_review_autopilot');
        await key('Escape'); await idle(300);
        t('Escape closes the review', !(await visible('#v2-ci-panel')));
      });

      // ── ONBOARDING / ADMIN ──
      await step('Onboarding', async () => {
        await go('#/onboarding', 700);
        t('Onboarding page active + nav link inserted', (await ev(`document.getElementById('v2-page-onboarding').classList.contains('active')`)) && (await exists('.v2-nav[data-route="onboarding"].active')));
        t('onboarding clients list Hana', /Hana Sato/.test(await txt('#v2-o-clients')));
        t('strip: unlinked intakes = 2', /2\s*Unlinked intakes|Unlinked intakes\s*2/.test((await txt('#v2-o-strip')).replace(/\n/g, ' ')), await txt('#v2-o-strip'));
        const il = await txt('#v2-o-intakes');
        t('unlinked intakes listed (Mateo, Yara with upload state)', /Mateo Lindqvist/.test(il) && /Yara Haddon/.test(il) && /upload photos_pending/.test(il) && !/Hana Sato/.test(il), il);
        await ev(`(function(){ var b = document.getElementById('v2-o-showlinked'); b.click(); return 1; })()`); await idle(150);
        t('"Show linked" adds the linked intake', /linked · Hana Sato/.test(await txt('#v2-o-intakes')));
        await ev(`document.getElementById('v2-o-showlinked').click(); 1`);
        await click('#v2-page-onboarding [data-o="reload"]'); await idle(400);
        t('Reload intakes refetches (intakeList)', (await ev(`__ui.calls.filter(function (c) { return c.type === 'intakeList'; }).length`)) >= 2);
        t('setup tasks listed', /open/.test(await txt('#v2-o-tasks-sub')));
      }, { shot: 'onboarding' });
      await step('Admin', async () => {
        await go('#/admin', 500);
        const st = await txt('#v2-a-status');
        t('system status: refresh, registry Loaded, roster count', /Last successful refresh/.test(st) && /Loaded/.test(st) && new RegExp(FX.roster.length + ' clients').test(st), st);
        t('this device + access tools rendered', /Dashboard layout/.test(await txt('#v2-a-device')) && /Import link file/.test(await txt('#v2-a-access')));
        await ev(`document.getElementById('v2-a-danger').open = true; 1`); await idle(100);
        t('danger zone opens (reset button present, NOT clicked)', await visible('#v2-a-danger .v2-btn-danger'));
        await ev(`document.getElementById('v2-a-danger').open = false; 1`);
        t('data health section mounted', await exists('#v2-a-dq-slot #cc-dq-details'));
        await ev(`toggleNotifications && 1`);
      }, { shot: 'admin' });
      await step('Sidebar navigation', async () => {
        for (const r of ['today', 'activity', 'clients', 'check-ins', 'onboarding', 'admin']) {
          await click(`.v2-nav[data-route="${r}"]`); await idle(300);
          t(`nav "${r}" -> page + topbar title`, (await ev('location.hash')) === '#/' + r && (await ev(`document.getElementById('v2-page-${r}').classList.contains('active')`)));
        }
        await go('#/no-such-page', 300);
        t('unknown route falls back to Today', (await ev('location.hash')) === '#/today');
      });
    }

    // ═══════════════════════════════ PASS 2: V2 on a phone (390x844) ═══════════════════════════════
    if (!ONLY || ONLY === 'v2' || ONLY === 'phone') {
      await viewport('phone');
      await step('Phone: boot + Today', async () => {
        await boot('?fresh=1#/today');
        t('Today queue renders on a phone', (await count('#v2-tq-list .v2-tq-row')) >= 8);
        t('no horizontal page scroll', await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), await ev(`[document.documentElement.scrollWidth, window.innerWidth]`));
        await ev(`UIV2.openDrawer(); 1`); await idle(150);
        t('drawer opens', await ev(`document.body.classList.contains('v2-drawer-open')`));
        await shot('drawer');
        await click('.v2-nav[data-route="clients"]'); await idle(300);
        t('tapping a nav item closes the drawer', !(await ev(`document.body.classList.contains('v2-drawer-open')`)));
        await go('#/today');
      }, { shot: 'today' });
      for (const [name, hash] of [['activity', '#/activity'], ['clients', '#/clients'], ['client_overview', '#/clients/priya_n'], ['client_progress', '#/clients/kwame_a/progress'],
        ['client_training', '#/clients/priya_n/training'], ['checkins', '#/check-ins'], ['checkin_review', '#/check-ins/priya_n/' + encodeURIComponent(FX.ciTs.priya)],
        ['onboarding', '#/onboarding'], ['admin', '#/admin']]) {
        await step('Phone: ' + name, async () => {
          await go(hash, 600);
          t('page rendered with content', await ev(`(function(){ var p = document.querySelector('.v2-page.active'); return !!p && p.innerText.trim().length > 40; })()`));
          t('no horizontal page scroll', await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), await ev(`[document.documentElement.scrollWidth, window.innerWidth]`));
        }, { shot: name });
        if (name === 'checkin_review') { await key('Escape'); await idle(200); }
      }
      await step('Phone: journey panel', async () => {
        await go('#/today', 400);
        await click('[data-tqgo="jonah_r"]'); await idle(300);
        t('journey panel opens full-width', await visible('#v2-tq-panel'));
        await shot('journey_panel');
        await click('#v2-tq-panel [data-tqclose]');
      });
    }

    // ═══════════════════════════════ PASS 3: classic layout (?ui=classic) ═══════════════════════════════
    if (!ONLY || ONLY === 'classic') {
      await viewport('desktop');
      await step('Classic boot', async () => {
        await boot('?ui=classic&fresh=1');
        t('classic layout: no V2 shell', !(await ev(`document.body.classList.contains('ui-v2')`)) && (await ev(`document.getElementById('v2-shell').hidden`)));
        t('dashboard container visible', await visible('#dashboard'));
        t('choice remembered on this device', (await ev(`localStorage.getItem('coach_ui_layout')`)) === 'classic');
        t('summary row', (await txt('#cc-summary-row') || '').length > 10);
        t('attention list names Marcus', /Marcus Vell/.test(await txt('#cc-attn-list')), (await txt('#cc-attn-list') || '').slice(0, 200));
        t('check-in queue rows', /Priya Nandakumar/.test(await txt('#cc-ci-list')));
        t('compact roster rows', /Ben Thornton/.test(await txt('#cc-roster-body')));
        t('legacy section: client grid + activity feed', (await count('#client-grid > *')) >= 5 && (await ev(`document.getElementById('activity-body').innerHTML.length > 50`)));
        knownBug('classic activity feed: meal rows show the meal name (no "undefined")', !/undefined/.test(await ev(`document.getElementById('activity-body').innerText`)));
      }, { shot: 'classic_home' });
      await step('Classic: client detail tabs', async () => {
        const tabs = await ev(`CD_TABS.map(function (x) { return x.k; })`);
        for (const k of ['priya_n', 'kwame_a', 'hana_s', 'grace_o']) {
          await ev(`openDetail(${J(k)}); 1`); await idle(400);
          t(`${k}: detail overlay opens`, (await ev(`document.getElementById('detail-overlay').classList.contains('open')`)) && (await txt('#detail-panel') || '').length > 50);
          for (const tab of tabs) {
            await ev(`switchDetailTab(${J(k)}, ${J(tab)}); 1`); await idle(450);
            t(`${k}: tab ${tab} renders`, (await txt('#detail-panel') || '').length > 50);
            if (k === 'priya_n') await shot('classic_detail_' + tab);
          }
          await ev(`closeDetail(); 1`); await idle(100);
          t(`${k}: detail closes`, !(await ev(`document.getElementById('detail-overlay').classList.contains('open')`)));
        }
      });
      await step('Classic: check-in review + attention review + client form', async () => {
        await ev(`openCheckInReview('isla_b', ${J(FX.ciTs.isla)}); 1`); await idle(300);
        t('check-in review modal opens with outcome + draft', (await ev(`document.getElementById('cc-ci-modal').classList.contains('open')`)) && (await exists('#cc-ci-outcome')));
        await shot('classic_checkin_review');
        await ev(`closeCheckInReview(); 1`); await idle(100);
        t('check-in review closes', !(await ev(`document.getElementById('cc-ci-modal').classList.contains('open')`)));
        await ev(`openAttentionReview('marcus_vell'); 1`); await idle(200);
        t('attention review modal opens', await ev(`document.getElementById('cc-review-modal').classList.contains('open')`));
        await shot('classic_review_modal');
        await ev(`closeReviewModal(); 1`);
        await ev(`openClientForm(); 1`); await idle(200);
        t('add-client form opens', await ev(`document.getElementById('client-form-overlay').classList.contains('open')`));
        await ev(`closeClientForm(); 1`);
        await ev(`openClientForm('priya_n'); 1`); await idle(500);
        t('edit-client form opens with account status', /Active —|Invite sent|No account yet/.test(await txt('#cf-account-current')), await txt('#cf-account-current'));
        await ev(`closeClientForm(); 1`);
        const ci = await ev(`[].map.call(document.querySelectorAll('#cc-ci-tabs [onclick]'), function (b) { return b.getAttribute('onclick'); })`);
        for (const oc of ci) { await ev(`(function(){ ${oc}; return 1; })()`); await idle(100); }
        t('check-in queue tabs switch', ci.length >= 3, ci);
        await ev(`(function(){ var s = document.getElementById('cc-search'); if (!s) return 0; s.value = 'priya'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`); await idle(200);
        t('roster search filters', /Priya/.test(await txt('#cc-roster-body')) && !/Ben Thornton/.test(await txt('#cc-roster-body')));
      });
      await viewport('phone');
      await step('Classic: phone', async () => {
        await boot('?ui=classic');
        t('classic renders on a phone', (await txt('#cc-attn-list') || '').length > 10);
      }, { shot: 'classic_home' });
    }
  } catch (e) {
    group = 'harness'; t('harness completed', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally {
    close(); srv.close();
  }

  // ─────────────────────────────── summary ───────────────────────────────
  console.log('\nAPI types called per page (all answered by the fake backend):');
  for (const [p, types] of Object.entries(apiByPage)) console.log('  ' + p.padEnd(58) + (types.length ? types.join(', ') : '(none)'));
  if (known.length) {
    console.log('\nKnown issues in the current coach_dashboard.html (not failing the run; --strict makes them fail):');
    for (const k of known) console.log('  - [' + k.group + '] ' + k.name + (k.detail !== undefined ? '  -- ' + JSON.stringify(k.detail).slice(0, 300) : ''));
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length} passed, ${fails.length} failed${known.length ? ', ' + known.length + ' known issue(s)' : ''}`);
  if (fails.length) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - [' + f.group + '] ' + f.name)); }
  if (SHOTS) console.log('screenshots: ' + SHOTS);
  process.exit(fails.length ? 1 : 0);
})();
