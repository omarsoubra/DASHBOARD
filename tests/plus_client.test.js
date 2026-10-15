// PLUS (plus-client.js via push-client.js, Omar 2026-10-15) on a REAL client page in headless Chrome (iPhone-sized),
// against a fake backend. Nothing leaves the machine.
//   Home weigh-in: trend + pace + goal date · log today · outlier check · "✓ today"
//   Train: reps pre-filled from last time (in range) · a heavier set -> PR moment · a first-ever exercise -> no PR
//   Progress: photo compare (slider + side by side, view chips) · Nutrition: eating out -> swap form pre-filled
//   no script errors
// usage: node tests/plus_client.test.js [client_key] [--shots dir]
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
  window.__p = { calls: [], writes: [], weights: rows, photos: [
    { url: '/brand/lockedin-icon-v1-512.png', urlKind: 'signed', view: 'front', week: null, ts: new Date(now - 60 * D).toISOString(), source: 'intake', label: 'Baseline', baselineWeight: 106 },
    { url: '/brand/lockedin-icon-v1-192.png', urlKind: 'signed', view: 'front', week: 8, ts: new Date(now - 2 * D).toISOString(), source: 'checkin', label: 'Week 8' },
    { url: '/brand/lockedin-icon-v1-180.png', urlKind: 'signed', view: 'side', week: 8, ts: new Date(now - 2 * D).toISOString(), source: 'checkin', label: 'Week 8' },
    { url: 'https://drive.google.com/x', urlKind: 'legacy', view: 'side', week: 2, ts: new Date(now - 40 * D).toISOString(), source: 'checkin', label: 'Week 2' } ] };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    __p.calls.push(b.type);
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
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -- ' + JSON.stringify(d).slice(0, 400) : '')); } };

