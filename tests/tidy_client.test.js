// CLIENT APP TIDY-UPS (tidy-client.js via push-client.js, 2026-11-20) on a REAL client page in headless Chrome, fake backend.
//   ingredients as a list · workout first on Home · empty Progress cards hidden · Notifications in the profile menu
//   · no floating INSTALL APP button · dead-end lines gone · nothing saved or sent by this file
// usage: node tests/tidy_client.test.js [client_key] [--shots dir]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const KEY = process.argv.slice(2).find((a) => !a.startsWith('--') && !/\//.test(a)) || 'mohamad_taha';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

const INIT = String.raw`
(function () {
  var D = 864e5, now = Date.now();
  // 21 days of weigh-ins drifting down ~0.5 kg/week with noise, last one yesterday
  var rows = []; if (!/noweights=1/.test(location.search)) for (var i = 21; i >= 1; i--) rows.push({ timestamp: new Date(now - i * D).toISOString(), weightKg: +(100 + i * 0.07 + ((i % 3) - 1) * 0.4).toFixed(1), notes: 'daily weigh-in' });
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
    else if (b.type === 'checkin') { __p.writes.push(b); r = __p.failCheckin ? { ok: false, error: 'server_error' } : { ok: true, id: 2 }; }
    else if (b.type === 'weight') { __p.writes.push(b); __p.weights.push({ timestamp: new Date().toISOString(), weightKg: b.weightKg, notes: b.notes }); r = { ok: true, id: 1 }; }
    else if (b.type === 'healthSelfStatus') r = __p.health || { ok: true, connected: false, days: [] };
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
  const click = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const vis = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return !!(e && e.offsetParent); })()`);
  try {
    console.log('tidy-ups (' + KEY + ')');
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token`);
    await wait(3000);
    t('tidy-client.js loaded', await page.eval(`!!window.LockedInTidy`));
    const calls0 = await page.eval(`__p.calls.length`);

    // Home: workout first
    const order = await page.eval(`[].map.call(document.getElementById('cv2-cv2home-page').children, function (e) { return e.id || e.className; })`);
    t('Home: greeting then today\'s workout', /cv2-hello/.test(order[0]) && /cv2-hero/.test(order[1]), order);
    const si = order.indexOf('lis-setup');
    if (si >= 0) t('Home: setup card sits under the workout', si > order.findIndex((x) => /cv2-hero/.test(x)), order); else console.log('  skip setup card not shown on this page');
    await page.eval(`window.renderHome && window.renderHome(); 1`); await wait(2600);
    const order2 = await page.eval(`[].map.call(document.getElementById('cv2-cv2home-page').children, function (e) { return e.id || e.className; })`);
    t('Home: order holds after the page re-draws Home', /cv2-hero/.test(order2[1]) && (order2.indexOf('lis-setup') < 0 || order2.indexOf('lis-setup') > 1), order2);
    await shot('tidy_home.png');

    // install button
    await page.eval(`(function () { var e = new Event('beforeinstallprompt'); e.prompt = function () { window.__prompted = (window.__prompted || 0) + 1; }; e.userChoice = new Promise(function () {}); window.dispatchEvent(e); })()`);
    await wait(300);
    t('floating INSTALL APP button is hidden', await page.eval(`[].filter.call(document.body.children, function (k) { return k.tagName === 'BUTTON' && /INSTALL APP/.test(k.textContent) && k.offsetParent; }).length === 0`));
    await page.eval(`cv2More(); 1`); await wait(300);
    t('profile menu has "Install the app"', await page.eval(`!!document.querySelector('#cv2-sheet .cv2-row[data-lit="install"]')`));
    t('profile menu: no "Check-in history" row while there is none', await page.eval(`(function () { var h = document.querySelector('#section-tracker .checkin-history'); var empty = h && /No check-ins yet/.test(h.textContent); var r = [].filter.call(document.querySelectorAll('#cv2-sheet .cv2-row'), function (x) { return /Check-in history/.test(x.textContent); })[0]; return !empty || !r || !r.offsetParent; })()`));
    t('only one install row', await page.eval(`document.querySelectorAll('#cv2-sheet .cv2-row[data-lit="install"]').length === 1`));
    await shot('tidy_menu.png');
    await click('#cv2-sheet .cv2-row[data-lit="install"]'); await wait(200);
    t('tapping it asks the phone to install', await page.eval(`window.__prompted === 1`));

    // notifications
    await page.eval(`cv2Go('tracker'); 1`); await wait(500);
    t('Progress: Notifications no longer at the bottom', !(await vis('#section-tracker #li-push-settings')));
    await page.eval(`cv2More(); 1`); await wait(300);
    const hasBell = await page.eval(`[].some.call(document.querySelectorAll('#cv2-sheet .cv2-row'), function (r) { return /Notifications/.test(r.textContent); })`);
    if (hasBell) {
      await page.eval(`[].filter.call(document.querySelectorAll('#cv2-sheet .cv2-row'), function (r) { return /Notifications/.test(r.textContent); })[0].click(); 1`); await wait(400);
      t('profile menu: Notifications opens in a sheet', await vis('.lit-bd #li-push-settings'));
      t('the menu closed behind it', await page.eval(`!document.getElementById('cv2-sheet').classList.contains('open')`));
      await shot('tidy_notif.png');
      await click('.lit-x'); await wait(300);
      t('Done closes it and puts the settings back', await page.eval(`!document.querySelector('.lit-bd') && !!document.querySelector('#section-tracker #li-push-settings') && document.querySelectorAll('#li-push-settings').length === 1`));
      t('still hidden on Progress', !(await vis('#section-tracker #li-push-settings')));
    } else console.log('  skip no Notifications row on this page (push not supported here)');

    // Progress: dead cards
    const cards = await page.eval(`[].map.call(document.querySelectorAll('#cv2-progress-top .cv2-card'), function (c) { return { t: c.textContent.trim().slice(0, 22), vis: !!c.offsetParent, empty: !!c.querySelector('.cv2-empty') }; })`);
    t('Progress: no visible card is just "nothing yet" (except Body weight)', cards.filter((c) => c.vis && c.empty && !/^Body weight/.test(c.t)).length === 0, cards);
    t('Progress: Body measurements card gone', cards.filter((c) => /^Body measurements/.test(c.t) && c.vis).length === 0, cards);
    t('Progress: cards with real numbers stay', cards.filter((c) => !c.empty).every((c) => c.vis), cards);
    t('Progress: empty check-in history hidden', await page.eval(`(function () { var h = document.querySelector('#section-tracker .checkin-history'); return !h || !/No check-ins yet/.test(h.textContent) || !h.offsetParent; })()`));
    await shot('tidy_progress.png');

    // Nutrition: ingredients
    await click('#cv2-nav [data-id="nutrition"]'); await wait(900);
    const ing = await page.eval(`(function () { var out = []; [].forEach.call(document.querySelectorAll('details.cv2-ing'), function (d) { var p = [].filter.call(d.children, function (c) { return c.tagName === 'P'; })[0]; var ul = d.querySelector('ul.lit-ing'); out.push({ parts: p ? p.textContent.split(' + ').length : 0, li: ul ? ul.children.length : 0, pVis: !!(p && getComputedStyle(p).display !== 'none') }); }); return out; })()`);
    t('Nutrition: meals have ingredients', ing.length > 0, ing.length);
    t('Nutrition: every "+" paragraph became a list, one line per ingredient', ing.filter((x) => x.parts > 1).every((x) => x.li === x.parts && !x.pVis), ing.slice(0, 6));
    t('Nutrition: single-ingredient meals left alone', ing.filter((x) => x.parts <= 1).every((x) => x.li === 0), ing.slice(0, 6));
    t('Nutrition: "another phone" line gone', await page.eval(`[].filter.call(document.querySelectorAll('p'), function (p) { return /tick on another phone/.test(p.textContent) && p.offsetParent; }).length === 0`));
    await page.eval(`(function () { var d = document.querySelector('details.cv2-ing'); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); window.scrollBy(0, -160); } })()`); await wait(300);
    await shot('tidy_ingredients.png');
    await page.eval(`window.renderTracker && 1; window.scrollTo(0, 0); 1`);
    // a tick re-draws the meals: the list must come back
    const ticked = await page.eval(`(function () { var b = [].filter.call(document.querySelectorAll('#section-nutrition button, [id^="cv2-"] button'), function (x) { return x.textContent.trim() === 'Ate it' && x.offsetParent; })[0]; if (!b) return false; b.click(); return true; })()`);
    await wait(900);
    if (ticked) t('Nutrition: list is still there after ticking a meal', await page.eval(`(function () { var bad = 0; [].forEach.call(document.querySelectorAll('details.cv2-ing'), function (d) { var p = [].filter.call(d.children, function (c) { return c.tagName === 'P'; })[0]; if (p && p.textContent.split(' + ').length > 1 && !d.querySelector('ul.lit-ing')) bad++; }); return bad === 0; })()`));

    // Coach copy
    t('Coach tab opens', await click('#cv2-nav [data-id="cv2coach"]')); await wait(700);
    t('Coach: no "messaging isn\'t available yet"', await page.eval(`!/messaging isn.t available yet/.test(document.body.innerText)`));
    t('Coach: still says how to message', await page.eval(`/the way you normally do/.test(document.body.innerText) || !!document.querySelector('a[href*="wa.me"]')`));

    t('tidy-ups sent nothing new to the server', await page.eval(`__p.writes.filter(function (w) { return w.type !== 'mealTick' && !/meal/i.test(w.type); }).length === 0`), await page.eval(`__p.writes.map(function (w) { return w.type; })`));

    // a brand-new client with no weigh-ins: Body weight card points to Home
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token&noweights=1`); await wait(3000);
    await page.eval(`cv2Go('tracker'); 1`); await wait(600);
    const bw = await page.eval(`(function () { var c = [].filter.call(document.querySelectorAll('#cv2-progress-top .cv2-card'), function (c) { return c.textContent.trim().indexOf('Body weight') === 0; })[0]; return c ? { vis: !!c.offsetParent, tx: c.textContent } : null; })()`);
    if (bw && /No weigh-ins yet/.test(bw.tx)) { t('no weigh-ins: Body weight card stays and points to Home', bw.vis && /on Home/.test(bw.tx) && !/check-in below/.test(bw.tx), bw); }
    else console.log('  skip this page already has weights of its own');

    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
    t('no script errors', errs.length === 0, errs);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
