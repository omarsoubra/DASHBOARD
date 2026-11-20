// SWAP MEAL SHEET (swap-client.js via push-client.js, 2026-11-20) on a REAL client page in headless Chrome, fake backend.
//   Suggested (one tap) · Search (build from foods) · My own · done view · closes clean · old pop-up never shows
// usage: node tests/swap_client.test.js [client_key] [--shots dir]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const KEY = process.argv.slice(2).find((a) => !a.startsWith('--') && !/\//.test(a)) || 'zain_hussein';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

const INIT = String.raw`
(function () {
  var D = 864e5, now = Date.now();
  // 21 days of weigh-ins drifting down ~0.5 kg/week with noise, last one yesterday
  var rows = []; for (var i = 21; i >= 1; i--) rows.push({ timestamp: new Date(now - i * D).toISOString(), weightKg: +(100 + i * 0.07 + ((i % 3) - 1) * 0.4).toFixed(1), notes: 'daily weigh-in' });
  window.__p = { meals: [], calls: [], writes: [], weights: rows, photos: [
    { url: '/brand/lockedin-icon-v1-512.png', urlKind: 'signed', view: 'front', week: null, ts: new Date(now - 60 * D).toISOString(), source: 'intake', label: 'Baseline', baselineWeight: 106 },
    { url: '/brand/lockedin-icon-v1-192.png', urlKind: 'signed', view: 'front', week: 8, ts: new Date(now - 2 * D).toISOString(), source: 'checkin', label: 'Week 8' },
    { url: '/brand/lockedin-icon-v1-180.png', urlKind: 'signed', view: 'side', week: 8, ts: new Date(now - 2 * D).toISOString(), source: 'checkin', label: 'Week 8' },
    { url: 'https://drive.google.com/x', urlKind: 'legacy', view: 'side', week: 2, ts: new Date(now - 40 * D).toISOString(), source: 'checkin', label: 'Week 2' } ] };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    __p.calls.push(b.type); if (/meal/i.test(String(b.type))) __p.meals.push(b);
    var r = { ok: true };
    if (b.type === 'weightLog') r = __p.weights;
    else if (b.type === 'photosGet') r = { ok: true, photos: __p.photos, signedUrlTtlSec: 900 };
    else if (b.type === 'weight') { __p.writes.push(b); __p.weights.push({ timestamp: new Date().toISOString(), weightKg: b.weightKg, notes: b.notes }); r = { ok: true, id: 1 }; }
    else if (b.type === 'healthSelfStatus') r = { ok: true, connected: false, days: [] };
    else if (b.type === 'clientWeekGet') r = { ok: false };
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, 30); });
  };
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled in test')); }; } catch (e) {}
  window.confirm = function () { return true; };
})();`;

function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -- ' + JSON.stringify(d).slice(0, 400) : '')); } };


