// LOG FOOD (food-client.js via push-client.js, Omar 2026-11-19) on Omar's REAL page in headless Chrome (iPhone-sized),
// against a fake backend. Nothing leaves the machine (Open Food Facts is faked too).
//   Nutrition: "Log food" button under the day's totals · search (everyday + plan + chains) · amount/units · add
//   totals on Nutrition and Home include the logged food · one cloud write per food · offline -> "Not synced yet" -> retry
//   remove · type a label in kJ -> My foods · barcode: real EAN-13 decode (zxing wasm) + lookup · pilot gate · no script errors
// usage: node tests/food_client.test.js [--shots dir]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

const INIT = String.raw`
(function () {
  window.__p = { calls: [], meals: [], off: [], failMeal: false };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var r = { ok: true }, status = 200;
    if (/openfoodfacts\.org/.test(u)) {
      __p.off.push(u);
      r = /9300633100018/.test(u) ? { status: 1, product: { product_name: 'Test Protein Yoghurt', brands: 'Acme, Other', serving_quantity: '160', nutriments: { 'energy-kj_100g': 280, proteins_100g: 10, carbohydrates_100g: 4.5, fat_100g: 0.3 } } } : { status: 0 };
    } else {
      var b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
      __p.calls.push(b.type);
      if (b.type === 'meal') { if (__p.failMeal) status = 503; else __p.meals.push(b); }
      else if (b.type === 'mealRemove') { if (__p.failRemove) status = 503; else (__p.removed = __p.removed || []).push(b); }
      else if (b.type === 'weightLog') r = [];
      else if (b.type === 'photosGet') r = { ok: true, photos: [] };
      else if (b.type === 'healthSelfStatus') r = { ok: true, connected: false, days: [] };
      else if (b.type === 'clientWeekGet') r = { ok: false };
    }
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: status, headers: { 'Content-Type': 'application/json' } })); }, 30); });
  };
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled in test')); }; } catch (e) {}
  window.confirm = function () { return true; };
  // draw a real EAN-13 barcode and hand back its pixels
  window.__ean = function (code) {
    var L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
    var G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
    var R = L.map(function (s) { return s.replace(/./g, function (c) { return c === '0' ? '1' : '0'; }); });
    var P = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'][+code[0]];
    var bits = '101'; for (var i = 1; i <= 6; i++) bits += (P[i - 1] === 'L' ? L : G)[+code[i]];
    bits += '01010'; for (i = 7; i <= 12; i++) bits += R[+code[i]]; bits += '101';
    var m = 4, c = document.createElement('canvas'); c.width = (bits.length + 24) * m; c.height = 200;
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
    for (i = 0; i < bits.length; i++) if (bits[i] === '1') x.fillRect((12 + i) * m, 20, m, 160);
    return x.getImageData(0, 0, c.width, c.height);
  };
})();`;

function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -- ' + JSON.stringify(d).slice(0, 500) : '')); } };

