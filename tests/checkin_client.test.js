// WEEKLY CHECK-IN SHEET (checkin-client.js via push-client.js, 2026-11-20) on a REAL client page in headless Chrome, fake backend.
//   opens from Home/Coach/Progress · week filled in · tap answers land in the page's own fields · same saved fields
//   · draft survives a reload · failed send keeps the answers · old long form hidden
// usage: node tests/checkin_client.test.js [client_key] [--shots dir]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const KEY = process.argv.slice(2).find((a) => !a.startsWith('--') && !/\//.test(a)) || 'mohamad_taha';
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
  const q = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : null; })()`);
  const st = () => page.eval(`(function () { var g = function (id) { return document.getElementById(id).value; }; return { w: g('input-weight'), wk: g('input-week'), f: g('input-feeling'), tr: g('input-training'), sl: g('input-sleep'), en: g('input-energy'), ss: g('input-stress'), n: g('input-notes') }; })()`);
  const tap = (id, v) => page.eval(`document.querySelector('.lci-sc[data-scale="${id}"] button[data-v="${v}"]').click(); 1`);
  const click = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const setv = (sel, v) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const vis = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return !!(e && e.offsetParent); })()`);
  try {
    console.log('check-in sheet (' + KEY + ')');
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token`);
    await wait(2500);
    t('checkin-client.js loaded and took over the check-in', await page.eval(`!!(window.LockedInCheckin && LockedInCheckin.active())`));
    const SK = await page.eval(`CLIENT_CONFIG.client.storageKey`);

    // ── Progress page: one card, old form hidden, history still there ──
    await page.eval(`cv2Go('tracker'); 1`); await wait(500);
    t('Progress: long form hidden, one Start check-in button', !(await vis('#input-weight')) && !(await vis('#input-notes')) && !(await vis('#log-btn')) && !(await vis('#photo-btn-front')) && (await q('#lci-open')) === 'Start check-in', [await vis('#input-weight'), await vis('#input-notes'), await vis('#log-btn'), await vis('#photo-btn-front'), await q('#lci-open')]);
    t('Progress: history and status still shown', await vis('#checkin-list') || await page.eval(`!!document.getElementById('checkin-list')`));
    const ord = await page.eval(`(function () { var c = document.getElementById('lci-entry'), t = document.getElementById('cv2-progress-top'); return !!(c && t && (c.compareDocumentPosition(t) & 4)) && c.getBoundingClientRect().top < 500; })()`);
    t('Progress: the check-in is first on the page', ord);
    await shot('01_progress.png');

    // ── open: week filled, weight empty, weigh-in chip ──
    await click('#lci-open'); await wait(250);
    const wkExp = await page.eval(`(function () { var s = (typeof CANONICAL_START !== 'undefined' && CANONICAL_START) || START_DATE; if (!s) return { started: false, src: s }; var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(s)); var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s), t = new Date(); d.setHours(0,0,0,0); t.setHours(0,0,0,0); var tot = CLIENT_CONFIG.client.durationWeeks || 12; return { wk: Math.min(Math.max(Math.floor((t - d) / 6048e5) + 1, 1), tot), tot: tot, started: t - d >= 0 }; })()`);
    const o1 = await page.eval(`({ sheet: !!document.querySelector('#lci-bd .lci-sh'), week: document.getElementById('lci-week').innerText, kg: document.getElementById('lci-kg').value, ph: document.getElementById('lci-kg').placeholder, chip: (document.getElementById('lci-usew') || {}).innerText || '', blur: getComputedStyle(document.getElementById('lci-bd')).backdropFilter, draft: localStorage.getItem(${JSON.stringify(SK)} + '_cv2_checkin_draft') })`);
    t('sheet opens', o1.sheet, o1);
    if (wkExp.started) t('week is filled in from the start date', o1.week.indexOf('Week ' + wkExp.wk + ' of ' + wkExp.tot) === 0 && (await st()).wk === String(wkExp.wk), [o1.week, wkExp]);
    t('weight box is empty, no start weight in it', o1.kg === '' && o1.ph === '0.0', o1);
    t('offers the latest weigh-in', /Use yesterday's weigh-in · \d+\.\d kg/.test(o1.chip), o1.chip);
    t('opening alone saves no draft', o1.draft == null, o1.draft);
    t('no blur behind it', !o1.blur || o1.blur === 'none', o1.blur);
    await shot('02_sheet_top.png');

    // ── send with nothing: inline errors, nothing sent ──
    await click('#lci-send'); await wait(150);
    const e1 = await page.eval(`({ msg: document.getElementById('lci-msg').innerText, errs: [].map.call(document.querySelectorAll('#lci-bd .lci-q.err'), function (e) { return e.getAttribute('data-q'); }), calls: __p.calls.filter(function (c) { return c === 'checkin'; }).length })`);
    t('empty send: three answers flagged, nothing sent', e1.errs.join() === 'weight,feeling,training' && /3 answers still needed/.test(e1.msg) && e1.calls === 0, e1);

    // ── answers land in the page's own fields ──
    await click('#lci-usew'); await tap('input-feeling', 8); await tap('input-training', 9); await tap('input-energy', 7);
    await click('#lci-sleep button[data-sl="0.5"]'); await click('#lci-sleep button[data-sl="0.5"]');
    await setv('#lci-notes', 'Knee felt fine this week');
    const s1 = await st(), lastW = await page.eval(`__p.weights[__p.weights.length - 1].weightKg`);
    t('tap answers write the page\'s own fields', +s1.w === lastW && s1.f === '8' && s1.tr === '9' && s1.en === '7' && s1.sl === '7.5' && s1.ss === '' && s1.n === 'Knee felt fine this week', s1);
    t('errors clear as answers arrive', await page.eval(`document.querySelectorAll('#lci-bd .lci-q.err').length`) === 0);
    await tap('input-energy', 7);
    t('optional scale un-taps; required one does not', (await st()).en === '' && (await (async () => { await tap('input-feeling', 8); return (await st()).f; })()) === '8');
    await tap('input-energy', 7);
    // a picked photo shows in its slot and goes out with the check-in (the page's own upload)
    await page.eval(`(function () { window.__clicked = 0; var c = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__clicked++; return; } return c.apply(this, arguments); }; document.querySelector('.lci-ph button[data-ph="front"]').click(); })()`);
    const pk = await page.eval(`({ clicked: window.__clicked, inp: !!document.getElementById('lci-photo-front'), cap: (document.getElementById('lci-photo-front') || {}).capture || '' })`);
    t('photo slot opens a picker with library + camera (no forced camera)', pk.clicked === 1 && pk.inp && !pk.cap, pk);
    await page.eval(`_photoBase64.front = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; document.getElementById('lci-photo-front').dispatchEvent(new Event('change')); 1`); await wait(500);
    t('picked photo shows in its slot', await page.eval(`document.querySelector('.lci-ph button[data-ph="front"]').classList.contains('has')`));
    await page.eval(`document.querySelector('.lci-bdy').scrollTop = 420; 1`); await shot('03_sheet_mid.png');
    await page.eval(`document.querySelector('.lci-bdy').scrollTop = 99999; 1`); await shot('04_sheet_bottom.png');

    // ── draft survives closing and a reload ──
    await click('.lci-x'); await wait(150);
    t('closed sheet: Progress says Finish check-in', (await q('#lci-open')) === 'Finish check-in', await q('#lci-entry'));
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token`); await wait(2500);
    await page.eval(`scrollToCheckin(); 1`); await wait(250);
    const s2 = await st();
    t('after a reload the Home button opens the sheet with the answers back', await page.eval(`!!document.getElementById('lci-bd')`) && s2.f === '8' && s2.tr === '9' && s2.n === 'Knee felt fine this week' && +s2.w === lastW, s2);
    t('scales show the saved answer', await page.eval(`document.querySelector('.lci-sc[data-scale="input-feeling"] button[aria-pressed="true"]').innerText`) === '8');

    // ── failed send keeps everything ──
    await page.eval(`_photoBase64.front = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; 1`);
    await page.eval(`__p.failCheckin = true; 1`);
    await click('#lci-send'); await wait(1500);
    const f1 = await page.eval(`({ open: !!document.getElementById('lci-bd'), done: !!document.querySelector('.lci-done'), msg: (document.getElementById('lci-msg') || {}).innerText || '', sent: localStorage.getItem(${JSON.stringify(SK)} + '_cv2_checkin_sent') })`), s3 = await st();
    t('failed send: sheet stays, says not sent, answers kept', f1.open && !f1.done && /Not sent/.test(f1.msg) && !f1.sent && s3.f === '8' && s3.tr === '9' && +s3.w === lastW && s3.n === 'Knee felt fine this week', [f1, s3]);
    t('failed send: the photo is still in its slot', await page.eval(`document.querySelector('.lci-ph button[data-ph="front"]').classList.contains('has')`));
    await shot('05_not_sent.png');

    // ── good send: the same fields as before ──
    await page.eval(`__p.failCheckin = false; __p.writes = []; 1`);
    await click('#lci-send'); await wait(1500);
    const g1 = await page.eval(`({ done: (document.querySelector('.lci-done') || {}).innerText || '', w: __p.writes.filter(function (b) { return b.type === 'checkin'; })[0] || null, sent: localStorage.getItem(${JSON.stringify(SK)} + '_cv2_checkin_sent'), draft: localStorage.getItem(${JSON.stringify(SK)} + '_cv2_checkin_draft') })`);
    t('sent: done view with the summary', /Check-in sent/.test(g1.done) && /Meals 8\/10 · Training 9\/10/.test(g1.done), g1.done);
    t('sent: same saved fields (weight, week, meals, training, sleep)', g1.w && g1.w.weightKg === lastW && g1.w.dietAdherence1to10 === 8 && g1.w.trainingAdherence1to10 === 9 && +g1.w.sleepHours === 7.5 && (!wkExp.started || +g1.w.week === wkExp.wk), g1.w);
    t('sent: the photo went up with it', await page.eval(`__p.calls.filter(function (c) { return c === 'photoUpload'; }).length`) >= 1, await page.eval(`__p.calls.slice(-8)`));
    t('sent: marked sent, draft cleared', !!g1.sent && g1.draft == null, g1);
    await shot('06_sent.png');
    await click('#lci-donebtn'); await wait(300);
    t('Done closes; fields are clear for next week', !(await page.eval(`!!document.getElementById('lci-bd')`)) && (await st()).f === '' && (await st()).w === '');

    // ── Coach tab note button + Apple Health sleep ──
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token&lihealth=1`); await wait(2500);
    await page.eval(`__p.health = { ok: true, connected: true, lastSyncAt: new Date().toISOString(), days: [{ sleep_min: 430 }, { sleep_min: 410 }, { sleep_min: 455 }, { sleep_min: 400 }] }; 1`);
    await page.eval(`document.dispatchEvent(new Event('visibilitychange')); 1`); await wait(400);
    await page.eval(`cv2NoteToCoach(); 1`); await wait(400);
    const h1 = await page.eval(`({ open: !!document.getElementById('lci-bd'), focus: (document.activeElement || {}).id, sleep: document.getElementById('lci-sleep').innerText, v: document.getElementById('input-sleep').value })`);
    t('"note to coach" opens the sheet on the notes box', h1.open && h1.focus === 'lci-notes', h1);
    if (await page.eval(`!!(window.LockedInHealth && LockedInHealth.status && LockedInHealth.status() && LockedInHealth.status().connected)`))
      t('sleep comes from Apple Health when connected', h1.v === '7' && /From Apple Health/.test(h1.sleep), h1);
    else console.log('  skip Apple Health sleep (health card not active on this page)');
    await click('.lci-x');

    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
    t('no script errors', errs.length === 0, errs);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