(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(INIT);
  const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
  const shot = async (name) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); };
  const q = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : null; })()`);
  const nutri = async () => { await page.eval(`(function () { cv2Go('cv2home'); document.querySelector('#cv2-nav [data-id="nutrition"]').click(); })()`); await wait(600); };
  // first meal on the viewed day that is still open; returns its swap index
  const openSwap = () => page.eval(`(function () { var b = [].slice.call(document.querySelectorAll('#cv2-nutri .cv2-meal:not(.is-ate):not(.is-swap):not(.is-skip) button[onclick*="cv2Meal(\\'swap\\'"]'))[0]; if (!b) return null; var i = +String(b.getAttribute('onclick')).match(/(\\d+)\\)/)[1]; b.click(); return i; })()`);
  const tab = (id) => page.eval(`document.querySelector('.lsw-tab[data-tab="${id}"]').click(); 1`);
  const setv = (sel, v) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  try {
    console.log('swap sheet (' + KEY + ')');
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token`);
    await wait(2500);
    t('swap-client.js loaded and took over the page\'s swap', await page.eval(`!!(window.LockedInSwap && LockedInSwap.active())`));
    await nutri();

    // ── Suggested: one tap ──
    const i1 = await openSwap(); await wait(250);
    const st = await page.eval(`({ sheet: !!document.querySelector('#lsw-bd .lsw-sh'), old: document.getElementById('swap-modal-overlay').classList.contains('open'), blur: getComputedStyle(document.getElementById('lsw-bd')).backdropFilter, tabs: [].slice.call(document.querySelectorAll('.lsw-tab')).map(function (b) { return b.textContent; }), on: (document.querySelector('.lsw-tab.on') || {}).textContent, picks: document.querySelectorAll('.lsw-pick').length })`);
    t('Swap opens the new bottom sheet; the old pop-up stays shut', i1 != null && st.sheet && !st.old, st);
    t('no blur behind it', !st.blur || st.blur === 'none', st.blur);
    const ranked = await page.eval(`typeof sw3Rank === 'function'`);
    if (!ranked) {   // older V2 page without the plan ranking: opens on Search, the rest is covered by the pages that have it
      t('page without plan ranking: opens on Search, no Suggested tab', st.tabs.join('|') === 'Search|Eating out|My own' && st.on === 'Search', st);
      await page.eval(`document.querySelector('.lsw-x').click(); 1`);
      const e0 = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
      t('no script errors', e0.length === 0, e0);
      console.log(`\n${pass} passed, ${fail} failed`); close(); srv.close(); process.exit(fail ? 1 : 0);
    }
    t('tabs: Suggested, Search, Eating out, My own; Suggested first', st.tabs.join('|') === 'Suggested|Search|Eating out|My own' && st.on === 'Suggested', st);
    const head = await q('.lsw-hd');
    t('header names the planned meal with its kcal and protein', /Instead of .+ · \d+ kcal · \d+ g protein/.test(head || ''), head);
    const picks = await page.eval(`[].slice.call(document.querySelectorAll('.lsw-pick')).map(function (b) { return b.innerText.replace(/\\n/g, ' | '); })`);
    t('2 to 5 suggestions from the plan, each with kcal, protein and a fit tag', st.picks >= 2 && st.picks <= 5 && picks.every((p) => /\d+ kcal · \d+ g protein/.test(p) && /(Great match|Close|Bigger change)/.test(p)), picks);
    await shot('1_suggested.png');
    const want = await page.eval(`document.querySelector('.lsw-pick b').textContent`);
    await page.eval(`document.querySelector('.lsw-pick').click(); 1`); await wait(500);
    const done = await q('.lsw-done');
    t('one tap logs it: done view with the name, numbers and verdict', /(Meal swapped|Saved on this phone)/.test(done || '') && (done || '').indexOf(want) >= 0 && /\d+ kcal · \d+ g protein/.test(done || ''), done);
    const m1 = await page.eval(`__p.meals.filter(function (b) { return b.status === 'swap' || (b.entry && b.entry.status === 'swap') || /swap/.test(JSON.stringify(b)); }).length`);
    t('the swap went to the backend once', m1 === 1, await page.eval(`__p.meals`));
    const loc = await page.eval(`(function () { var l = loadMealLogs(); var k = Object.keys(l).filter(function (x) { return l[x].status === 'swap'; }); return k.map(function (x) { return l[x]; }); })()`);
    t('saved on the phone as a swap of that meal, with full macros', loc.length === 1 && loc[0].swapDesc === want && loc[0].mealIdx === i1 && loc[0].cal > 0 && loc[0].p > 0 && loc[0].c >= 0 && loc[0].f >= 0, loc);
    await shot('2_done.png');
    await page.eval(`document.querySelector('.lsw-fav').click(); 1`); await wait(100);
    t('Save as favourite works from the done view', /Saved to favourites/.test(await q('.lsw-fav') || ''));
    await page.eval(`document.querySelector('.lsw-donebtn').click(); 1`); await wait(200);
    t('Done closes the sheet; the meal card shows as swapped', await page.eval(`!document.getElementById('lsw-bd') && document.querySelectorAll('#cv2-nutri .cv2-meal.is-swap').length === 1`));

    // ── Search: build from foods ──
    const i2 = await openSwap(); await wait(250);
    await tab('search'); await wait(600);
    await setv('.lsw-q', 'chicken breast'); await wait(700);
    const hits = await page.eval(`[].slice.call(document.querySelectorAll('.lsw-hit b')).map(function (b) { return b.textContent; })`);
    t('Search finds foods from the Log food list', hits.length > 0 && hits.some((h) => /chicken/i.test(h)), hits);
    await shot('3_search.png');
    await page.eval(`document.querySelector('.lsw-hit').click(); 1`); await wait(200);
    await setv('.lsw-amt-in', '200'); await page.eval(`(function () { var s = document.querySelector('.lsw-amt select'); var i = [].slice.call(s.options).findIndex(function (o) { return /^g$|gram/i.test(o.textContent); }); if (i >= 0) { s.value = String(i); s.dispatchEvent(new Event('change')); } })()`); await wait(150);
    const amt = await q('.lsw-bdy');
    t('amount step shows the numbers and a live verdict against the meal', /\d+ kcal · \d+ g protein/.test(amt || '') && /against the planned meal/.test(amt || ''), amt);
    await shot('4_amount.png');
    await page.eval(`document.querySelector('.lsw-add').click(); 1`); await wait(200);
    await setv('.lsw-q', 'rice'); await wait(400);
    await page.eval(`document.querySelector('.lsw-hit').click(); 1`); await wait(200);
    await page.eval(`document.querySelector('.lsw-add').click(); 1`); await wait(200);
    const tot = await q('.lsw-bdy');
    t('two foods added: chips, a running total and the verdict', await page.eval(`document.querySelectorAll('.lsw-chip').length === 2`) && /Total: \d+ kcal/.test(tot || ''), tot);
    await shot('5_built.png');
    await page.eval(`document.querySelector('.lsw-log').click(); 1`); await wait(500);
    const loc2 = await page.eval(`(function () { var l = loadMealLogs(); return Object.keys(l).map(function (x) { return l[x]; }).filter(function (e) { return e.status === 'swap' && e.mealIdx === ${i2}; }); })()`);
    t('Log swap saves the built meal with the summed macros', loc2.length === 1 && / \+ /.test(loc2[0].swapDesc) && loc2[0].cal > 100 && loc2[0].p > 20, loc2);
    await page.eval(`document.querySelector('.lsw-donebtn').click(); 1`); await wait(200);

    // ── My own ──
    const i3 = await openSwap(); await wait(250);
    if (i3 == null) t('a third open meal to test My own', false);
    else {
      await tab('own'); await wait(150);
      t('Log swap is off until there is a name, calories and protein', await page.eval(`document.querySelector('.lsw-log').disabled === true`));
      await setv('#lsw-name', 'Mum\'s lamb and rice'); await setv('#lsw-k', '650'); await setv('#lsw-p', '40'); await wait(100);
      const v = await q('.lsw-v');
      t('verdict updates as numbers go in', /kcal and .* g protein against the planned meal/.test(v || ''), v);
      await shot('6_own.png');
      await page.eval(`document.querySelector('.lsw-log').click(); 1`); await wait(500);
      const loc3 = await page.eval(`(function () { var l = loadMealLogs(); return Object.keys(l).map(function (x) { return l[x]; }).filter(function (e) { return e.status === 'swap' && e.mealIdx === ${i3}; }); })()`);
      t('My own saves the typed name and numbers', loc3.length === 1 && loc3[0].swapDesc === 'Mum\'s lamb and rice' && loc3[0].cal === 650 && loc3[0].p === 40, loc3);
      await page.eval(`document.querySelector('.lsw-donebtn').click(); 1`); await wait(200);
    }
    t('three swaps sent, none twice', await page.eval(`__p.meals.length`) === (i3 == null ? 2 : 3), await page.eval(`__p.meals.length`));

    // ── closing without logging writes nothing ──
    const before = await page.eval(`Object.keys(loadMealLogs()).length`);
    const i4 = await openSwap(); await wait(200);
    if (i4 != null) { await page.eval(`document.querySelector('.lsw-x').click(); 1`); await wait(100);
      t('closing the sheet logs nothing', await page.eval(`!document.getElementById('lsw-bd') && Object.keys(loadMealLogs()).length`) === before); }

    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
    t('no script errors', errs.length === 0, errs);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
