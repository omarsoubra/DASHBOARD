// APPLE HEALTH in-app connect (health-client.js via push-client.js, Omar 2026-10-14) on a REAL client page in headless
// Chrome (iPhone-sized), against a fake backend. Nothing leaves the machine.
//   card on Home · Connect -> agree (both required) -> server connect -> Add to Shortcuts copies the code + opens Apple's
//   link -> finish step -> first sync detected -> "You're synced" -> live metrics card · Manage -> stop + delete ·
//   reminders still mount · no script errors · the code never appears in the page
// usage: node tests/health_inapp.test.js [client_key] [--shots dir]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const KEY = process.argv.slice(2).find((a) => !a.startsWith('--') && !/\//.test(a)) || 'bishoy_shaker';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const CODE = 'lih_' + 'ab12'.repeat(10);

const INIT = String.raw`
(function () {
  window.__h = { connected: false, days: [], lastSyncAt: null, calls: [], opened: null, copied: null, nav: [] };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    __h.calls.push(b.type);
    var r = { ok: true };
    if (b.type === 'healthSelfStatus') r = { ok: true, connected: __h.connected, days: __h.days, lastSyncAt: __h.lastSyncAt, consentVersion: 'health-v1-2026-10-14' };
    else if (b.type === 'healthSelfConnect') r = (b.agree === true && b.version === 'health-v1-2026-10-14') ? (__h.connected = true, { ok: true, healthKey: '${CODE}' }) : { ok: false, error: 'consent_required' };
    else if (b.type === 'healthSelfDisconnect') { __h.connected = false; __h.days = []; r = { ok: true, revoked: true, deleted: 1 }; }
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, 40); });
  };
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled in test')); }; } catch (e) {}
  window.open = function (u) { __h.opened = u; return null; };
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: function (t) { __h.copied = t; return Promise.resolve(); } } }); } catch (e) {}
  window.confirm = function () { return true; };
})();`;

function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + JSON.stringify(d).slice(0, 400) : '')); } };

(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(INIT);
  const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
  const shot = async (name) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); };
  const q = (sel, prop) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? e.${prop || 'innerText'} : null; })()`);
  const click = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  try {
    console.log('apple health in-app (' + KEY + ')');
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token&lihealth=1`);
    await wait(2500);
    const card = await q('#lih-card');
    t('a Connect Apple Health card sits on the Home screen', !!card && /Connect Apple Health/.test(card) && await page.eval(`!!document.querySelector('#cv2-cv2home-page #lih-card')`), card);
    t('reminders still mount next to it', await page.eval(`!!document.querySelector('#li-push-settings') && document.querySelector('#li-push-settings').children.length > 0`));
    await page.eval(`document.getElementById('lih-card').scrollIntoView({ block: 'center' }); 1`); await wait(300);
    await shot('1_home_card.png');
    await click('#lih-card .lih-cta'); await wait(500);
    t('Connect opens the sheet on the agreement step', await page.eval(`document.querySelector('.lih-sheet') && document.querySelector('.lih-sheet').dataset.step === 'consent'`));
    t('agree is disabled until the box is ticked', await page.eval(`document.querySelector('.lih-sheet .lih-cta').hasAttribute('disabled')`));
    await shot('2_consent.png');
    await page.eval(`document.querySelector('.lih-sheet input[type=checkbox]').click(); document.querySelector('.lih-sheet .lih-cta').click(); 1`); await wait(500);
    t('agree -> server connect (agree + version) -> Add step', await page.eval(`__h.calls.indexOf('healthSelfConnect') >= 0 && document.querySelector('.lih-sheet').dataset.step === 'add'`));
    await shot('3_add.png');
    await click('.lih-sheet .lih-cta'); await wait(1300);
    const add = await page.eval(`({ copied: __h.copied, opened: __h.opened, step: document.querySelector('.lih-sheet').dataset.step })`);
    t('Add to Shortcuts copies the private code and opens Apple\'s Add Shortcut link, then shows the finish step',
      add.copied === CODE && /^https:\/\/www\.icloud\.com\/shortcuts\/[0-9a-f]{32}$/.test(add.opened) && add.step === 'finish', add);
    t('the code is never shown in the page', !(await page.eval(`document.body.innerText.indexOf('${CODE}') >= 0 || document.documentElement.outerHTML.indexOf('${CODE}') >= 0`)));
    await shot('4_finish.png');
    await page.eval(`__h.days = [{ day: new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }), steps: 8432, active_kcal: 512, resting_hr: 58, received_at: new Date().toISOString() }];
      __h.lastSyncAt = new Date().toISOString(); document.dispatchEvent(new Event('visibilitychange')); 1`); await wait(800);
    t('first sync detected -> "You\'re synced"', await page.eval(`document.querySelector('.lih-sheet').dataset.step === 'done' && /synced/.test(document.querySelector('.lih-sheet').innerText)`));
    await shot('5_done.png');
    await click('.lih-sheet .lih-cta'); await wait(600);
    const live = await q('#lih-card');
    t('the card goes live: steps, active kcal, resting bpm, synced time', /8,432/.test(live) && /512/.test(live) && /58/.test(live) && /Synced today/.test(live), live);
    t('the code is forgotten on this phone once data arrived', await page.eval(`localStorage.getItem('lih_k_' + CLIENT_CONFIG.client.storageKey) === null`));
    await page.eval(`document.getElementById('lih-card').scrollIntoView({ block: 'center' }); 1`); await wait(300);
    await shot('6_live_card.png');
    await page.eval(`__h.lastSyncAt = new Date(Date.now() - 3 * 864e5).toISOString(); document.dispatchEvent(new Event('visibilitychange')); 1`); await wait(700);
    t('no sync for 3 days -> the card says "sync paused" with Fix it', /sync paused/i.test(await q('#lih-card')) && /Fix it/.test(await q('#lih-card')), await q('#lih-card'));
    await page.eval(`document.getElementById('lih-card').scrollIntoView({ block: 'center' }); 1`); await wait(200);
    await shot('7_paused.png');
    await click('#lih-card .lih-cta'); await wait(500);
    t('Fix it opens the get-syncing-again sheet', await page.eval(`document.querySelector('.lih-sheet').dataset.step === 'fix'`));
    await page.eval(`__h.lastSyncAt = new Date().toISOString(); document.dispatchEvent(new Event('visibilitychange')); 1`); await wait(800);
    t('a fresh sync turns it green ("You\'re synced") and the card goes live again', await page.eval(`document.querySelector('.lih-sheet').dataset.step === 'done'`) && !/paused/i.test(await q('#lih-card')));
    await click('.lih-sheet .lih-cta'); await wait(500);
    await page.eval(`[].slice.call(document.querySelectorAll('#lih-card .lih-link')).filter(function (b) { return /Manage/.test(b.textContent); })[0].click(); 1`); await wait(500);
    await page.eval(`[].slice.call(document.querySelectorAll('.lih-sheet .lih-cta')).filter(function (b) { return /Stop sharing/.test(b.textContent); })[0].click(); 1`); await wait(500);
    t('Manage -> stop sharing: server disconnect, card back to Connect', await page.eval(`__h.calls.indexOf('healthSelfDisconnect') >= 0`) && /Connect Apple Health/.test(await q('#lih-card')));
    t('the card survives a Home re-render', await page.eval(`(function () { cv2Go && cv2Go('cv2coach'); cv2Go && cv2Go('cv2home'); return new Promise(function (r) { setTimeout(function () { r(!!document.querySelector('#cv2-cv2home-page #lih-card')); }, 400); }); })()`));
    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
    t('no script errors', errs.length === 0, errs);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