(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(INIT);
  const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
  const shot = async (name) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); };
  const q = (sel, prop) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? e.${prop || 'innerText'} : null; })()`);
  const click = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e; })()`);
  const type = (sel, v) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const pickRes = (re) => page.eval(`(function () { var o = [].filter.call(document.querySelectorAll('#lif-res .lif-opt'), function (b) { return ${re}.test(b.innerText); })[0]; if (o) o.click(); return !!o; })()`);
  const big = () => q('#cv2-nutri .cv2-card .cv2-big');
  const prot = () => page.eval(`(function () { var i = document.querySelector('#cv2-nutri .cv2-card .cv2-mtile i[role=progressbar]'); return i ? +i.getAttribute('aria-valuenow') : null; })()`);
  try {
    console.log('food client (omar)');
    await page.goto(`${base}/clients/omar/index.html?t=apptest-dummy-token`);
    await wait(2500);
    await page.eval(`document.querySelector('#cv2-nav [data-id="nutrition"]').click(); 1`); await wait(800);

    t('Nutrition has a "Log food" button right under the day\'s totals', await page.eval(`(function () { var b = document.getElementById('lif-box'); return !!b && !!b.closest('#cv2-nutri') && b.previousElementSibling && b.previousElementSibling.classList.contains('cv2-card') && /Log food/.test(b.innerText); })()`), await q('#lif-box'));
    const big0 = await big(), p0 = await prot();
    const target = +String(big0 || '').replace(/,/g, '').match(/\d+/)[0];
    t('before logging: the page shows the plain target (' + target + ')', /kcal target today/.test(big0 || '') && target > 1000, big0);
    await shot('1_nutrition.png');

    // ── search + add ──
    await click('#lif-add'); await wait(900);
    t('the sheet opens with search, scan and label', !!(await q('#lif-q', 'placeholder')) && !!(await q('#lif-scan')) && !!(await q('#lif-new')), await q('#lif-sh'));
    t('food list loaded: thousands of everyday foods + plan products', await page.eval(`window.LockedInFoodData.g.length > 3000 && window.LockedInFoodData.p.length > 40`));
    await type('#lif-q', 'banana'); await wait(500);
    const res = await q('#lif-res');
    t('"banana" finds bananas, plain ones first', /^Banana/.test(res || '') && /Everyday food/.test(res || ''), (res || '').slice(0, 300));
    await shot('2_search.png');
    t('search is forgiving: "chicken breasts grilled", "yogurt"', await page.eval(`(function () { var s = LockedInFood._t.search; return s('chicken breasts grilled').length > 0 && s('yogurt').length > 0 && /yoghurt/i.test(s('yogurt')[0].n); })()`));
    t('a plan product and a chain item are searchable', await page.eval(`(function () { var s = LockedInFood._t.search; return s('up&go').concat(s('up go')).some(function (f) { return f.src === 'plan'; }) && s('nando').some(function (f) { return f.src === 'chain'; }); })()`), await page.eval(`LockedInFood._t.search('nando').length + '/' + LockedInFood._t.search('up go').length`));
    t('bacon is flagged as pork, turkey bacon is not', await page.eval(`(function () { var s = LockedInFood._t.search, b = s('bacon'); return b.length > 0 && b.filter(function (f) { return /^Bacon/.test(f.n) && !/turkey|beef/i.test(f.n); }).every(function (f) { return f.fl & 1; }); })()`));
    await pickRes('/^Banana, cavendish, peeled, raw/'); await wait(300);
    const d1 = await q('#lif-sh');
    t('detail: starts on a real-world unit (1 banana), macros shown', /Banana, cavendish/.test(d1 || '') && /banana/.test(await q('.lif-chip.on') || '') && /kcal/.test(await q('#lif-tot') || ''), d1);
    const one = await page.eval(`+document.querySelector('#lif-tot b').innerText.replace(/,/g, '')`);
    await click('.lif-step[aria-label="More"]'); await wait(100);
    const onehalf = await page.eval(`+document.querySelector('#lif-tot b').innerText.replace(/,/g, '')`);
    t('+ steps by half a banana and the numbers follow (' + one + ' -> ' + onehalf + ')', Math.abs(onehalf - one * 1.5) <= 2 && one > 60 && one < 200, [one, onehalf]);
    await page.eval(`document.querySelector('.lif-chips .lif-chip').click(); 1`); await wait(100);
    t('switching to grams keeps the same amount of food', Math.abs((await page.eval(`+document.querySelector('#lif-tot b').innerText.replace(/,/g, '')`)) - onehalf) <= 2 && /^g$/.test(await q('#lif-unit')), await q('#lif-amt', 'value'));
    await shot('3_detail.png');
    await click('#lif-go'); await wait(600);
    const big1 = await big();
    t('added: sheet closes, the day\'s kcal now counts it', !(await q('#lif-sh')) && new RegExp('kcal left · ' + onehalf + ' of ' + target.toLocaleString('en-AU') + ' logged').test(big1 || ''), big1);
    t('kcal left = target - logged', +String(big1).replace(/,/g, '').match(/\d+/)[0] === target - onehalf, big1);
    t('protein tile went up', (await prot()) >= p0 && /Other food/i.test(await q('#lif-box') || '') && /Banana/.test(await q('.lif-row') || ''), [p0, await prot(), await q('#lif-box')]);
    t('exactly one cloud write: "Extra: Banana…", with kcal + macros + amount', await page.eval(`(function () { var m = __p.meals; return m.length === 1 && /^Extra: Banana/.test(m[0].mealName) && m[0].calActual === ${onehalf} && m[0].pActual > 0 && /g$/.test(m[0].swapDesc) && m[0].status === 'ate'; })()`), await page.eval(`JSON.stringify(__p.meals)`));
    t('the row shows as synced', !/Not synced/.test(await q('#lif-box') || ''));
    await shot('4_logged.png');

    // ── survives a page re-render, Home shows it too ──
    await page.eval(`(function () { var d = document.querySelector('#cv2-nutri .cv2-day.on'); d.click(); })()`); await wait(400);
    t('still right after the page re-draws the day', (await big()) === big1 && (await page.eval(`document.querySelectorAll('#lif-box').length`)) === 1, await big());
    await page.eval(`cv2Go('cv2home'); 1`); await wait(600);
    const hb = await page.eval(`(function () { var x = document.querySelector('#cv2-cv2home-page .cv2-mtiles.two'); x = x && x.closest('.cv2-card').querySelector('.cv2-big'); return x ? x.innerText : null; })()`);
    t('Home nutrition card counts it too', new RegExp(onehalf + ' of ').test(hb || ''), hb);
    await shot('5_home.png');
    await page.eval(`document.querySelector('#cv2-nav [data-id="nutrition"]').click(); 1`); await wait(600);

    // ── another day: nothing carried over; future day refuses ──
    const other = await page.eval(`(function () { var ds = [].slice.call(document.querySelectorAll('#cv2-nutri .cv2-day')), i = ds.findIndex(function (d) { return d.classList.contains('today'); }); var j = i > 0 ? i - 1 : i + 1; ds[j].click(); return j < i ? 'past' : 'future'; })()`); await wait(400);
    t('a different day (' + other + ') does not show today\'s food', !/Banana/.test(await q('#lif-box') || '') && !new RegExp(onehalf + ' of').test(await big() || ''), await big());
    t('viewed day is read off the page', await page.eval(`(function () { var v = LockedInFood._t.viewedDay(), d = new Date(); d.setDate(d.getDate() + (${JSON.stringify(other)} === 'past' ? -1 : 1)); var s = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); return v === s; })()`), await page.eval(`LockedInFood._t.viewedDay()`));
    if (other === 'future') { await click('#lif-add'); await wait(200); t('a future day can\'t be logged', !(await q('#lif-sh'))); }
    await page.eval(`document.querySelector('#cv2-nutri .cv2-day.today').click(); 1`); await wait(400);
    t('back on today the food is there again', (await big()) === big1, await big());

    // ── offline -> not synced -> retry ──
    await page.eval(`__p.failMeal = true; 1`);
    await click('#lif-add'); await wait(400);
    t('Recent lists the banana', /Recent/i.test(await q('#lif-res') || '') && /Banana/.test(await q('#lif-res') || ''), await q('#lif-res'));
    await type('#lif-q', 'egg hard boiled'); await wait(400); await pickRes('/^Egg, chicken, whole, hard-boiled\\n/'); await wait(200);
    await click('#lif-go'); await wait(700);
    t('server down: still on the day, marked "Not synced yet"', /Egg/.test(await q('#lif-box') || '') && /Not synced yet/.test(await q('#lif-box') || '') && (await page.eval(`__p.meals.length`)) === 1, await q('#lif-box'));
    await page.eval(`__p.failMeal = false; window.dispatchEvent(new Event('online')); 1`); await wait(700);
    t('back online: sent once, mark gone', !/Not synced/.test(await q('#lif-box') || '') && (await page.eval(`__p.meals.length === 2 && /^Extra: Egg/.test(__p.meals[1].mealName)`)), await page.eval(`JSON.stringify(__p.meals.map(function (m) { return m.mealName; }))`));
    await page.eval(`window.dispatchEvent(new Event('online')); 1`); await wait(400);
    t('never sent twice', (await page.eval(`__p.meals.length`)) === 2);

    // ── remove ──
    const withEgg = await big();
    await page.eval(`document.querySelectorAll('#lif-box .lif-rm')[1].click(); 1`); await wait(300);
    t('remove takes it off the day and the totals', !/Egg/.test(await q('#lif-box') || '') && (await big()) === big1 && withEgg !== big1, [withEgg, await big()]);
    await wait(300);
    t('removed food is taken back on the server: same name and time as it was saved with', await page.eval(`(function () { var r = __p.removed || [], m = __p.meals[1]; return r.length === 1 && r[0].mealName === m.mealName && r[0].timestamp === m.timestamp; })()`), await page.eval(`JSON.stringify(__p.removed || [])`));
    await page.eval(`window.dispatchEvent(new Event('online')); 1`); await wait(300);
    t('server removal sent once', (await page.eval(`(__p.removed || []).length`)) === 1);
    // never-synced food: removing it needs no server call; server down on a synced one: retried later
    await page.eval(`__p.failMeal = true; 1`);
    await click('#lif-add'); await wait(400); await type('#lif-q', 'egg hard boiled'); await wait(400); await pickRes('/^Egg, chicken, whole, hard-boiled\\n/'); await wait(200);
    await click('#lif-go'); await wait(600);
    await page.eval(`document.querySelectorAll('#lif-box .lif-rm')[1].click(); 1`); await wait(400);
    t('food that never reached the server: removed with no server call', !/Egg/.test(await q('#lif-box') || '') && (await page.eval(`(__p.removed || []).length`)) === 1);
    await page.eval(`__p.failMeal = false; __p.failRemove = true; 1`);
    await click('#lif-add'); await wait(400); await type('#lif-q', 'egg hard boiled'); await wait(400); await pickRes('/^Egg, chicken, whole, hard-boiled\\n/'); await wait(200);
    await click('#lif-go'); await wait(700);
    await page.eval(`document.querySelectorAll('#lif-box .lif-rm')[1].click(); 1`); await wait(400);
    t('server down: removal waits', (await page.eval(`(__p.removed || []).length`)) === 1 && (await big()) === big1);
    await page.eval(`__p.failRemove = false; window.dispatchEvent(new Event('online')); 1`); await wait(500);
    t('back online: removal goes through once', (await page.eval(`(__p.removed || []).length`)) === 2);
    await page.eval(`window.dispatchEvent(new Event('online')); 1`); await wait(300);
    t('and is not sent again', (await page.eval(`(__p.removed || []).length`)) === 2);

    // ── type a label (kJ) ──
    await click('#lif-add'); await wait(300); await click('#lif-new'); await wait(200);
    await type('#lif-f-name', 'Test bar'); await type('#lif-f-e', '1674'); await type('#lif-f-p', '30'); await type('#lif-f-c', '40'); await type('#lif-f-f', '13'); await type('#lif-f-serve', '60');
    await shot('6_label.png');
    await click('#lif-f-save'); await wait(300);
    const lab = await q('#lif-sh');
    t('label in kJ per 100 g becomes kcal (1674 kJ = 400), saved to My foods, opens on 1 serve (60 g)', /Test bar/.test(lab || '') && /400 kcal/.test(lab || '') && /240/.test(await q('#lif-tot') || '') && /18 g/.test(await q('#lif-tot') || ''), [lab, await q('#lif-tot')]);
    await click('.lif-x'); await wait(100); await click('#lif-add'); await wait(300);
    t('My foods lists it', /My foods/i.test(await q('#lif-res') || '') && /Test bar/.test(await q('#lif-res') || ''), await q('#lif-res'));
    await click('#lif-new'); await wait(200);
    await type('#lif-f-name', 'Wrong'); await type('#lif-f-e', '2000'); await type('#lif-f-p', '80'); await type('#lif-f-c', '80'); await type('#lif-f-f', '20'); await click('#lif-f-save'); await wait(200);
    t('impossible label numbers are refused', /too high for 100 g/.test(await q('#lif-f-msg') || ''), await q('#lif-f-msg'));
    await click('.lif-back'); await wait(200);

    // ── barcode ──
    const dec = await page.eval(`LockedInFood._t.decode(__ean('9300633100018')).then(function (c) { return c; }, function (e) { return 'ERR ' + e; })`);
    t('a real EAN-13 image decodes with the bundled scanner (wasm served from our own site)', dec === '9300633100018', dec);
    // live camera, the way an iPhone does it: no built-in detector, a moving picture with the barcode small and a bit crooked
    await page.eval(`(function () {
      try { delete window.BarcodeDetector; } catch (e) {} window.BarcodeDetector = undefined;
      var src = __ean('9300633100018'), tmp = document.createElement('canvas'); tmp.width = src.width; tmp.height = src.height; tmp.getContext('2d').putImageData(src, 0, 0);
      var c = document.createElement('canvas'); c.width = 1280; c.height = 720; var x = c.getContext('2d'), f = 0;
      window.__camTimer = setInterval(function () {
        f++; x.fillStyle = '#6b7078'; x.fillRect(0, 0, 1280, 720);
        x.save(); x.translate(640 + Math.sin(f / 5) * 14, 360 + Math.cos(f / 7) * 10); x.rotate(0.07); x.drawImage(tmp, -190, -70, 380, 140); x.restore();
      }, 50);
      window.__vib = 0; navigator.vibrate = function () { __vib++; return true; };
      navigator.mediaDevices.getUserMedia = function () { return Promise.resolve(c.captureStream(20)); };
    })()`);
    const tScan = Date.now();
    await click('#lif-scan');
    let live = null; for (let i = 0; i < 40 && !live; i++) { await wait(150); if (await page.eval(`!!document.querySelector('.lif-cam.hit')`)) live = Date.now() - tScan; }
    t('live camera: locks on with a green frame and "Got it" (' + live + ' ms incl. loading the scanner)', live !== null && live < 5000 && /Got it/.test(await q('.lif-cam') || ''), live);
    await shot('7b_locked.png'); await wait(900);
    t('then goes straight to the product, buzzes once, camera off', /Acme Test Protein Yoghurt/.test(await q('#lif-sh') || '') && (await page.eval(`__vib`)) === 1, await q('#lif-sh'));
    await page.eval(`clearInterval(__camTimer); navigator.mediaDevices.getUserMedia = function () { return Promise.reject(new Error('no camera')); }; __p.off = []; 1`);
    t('the scanner reads the middle band of the picture', await page.eval(`(function () { var b = LockedInFood._t.band(1920, 1080); return b.sx > 0 && b.sy > 200 && b.w <= 1000 && b.h < 520; })()`));
    await click('.lif-back'); await wait(200);
    await click('#lif-scan'); await wait(500);
    t('scan screen offers typing the number and a photo when there is no camera', !!(await q('#lif-code', 'placeholder')) && /photo/i.test(await q('#lif-sh') || ''), await q('#lif-sh'));
    await shot('7_scan.png');
    await type('#lif-code', '9300633100018'); await click('#lif-code-go'); await wait(500);
    const offv = await q('#lif-sh');
    t('lookup: product found, kJ converted (280 kJ = 67 kcal), serve size offered, told to check the label', /Acme Test Protein Yoghurt/.test(offv || '') && /67 kcal/.test(offv || '') && /160 g/.test(offv || '') && /Check it against the label/.test(offv || ''), offv);
    t('the lookup sent only the barcode', await page.eval(`__p.off.length === 1 && /product\\/9300633100018\\.json\\?fields=/.test(__p.off[0]) && !/omar|token|apptest/.test(__p.off[0])`), await page.eval(`__p.off[0]`));
    await click('.lif-back'); await wait(200); await click('#lif-scan'); await wait(300);
    await type('#lif-code', '9311111111117'); await click('#lif-code-go'); await wait(500);
    t('unknown barcode -> label form with the barcode kept', /Type a label/.test(await q('#lif-sh') || '') && /isn't in the list yet/.test(await q('#lif-f-msg') || '') && /9311111111117/.test(await q('#lif-sh') || ''), await q('#lif-sh'));
    await click('.lif-x'); await wait(100);

    // ── survives reload; pilot gate ──
    await page.goto(`${base}/clients/omar/index.html?t=apptest-dummy-token`); await wait(2500);
    await page.eval(`document.querySelector('#cv2-nav [data-id="nutrition"]').click(); 1`); await wait(800);
    t('after a reload the banana is still on today, nothing re-sent', (await big()) === big1 && (await page.eval(`__p.meals.length`)) === 0, [await big(), await page.eval(`__p.meals.length`)]);
    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
    t('no script errors', errs.length === 0, errs);
    await page.goto(`${base}/clients/zain_hussein/index.html?t=apptest-dummy-token`); await wait(2500);
    await page.eval(`document.querySelector('#cv2-nav [data-id="nutrition"]').click(); 1`); await wait(800);
    t('pilot: another client\'s page has no Log food and never loads the file', !(await q('#lif-box')) && (await page.eval(`typeof window.LockedInFood`)) === 'undefined' && !!(await q('#lip-eo')));
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
