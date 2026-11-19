// LOG FOOD on EVERY client page (rollout check, Omar 2026-11-19). Headless Chrome, fake backend, nothing leaves the machine.
// For each clients/<key>/index.html: page loads with no script errors; on a V2 page with a Nutrition screen the
// "Log food" box is there, a banana adds to the day's calories with ONE cloud write, and removing it puts the total back.
// usage: node tests/food_fleet.test.js [key ...]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const INIT = String.raw`
(function () {
  window.__p = { meals: [], removed: [] };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var r = { ok: true }, b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    if (b.type === 'meal') __p.meals.push(b);
    else if (b.type === 'mealRemove') __p.removed.push(b);
    else if (b.type === 'weightLog') r = [];
    else if (b.type === 'photosGet') r = { ok: true, photos: [] };
    else if (b.type === 'healthSelfStatus') r = { ok: true, connected: false, days: [] };
    else if (b.type === 'clientWeekGet') r = { ok: false };
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, 20); });
  };
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled in test')); }; } catch (e) {}
  window.confirm = function () { return true; };
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
(async () => {
  const want = process.argv.slice(2);
  const keys = fs.readdirSync(path.join(ROOT, 'clients')).filter((k) => fs.existsSync(path.join(ROOT, 'clients', k, 'index.html')) && (!want.length || want.includes(k))).sort();
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch();
  let bad = 0; const tally = { food: 0, none: 0 };
  try {
    for (const k of keys) {
      const page = new Page(c); await page.init(); await page.addInit(INIT);
      const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
      const ev = (js) => page.eval(js);
      const problems = [];
      try {
        await page.goto(`${base}/clients/${k}/index.html?t=apptest-dummy-token`); await wait(2200);
        await ev(`try { localStorage.clear(); } catch (e) {} 1`);
        await page.goto(`${base}/clients/${k}/index.html?t=apptest-dummy-token`); await wait(2200);
        const v2 = await ev(`document.body.classList.contains('cv2')`);
        const hasNutri = v2 && await ev(`(function () { var b = document.querySelector('#cv2-nav [data-id="nutrition"]'); if (b) b.click(); return !!b; })()`);
        if (hasNutri) await wait(900);
        const box = hasNutri && await ev(`!!document.getElementById('lif-box')`);
        const big = () => ev(`(function () { var e = document.querySelector('#cv2-nutri .cv2-card .cv2-big'); return e ? e.innerText : null; })()`);
        let note = v2 ? (hasNutri ? '' : 'no Nutrition screen') : 'classic page';
        if (k === 'isaac_alameddine') { if (box) problems.push('isaac should stay without Log food'); note = note || 'kept off'; }
        else if (hasNutri && !box) problems.push('V2 Nutrition screen but no Log food box');
        if (box) {
          const b0 = await big();
          await ev(`document.getElementById('lif-add').click(); 1`); await wait(500);
          await ev(`(function () { var e = document.getElementById('lif-q'); e.value = 'banana raw'; e.dispatchEvent(new Event('input', { bubbles: true })); })(); 1`); await wait(500);
          const picked = await ev(`(function () { var o = document.querySelector('#lif-res .lif-opt'); if (o) o.click(); return !!o; })()`); await wait(250);
          if (!picked) problems.push('search found nothing for banana');
          await ev(`(function () { var e = document.getElementById('lif-go'); if (e) e.click(); })(); 1`); await wait(700);
          const b1 = await big(), meals = await ev(`__p.meals.length`);
          if (b1 === b0) problems.push('total did not change after adding a food: ' + b0);
          if (meals !== 1) problems.push('expected 1 cloud write, got ' + meals);
          const nm = await ev(`__p.meals[0] && __p.meals[0].mealName`);
          if (!/^Extra: /.test(String(nm))) problems.push('saved name is not an Extra: ' + nm);
          await ev(`(function () { var e = document.querySelector('#lif-box .lif-rm'); if (e) e.click(); })(); 1`); await wait(600);
          const b2 = await big();
          if (b2 !== b0) problems.push('total did not go back after removing: ' + b0 + ' -> ' + b2);
          if ((await ev(`__p.removed.length`)) !== 1) problems.push('removal not sent to the server once');
          tally.food++;
        } else tally.none++;
        const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
        if (errs.length) problems.push('script errors: ' + errs.slice(0, 3).join(' | ').slice(0, 300));
        console.log((problems.length ? '  FAIL ' : '  ok   ') + k.padEnd(24) + (box ? 'Log food works' : note) + (problems.length ? '  -- ' + problems.join('; ') : ''));
      } catch (e) { problems.push(String(e && e.message || e)); console.log('  FAIL ' + k + '  -- ' + problems.join('; ')); }
      if (problems.length) bad++;
      try { await ev(`try { localStorage.clear(); } catch (e) {} 1`); } catch (e) {}
      try { await page.close && page.close(); } catch (e) {}
    }
  } finally { close(); srv.close(); }
  console.log(`\n${keys.length} pages: ${tally.food} with Log food, ${tally.none} without, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
