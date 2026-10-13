#!/usr/bin/env node
// CLIENT APP REGRESSION SUITE (Omar 2026-10-13)
//
// Opens real client pages in headless Chrome and drives the flows clients use,
// against a FAKE backend (nothing leaves the machine, no real client data is
// read or written). Built from the three bugs clients found in the week of
// 2026-10-08:
//   - a meal swap saved but the card never updated          (swap)
//   - ticks shared between calendar weeks of a locked phase (weeks)
//   - no programme start date, so week 1 began a week early (start)
//
// usage:
//   node tests/client_app/run.js                 pages changed vs origin/main + reference pages
//   node tests/client_app/run.js --all           every client page
//   node tests/client_app/run.js bishoy_shaker zac
// Exit code 1 if any check fails. Needs Google Chrome (CHROME_PATH to override).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { launch, Page } = require('./cdp');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE = ['bishoy_shaker', 'mohamad_taha', 'zain_hussein', 'karim'];
// A page that already exists on origin/main without a start date runs on the date its client's phone recorded;
// changing it would move that client in their programme, so it is reported, not failed. A NEW page (not yet on
// origin/main) must carry a startDate (rule since 2026-10-12, onboarding sets it).
function onMain(key) {
  try { execSync(`git cat-file -e origin/main:clients/${key}/index.html`, { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const NOISE = [/Failed to load resource/i, /net::ERR_/i, /favicon/i, /service ?worker/i, /disabled in test/i];

// ── fake backend + helpers, injected before any page script ─────────────────
const INIT = String.raw`
(function () {
  // optional fake clock: localStorage.__fake_now = ISO time the page should believe it is
  var fakeNow = null; try { fakeNow = localStorage.getItem('__fake_now'); } catch (e) {}
  if (fakeNow) {
    var RD = Date, off = new RD(fakeNow).getTime() - RD.now();
    var FD = function () {
      if (!(this instanceof FD)) return new RD(RD.now() + off).toString();
      return arguments.length ? Reflect.construct(RD, arguments) : new RD(RD.now() + off);
    };
    FD.prototype = RD.prototype; FD.now = function () { return RD.now() + off; }; FD.parse = RD.parse; FD.UTC = RD.UTC;
    window.Date = FD;
  }
  var real = window.fetch.bind(window);
  window.__posts = 0; window.__mealPosts = 0;
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var mode = localStorage.getItem('__mock_mode') || 'ok';
    var body = {}; try { body = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    return new Promise(function (res, rej) { setTimeout(function () {
      if (mode === 'offline') return rej(new TypeError('Failed to fetch'));
      if (o && o.method === 'POST') {
        window.__posts++;
        if (body.type === 'meal') window.__mealPosts++;
        return res(new Response(JSON.stringify({ ok: true, id: window.__posts }), { status: 200 }));
      }
      return res(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }, 120); });
  };
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled in test')); }; } catch (e) {}
  window.__t = {
    wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    cards: function () { return [].slice.call(document.querySelectorAll('#cv2-nutri .cv2-meal:not(.note)')); },
    btn: function (el, re) { return [].slice.call(el.querySelectorAll('button')).find(function (b) { return re.test(b.textContent.trim()); }); },
    week: function () { var b = document.querySelector('#cv2-nutri .cv2-weeknav b'); var m = b && b.textContent.match(/Week (\d+)/); return m ? +m[1] : null; },
    goWeek: async function (w) {
      var g = 0; while (__t.week() !== w && g++ < 30) cv2NutriWeek(__t.week() < w ? 1 : -1);
      cv2NutriDay(0); await __t.wait(120); return __t.week() === w;
    },
    head: function () { var c = document.querySelector('#cv2-nutri .cv2-card'); return c ? c.innerText.replace(/\s+/g, ' ') : ''; },
    ticks: function () { return __t.cards().map(function (c) { return /is-(ate|swap|skip)/.test(c.className) ? 1 : 0; }).join(''); },
  };
})();`;

// ── static server for the repo ───────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (u === '/__blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>blank</title>'); }
    let f = path.join(ROOT, u);
    if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try { if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch (e) {}
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ── page selection ───────────────────────────────────────────────────────────
function allPages() {
  return fs.readdirSync(path.join(ROOT, 'clients')).filter(k => fs.existsSync(path.join(ROOT, 'clients', k, 'index.html'))).sort();
}
function changedPages() {
  let out = '';
  try { out = execSync('git diff --name-only origin/main -- clients; git diff --name-only -- clients; git diff --name-only --cached -- clients', { cwd: ROOT, encoding: 'utf8' }); } catch (e) {}
  return [...new Set(out.split('\n').map(l => (l.match(/^clients\/([^/]+)\/index\.html$/) || [])[1]).filter(Boolean))];
}

// ── checks ───────────────────────────────────────────────────────────────────
async function fresh(page, base, key, seed) {
  await page.goto(base + '/__blank');
  await page.eval(`localStorage.clear(); sessionStorage.clear(); ${seed ? `Object.entries(${JSON.stringify(seed)}).forEach(function (kv) { localStorage.setItem(kv[0], kv[1]); });` : ''} 1`);
  page.errors = [];
  await page.goto(`${base}/clients/${key}/index.html?t=apptest-dummy-token`);
  await page.eval(`(async function () { for (var i = 0; i < 60; i++) { if (document.readyState === 'complete' && typeof showSection === 'function') break; await new Promise(function (r) { setTimeout(r, 100); }); } await new Promise(function (r) { setTimeout(r, 700); }); return 1; })()`);
}

const CHECKS = {
  // the page loads with no script errors and (new design) the Nutrition view lists meals
  async load(page, ctx) {
    if (!(await page.eval(`typeof CLIENT_CONFIG !== 'undefined'`))) { ctx.notApp = true; return 'SKIP not a client app page'; }
    const info = await page.eval(`({ cv2: document.body.classList.contains('cv2'), sw2: typeof sw2Save === 'function', storageKey: CLIENT_CONFIG.client.storageKey,
      start: CLIENT_CONFIG.client.startDate || null, hasNutrition: !!document.getElementById('section-nutrition') })`);
    Object.assign(ctx, info);
    if (info.cv2 && info.hasNutrition) {
      const n = await page.eval(`showSection('nutrition'); __t.cards().length`);
      if (!n) throw new Error('Nutrition view shows no meals');
    }
  },
  // programme start date present (week 1 must not depend on the phone's first-open date)
  async start(page, ctx) {
    if (ctx.start) return;
    if (onMain(ctx.key)) return 'WARN existing page without startDate (runs on the date the phone recorded)';
    throw new Error('no client.startDate - week 1 would start on the Monday of whatever day the phone first opens the page');
  },
  // tick + undo update the card and the day total, and send exactly one save
  async tick(page, ctx) {
    if (!ctx.cv2) return 'SKIP classic layout';
    const r = await page.eval(`(async function () {
      showSection('nutrition'); await __t.wait(100);
      var c = __t.cards()[0], kc = +((c.querySelector('.kc') || {}).textContent || '0').replace(/[^0-9]/g, '');
      window.__mealPosts = 0;
      var b = __t.btn(c, /Ate it/); b.click(); b.click(); await __t.wait(700);
      var after = { tick: __t.ticks()[0], head: __t.head(), posts: window.__mealPosts };
      __t.btn(__t.cards()[0], /^Undo$/).click(); await __t.wait(600);
      return { kc: kc, after: after, undoTick: __t.ticks()[0], undoHead: __t.head(), logs: Object.keys(loadMealLogs()).length };
    })()`);
    if (r.after.tick !== '1') throw new Error('card not marked eaten after Ate it');
    if (!r.after.head.includes(r.kc.toLocaleString('en-AU') + ' of')) throw new Error(`day total does not show the meal's ${r.kc} kcal: ${r.after.head.slice(0, 90)}`);
    if (r.after.posts !== 1) throw new Error(`double tap sent ${r.after.posts} saves (expected 1)`);
    if (r.undoTick !== '0' || r.logs !== 0) throw new Error('undo left the meal logged');
  },
  // swap: card shows the replacement immediately, totals count it once, repeated taps save once, survives reload
  async swap(page, ctx) {
    if (!ctx.cv2) return 'SKIP classic layout';
    const r = await page.eval(`(async function () {
      showSection('nutrition'); await __t.wait(100);
      window.__mealPosts = 0;
      __t.btn(__t.cards()[0], /^Swap$/).click(); await __t.wait(350);
      var fill = function () {
        if (typeof sw2SetMode === 'function') sw2SetMode('full');
        [['sw-desc', 'Apptest wrap'], ['sw-cal', '543'], ['sw-p', '41'], ['sw-c', '52'], ['sw-f', '17']].forEach(function (f) { var el = document.getElementById(f[0]); if (el) el.value = f[1]; });
        if (typeof sw2Input === 'function') sw2Input();
      };
      fill();
      if (typeof sw2Save === 'function') { var lb = document.getElementById('sw2-log'); lb.click(); lb.click(); lb.click(); }
      else { saveSwap(); saveSwap(); saveSwap(); }
      await __t.wait(900);
      var head = document.querySelector('#swapv2-done .sw2-done-head');
      var done = { shown: !!document.getElementById('swapv2-done') && !document.getElementById('swapv2-done').hidden, head: head && head.textContent };
      var go = document.querySelector('#swapv2-done .sw2-btn-go'); if (go && done.shown) go.click(); else if (typeof cancelSwap === 'function') cancelSwap();
      await __t.wait(300);
      var c = __t.cards()[0];
      return { posts: window.__mealPosts, done: done, card: c.innerText.replace(/\\s+/g, ' '), tick: __t.ticks()[0], head: __t.head() };
    })()`);
    if (r.posts !== 1) throw new Error(`3 taps on Log sent ${r.posts} saves (expected 1)`);
    if (r.tick !== '1') throw new Error('swapped card is not marked logged');
    if (!/Apptest wrap/.test(r.card) || !/543/.test(r.card)) throw new Error('card does not show the replacement name and kcal: ' + r.card.slice(0, 120));
    if (!r.head.includes('543 of')) throw new Error('day total does not count the replacement exactly once: ' + r.head.slice(0, 90));
    if (ctx.sw2 && r.done.head !== 'Meal swapped') throw new Error('confirmation should say "Meal swapped" after a confirmed save, got ' + r.done.head);
    await page.reload();
    await page.eval(`(async function () { await __t.wait(900); return 1; })()`);
    const after = await page.eval(`(async function () { showSection('nutrition'); await __t.wait(150); return __t.cards()[0].innerText.replace(/\\s+/g, ' '); })()`);
    if (!/Apptest wrap/.test(after)) throw new Error('swap lost after reload');
  },
  // offline: change kept locally and labelled not synced; retry (several triggers at once) sends exactly once
  async offline(page, ctx) {
    if (!ctx.cv2 || !ctx.sw2) return 'SKIP no Swap V2 sheet';
    const r = await page.eval(`(async function () {
      showSection('nutrition'); await __t.wait(100);
      var c = __t.cards()[0]; var u = __t.btn(c, /^Undo$/); if (u) { u.click(); await __t.wait(500); }
      localStorage.setItem('__mock_mode', 'offline');
      __t.btn(__t.cards()[0], /^Swap$/).click(); await __t.wait(350);
      sw2SetMode('full');
      [['sw-desc', 'Offline wrap'], ['sw-cal', '500'], ['sw-p', '40'], ['sw-c', '50'], ['sw-f', '15']].forEach(function (f) { document.getElementById(f[0]).value = f[1]; });
      sw2Input(); document.getElementById('sw2-log').click(); await __t.wait(900);
      var head = (document.querySelector('#swapv2-done .sw2-done-head') || {}).textContent;
      var go = document.querySelector('#swapv2-done .sw2-btn-go'); if (go) go.click(); await __t.wait(300);
      var off = { head: head, card: __t.cards()[0].innerText.replace(/\\s+/g, ' '), synced: Object.values(loadMealLogs())[0].synced };
      localStorage.setItem('__mock_mode', 'ok'); window.__mealPosts = 0;
      if (typeof cv2Retry === 'function') { cv2Retry(); cv2Retry(); }
      retryUnsyncedMeals(); retryUnsyncedMeals();
      await __t.wait(2500);
      return { off: off, posts: window.__mealPosts, synced: Object.values(loadMealLogs())[0].synced };
    })()`);
    if (r.off.head !== 'Saved on this phone') throw new Error('offline save must not claim it was synced; heading was ' + r.off.head);
    if (!/Not synced yet/.test(r.off.card)) throw new Error('card does not show "Not synced yet" while offline');
    if (r.off.synced !== false) throw new Error('offline entry not queued (synced should be false)');
    if (r.posts !== 1) throw new Error(`retry sent ${r.posts} saves for one queued meal (expected 1)`);
    if (r.synced !== true) throw new Error('entry not marked synced after a successful retry');
  },
  // a calendar week in a locked phase keeps its own ticks (no bleed to/from other weeks)
  async weeks(page, ctx, base) {
    if (!ctx.cv2) return 'SKIP classic layout';
    const keys = await page.eval(`({ start: LS_KEYS.start, unlocked: LS_KEYS.unlocked })`);
    // phase 1 only, and "today" 10 days into the programme so no phase timer has unlocked the next one
    const seed = { [keys.unlocked]: '[1]' };
    if (ctx.start) seed.__fake_now = new Date(Date.parse(ctx.start + 'T12:00:00+10:00') + 10 * 864e5).toISOString();
    else seed[keys.start] = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
    await fresh(page, base, ctx.key, seed);
    const r = await page.eval(`(async function () {
      showSection('nutrition'); await __t.wait(100);
      var w = 0; for (var i = 2; i <= 12; i++) { if ((getPhaseForWeek(i) || 1) > 1) { w = i; break; } }
      if (!w) return { skip: 'no locked phase in this programme' };
      var logs = {}; (getMealDay(w - 1, 0) || []).forEach(function (m, i) { if (m.cal > 0) logs['w' + (w - 1) + '.d0.m' + i] = { week: w - 1, dayIdx: 0, mealIdx: i, mealName: m.name, status: 'ate', cal: m.cal, p: m.p, c: m.c, f: m.f, ts: '2026-01-05T01:00:00.000Z', synced: true }; });
      saveMealLogLocal(logs);
      var out = { w: w };
      await __t.goWeek(w); out.open = __t.ticks();
      var b = __t.btn(__t.cards()[0], /Ate it/); if (!b) return Object.assign(out, { err: 'week ' + w + ' opened with its first meal already logged' });
      b.click(); await __t.wait(600); out.afterTick = __t.ticks();
      if (w < 12) { await __t.goWeek(w + 1); out.next = __t.ticks(); }
      await __t.goWeek(w - 1); out.prev = __t.ticks();
      await __t.goWeek(w); __t.btn(__t.cards()[0], /^Undo$/).click(); await __t.wait(600);
      await __t.goWeek(w - 1); out.prevAfterUndo = __t.ticks();
      return out;
    })()`);
    if (r.skip) return 'SKIP ' + r.skip;
    if (r.err) throw new Error(r.err + ' (ticks from week ' + (r.w - 1) + ' bled into it)');
    const allOn = s => /^1+$/.test(s), zeros = s => /^0+$/.test(s);
    if (!zeros(r.open)) throw new Error(`week ${r.w} opened with week ${r.w - 1}'s ticks (${r.open})`);
    if (!/^10*$/.test(r.afterTick)) throw new Error(`ticking one meal in week ${r.w} showed ${r.afterTick}`);
    if (r.next != null && !zeros(r.next)) throw new Error(`a tick in week ${r.w} also showed in week ${r.w + 1} (${r.next})`);
    if (!allOn(r.prev)) throw new Error(`week ${r.w - 1}'s ticks changed (${r.prev})`);
    if (!allOn(r.prevAfterUndo)) throw new Error(`undo in week ${r.w} removed week ${r.w - 1}'s ticks (${r.prevAfterUndo})`);
  },
};
const ORDER = ['load', 'start', 'tick', 'swap', 'offline', 'weeks'];

async function main() {
  const args = process.argv.slice(2);
  const pages = args.includes('--all') ? allPages()
    : args.filter(a => !a.startsWith('--')).length ? [...new Set(args.filter(a => !a.startsWith('--')))].filter(k => fs.existsSync(path.join(ROOT, 'clients', k, 'index.html')))
    : [...new Set([...changedPages(), ...REFERENCE])].filter(k => fs.existsSync(path.join(ROOT, 'clients', k, 'index.html')));
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch();
  const page = new Page(c); await page.init(); await page.addInit(INIT);
  let fails = 0, warns = 0;
  const t0 = Date.now();
  try {
    for (const key of pages) {
      const ctx = { key }; const line = [];
      for (const name of ORDER) {
        if (name === 'load' || name === 'tick' || name === 'weeks') await fresh(page, base, key);
        let res;
        try { res = await CHECKS[name](page, ctx, base); } catch (e) { res = 'FAIL ' + e.message; }
        const errs = page.errors.filter(e => !NOISE.some(n => n.test(e)));
        if (!res && errs.length) res = 'FAIL script error: ' + errs[0];
        page.errors = [];
        res = res || 'ok';
        if (res.startsWith('FAIL')) fails++; if (res.startsWith('WARN')) warns++;
        line.push([name, res]);
        if (name === 'load' && (res.startsWith('FAIL') || ctx.notApp)) break;
      }
      const bad = line.filter(([, r]) => r !== 'ok' && !r.startsWith('SKIP'));
      console.log((bad.some(([, r]) => r.startsWith('FAIL')) ? 'FAIL ' : 'ok   ') + key.padEnd(22) + line.map(([n, r]) => n + (r === 'ok' ? '' : r.startsWith('SKIP') ? ':skip' : r.startsWith('WARN') ? ':warn' : ':FAIL')).join(' '));
      bad.forEach(([n, r]) => console.log('       ' + n + ': ' + r));
    }
  } finally { close(); srv.close(); }
  console.log(`\n${pages.length} pages, ${fails} failed checks, ${warns} warnings (${Math.round((Date.now() - t0) / 1000)}s)`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