(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(INIT);
  const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
  const shot = async (name) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); };
  const q = (sel, prop) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? e.${prop || 'innerText'} : null; })()`);
  const scroll = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (e) e.scrollIntoView({ block: 'center' }); return !!e; })()`);
  try {
    console.log('plus client (' + KEY + ')');
    await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token`);
    await wait(2500);

    // ── weigh-in ──
    const card = await q('#lip-weigh');
    t('Home has a Weigh-in card with the trend in kg', !!card && /Weigh-in/.test(card) && /kg trend/.test(card) && await page.eval(`!!document.querySelector('#cv2-cv2home-page #lip-weigh')`), card);
    t('pace shows as kg / week, going down', /−0\.\d kg \/ week/.test(card || ''), card);
    const goal = await page.eval(`+(CLIENT_CONFIG.client.goalWeight || 0)`);
    t('goal line matches the client\'s goal (' + goal + ' kg vs a ~100.5 kg trend going down)', goal > 25 && goal < 100
      ? (/On pace for \d+\.\d kg around \d{1,2} \w{3}/.test(card || '') || /Heading the right way/.test(card || ''))
      : goal > 100 ? /wrong way/.test(card || '') : !/On pace/.test(card || ''), card);
    t('a trend sparkline is drawn', await page.eval(`document.querySelectorAll('#lip-weigh svg.lip-spark path').length === 1 && document.querySelectorAll('#lip-weigh svg.lip-spark circle').length > 10`));
    await scroll('#lip-weigh'); await wait(200); await shot('1_weigh.png');
    await page.eval(`(function () { var i = document.querySelector('#lip-weigh .lip-in'); i.value = '90'; document.querySelector('#lip-weigh .lip-btn').click(); })()`); await wait(300);
    t('a weight far off the trend asks to confirm and writes nothing', /off your trend/.test(await q('#lip-weigh')) && await page.eval(`__p.writes.length === 0`), await q('#lip-weigh'));
    await page.eval(`(function () { var i = document.querySelector('#lip-weigh .lip-in'); i.value = '99.6'; document.querySelector('#lip-weigh .lip-btn').click(); })()`); await wait(700);
    const w = await page.eval(`__p.writes.slice(-1)[0] || null`);
    t('Log writes through the page\'s own cloudWrite("weight") with the token', !!w && w.weightKg === 99.6 && w.notes === 'daily weigh-in' && !!w.token, w);
    t('the card then says "✓ 99.6 kg today"', /✓ 99\.6 kg today/.test(await q('#lip-weigh')), await q('#lip-weigh'));
    await scroll('#lip-weigh'); await wait(200); await shot('2_weigh_done.png');
    await page.eval(`[].slice.call(document.querySelectorAll('#lip-weigh button')).filter(function (b) { return b.textContent === 'Change'; })[0].click(); 1`); await wait(200);
    t('Change re-opens the field', await page.eval(`!!document.querySelector('#lip-weigh .lip-in')`));
    t('the card survives a Home re-render', await page.eval(`(function () { cv2Go('cv2coach'); cv2Go('cv2home'); return new Promise(function (r) { setTimeout(function () { r(!!document.querySelector('#cv2-cv2home-page #lip-weigh')); }, 400); }); })()`));

    // ── set logging + PR ──
    await page.eval(`cv2Go('training'); tv2Open(0); 1`); await wait(500);
    const ex = await page.eval(`(function () { var n = document.querySelector('#tv2-workout .tv2-exname'); var r = document.querySelector('#tv2-workout .tv2-set.now input[id^="tv2-r"]'); return n && r ? { name: n.textContent.trim(), ph: r.getAttribute('placeholder'), val: r.value } : null; })()`);
    t('Train opens a workout with an active exercise', !!ex && !!ex.name, ex);
    const lo = ex && (String(ex.ph).match(/\d+/) || [])[0];
    t('with no history, reps stay empty (placeholder only)', ex && ex.val === '', ex);
    // seed a finished session of this exercise (under an unused day key) and re-open
    await page.eval(`(function () { var k = CLIENT_CONFIG.client.storageKey + '_workout_sessions'; var st = JSON.parse(localStorage.getItem(k) || '{}');
      var t0 = new Date(Date.now() - 7 * 864e5).toISOString(); var en = {}; en[${JSON.stringify(ex && ex.name)}] = { setLog: [{ w: '60kg', r: '${lo}', ts: t0 }, { w: '60kg', r: '${lo}', ts: t0 }] };
      st['p9.d6'] = [{ sid: 1, startedAt: t0, completedAt: t0, status: 'complete', exs: [], entries: en }]; localStorage.setItem(k, JSON.stringify(st)); tv2Open(0); })()`);
    await wait(500);
    const pre = await page.eval(`(function () { var r = document.querySelector('#tv2-workout .tv2-set.now input[id^="tv2-r"]'); return r ? { v: r.value, cls: r.className } : null; })()`);
    t('reps pre-filled from last time (' + lo + '), shown muted until edited', pre && pre.v === lo && /lip-pre/.test(pre.cls), pre);
    await shot('3_prefill.png');
    await page.eval(`(function () { var w = document.querySelector('#tv2-workout .tv2-set.now input[id^="tv2-w"]'); w.value = '62.5'; document.querySelector('#tv2-workout .tv2-set.now .tv2-log').click(); })()`); await wait(400);
    const pr = await q('.lip-pr');
    t('a heavier set than ever -> "New best · 62.5 kg × ' + lo + '" with what it beat', !!pr && /New best/.test(pr) && /62\.5 kg × /.test(pr) && /Beats 60 kg/.test(pr), pr);
    await shot('4_pr.png');
    await page.eval(`(function () { var p = document.querySelector('.lip-pr'); if (p) p.remove(); var w = document.querySelector('#tv2-workout .tv2-set.now input[id^="tv2-w"]'); if (w) { w.value = '65'; var r = document.querySelector('#tv2-workout .tv2-set.now input[id^="tv2-r"]'); if (!r.value) r.value = '${lo}'; document.querySelector('#tv2-workout .tv2-set.now .tv2-log').click(); } })()`); await wait(400);
    t('only one PR moment per exercise per session', !(await q('.lip-pr')));
    t('the PR set was logged by the page itself (setLog has it)', await page.eval(`(function () { var st = JSON.parse(localStorage.getItem(CLIENT_CONFIG.client.storageKey + '_workout_sessions') || '{}'); return Object.keys(st).some(function (k) { return k !== 'p9.d6' && (st[k] || []).some(function (s) { var e = s.entries && s.entries[${JSON.stringify(ex && ex.name)}]; return e && e.setLog && e.setLog[0] && e.setLog[0].w === '62.5kg'; }); }); })()`));
    t('logic: no history -> no PR; lastReps outside the prescribed range -> blank', await page.eval(`(function () { var T = LockedInPlus._t; return T.priorBest('Never Done Before', 'x', -1, 0) === null && T.lastReps(${JSON.stringify(ex && ex.name)}, 0, '20-25') === '' && T.lastReps(${JSON.stringify(ex && ex.name)}, 0, '30s') === ''; })()`));

    // ── photos ──
    await page.eval(`document.querySelector('#cv2-nav [data-id="tracker"]').click(); 1`); await wait(900);
    const ph = await q('#lip-photos');
    t('Progress has "Then vs now" with Baseline vs Week 8 (front)', !!ph && /Then vs now/.test(ph) && await page.eval(`(function () { var s = document.querySelector('#lip-photos .lip-slide'); return !!s && s.querySelectorAll('img').length === 2 && /Baseline/.test(s.innerText) && /Week 8/.test(s.innerText); })()`), ph);
    t('only views with 2+ usable photos are offered (side has one signed + one legacy -> hidden)', await page.eval(`document.querySelectorAll('#lip-photos .lip-chip').length === 0`));
    t('photosGet was called once Progress opened', await page.eval(`__p.calls.indexOf('photosGet') >= 0`));
    await page.eval(`(function () { var r = document.querySelector('#lip-photos .lip-range'); r.value = '30'; r.dispatchEvent(new Event('input')); })()`);
    t('the slider moves the split', /inset\(0px 70% 0px 0px\)|inset\(0 70% 0 0\)/.test(await page.eval(`getComputedStyle(document.querySelector('#lip-photos .lip-slide .top')).clipPath`)), await page.eval(`getComputedStyle(document.querySelector('#lip-photos .lip-slide .top')).clipPath`));
    await scroll('#lip-photos'); await wait(400); await shot('5_photos_slider.png');
    await page.eval(`document.querySelector('#lip-photos .lip-mode').click(); 1`); await wait(300);
    t('Side by side shows both photos with labels', await page.eval(`document.querySelectorAll('#lip-photos .lip-pair .lip-ph img').length === 2`));
    await scroll('#lip-photos'); await wait(400); await shot('6_photos_pair.png');

    // ── eating out ──
    await page.eval(`document.querySelector('#cv2-nav [data-id="nutrition"]').click(); 1`); await wait(700);
    t('eating out is on hold: no bar on Nutrition by default', await page.eval(`!document.getElementById('lip-eo')`));
    await page.eval(`LockedInPlus._t.eatOut(); 1`); await wait(200);
    t('Nutrition has an "Eating out or travelling?" bar above the meals', await page.eval(`(function () { var b = document.getElementById('lip-eo'); return !!b && !!b.closest('#cv2-nutri') && b.nextElementSibling && b.nextElementSibling.classList.contains('cv2-meal'); })()`));
    await page.eval(`document.getElementById('lip-eo').click(); 1`); await wait(300);
    const s1 = await q('.lip-sh');
    t('the sheet asks which meal (open meals with kcal)', !!s1 && /Which meal/.test(s1) && /kcal/.test(s1), s1);
    await shot('7_eo_meal.png');
    await page.eval(`[].slice.call(document.querySelectorAll('.lip-sh .lip-opt')).slice(-1)[0].click(); 1`); await wait(200);
    await page.eval(`[].slice.call(document.querySelectorAll('.lip-sh .lip-opt')).filter(function (b) { return /Charcoal/.test(b.textContent); })[0].click(); 1`); await wait(200);
    const s2 = await q('.lip-sh');
    t('cuisine picks show kcal, protein and a fit tag against the meal budget', /budget: \d+ kcal/.test(s2) && /~\d+ kcal/.test(s2) && /(Fits|kcal|Treat|Light)/.test(s2), s2);
    await shot('8_eo_picks.png');
    await page.eval(`document.querySelectorAll('.lip-sh .lip-opt')[0].click(); 1`); await wait(900);
    const sw = await page.eval(`({ desc: (document.getElementById('sw-desc') || {}).value, cal: (document.getElementById('sw-cal') || {}).value, p: (document.getElementById('sw-p') || {}).value, vis: !!(document.getElementById('sw-desc') && document.getElementById('sw-desc').offsetParent) })`);
    t('tapping one opens the page\'s Swap form pre-filled (client still taps Log swap)', sw.vis && /\(Charcoal chicken/.test(sw.desc) && +sw.cal > 0 && +sw.p > 0, sw);
    await shot('9_eo_swapform.png');
    await page.eval(`(function () { if (typeof closeSwapModal === 'function') closeSwapModal(); cv2Go('cv2home'); document.querySelector('#cv2-nav [data-id="nutrition"]').click(); LockedInPlus._t.eatOut(); })()`); await wait(600);
    await page.eval(`(function () { document.getElementById('lip-eo').click(); [].slice.call(document.querySelectorAll('.lip-sh .lip-chip')).filter(function (x) { return /Travelling/.test(x.textContent); })[0].click(); })()`); await wait(200);
    t('Travelling tab shows airport / hotel / training-away tips', /Airport/.test(await q('.lip-sh')) && /Training away/.test(await q('.lip-sh')));
    await shot('10_travel.png');
    await page.eval(`document.querySelector('.lip-x').click(); 1`);

    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
    t('no script errors', errs.length === 0, errs);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
