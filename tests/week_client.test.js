// YOUR WEEK + FROM OMAR (week-client.js via push-client.js, Omar 2026-10-14) on a REAL client page in headless Chrome
// against a fake backend. Nothing leaves the machine.
//   Home (a Monday): last week's recap tiles vs the week before, PR line, "Omar reviewed your week" -> Coach
//   Coach: "Latest feedback" shows the reply Omar sent + earlier ones · hidden mid-week without fresh feedback · no errors
// usage: node tests/week_client.test.js [client_key] [--shots dir]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const KEY = process.argv.slice(2).find((a) => !a.startsWith('--') && !/\//.test(a)) || 'zain_hussein';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const INIT = (dow) => String.raw`
(function () {
  // shift the whole clock to the next ${dow === 1 ? 'Monday' : 'Friday'} 10:00 (a real date, so the app's own week maths still works)
  (function () { var RD = Date, n = new RD(), add = ((${dow} - n.getDay()) + 7) % 7 || 7, tgt = new RD(n.getFullYear(), n.getMonth(), n.getDate() + add, 10, 0, 0).getTime(), off = tgt - RD.now();
    function FD(a, b, c, d, e, f, g) { if (!(this instanceof FD)) return new RD(RD.now() + off).toString(); return arguments.length ? new (Function.prototype.bind.apply(RD, [null].concat([].slice.call(arguments))))() : new RD(RD.now() + off); }
    FD.prototype = RD.prototype; FD.now = function () { return RD.now() + off; }; FD.parse = RD.parse; FD.UTC = RD.UTC; window.Date = FD; })();
  window.__w = { calls: [] };
  var hAgo = function (h) { return new Date(Date.now() - h * 3600e3).toISOString(); };
  var WEEK = { ok: true, week: { from: '2026-10-05', to: '2026-10-11' }, sessions: 4, sessionsPrev: 3, prs: [{ exercise: 'Back Squat', kg: 105, prev: 100 }],
    weightAvg: 79.8, weightAvgPrev: 80.6, mealDays: 6, mealDaysPrev: 4, steps: 8900, stepsPrev: 7600, sleepMin: 431, stepTarget: 9500,
    feedback: [{ text: 'Zain, massive week. 4 sessions and a squat PR.\nThis week: same plan, keep steps near 9.5k.', sentAt: hAgo(20), checkinTs: 'x' },
               { text: 'Good start bro, keep logging meals.', sentAt: hAgo(200), checkinTs: 'y' }] };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    var b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    __w.calls.push(b.type);
    var r = b.type === 'clientWeekGet' ? WEEK : b.type === 'healthSelfStatus' ? { ok: true, connected: false, days: [] } : { ok: true };
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, 30); });
  };
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled in test')); }; } catch (e) {}
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
  for (const [label, dow] of [['Monday', 1], ['Friday', 5]]) {
    const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(INIT(dow));
    const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
    const q = (sel) => page.eval(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : null; })()`);
    const shot = async (name) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); };
    try {
      console.log('your week (' + KEY + ', ' + label + ')');
      await page.goto(`${base}/clients/${KEY}/index.html?t=apptest-dummy-token`); await wait(2600);
      t(label + ': clientWeekGet called once with the client login', await page.eval(`__w.calls.filter(function (x) { return x === 'clientWeekGet'; }).length === 1`));
      const home = await q('#liw-home');
      if (dow === 1) {
        t('Monday: "Your week" card on Home with the dates', /Your week/.test(home || '') && /5–11 Oct/.test(home || ''), home);
        t('tiles vs the week before: 4 sessions ▲1, 79.8 kg ▼0.8, 6/7 meal days ▲2, 8,900 steps (goal 9,500)', /4\s*▲ 1/.test(home) && /79\.8\s*▼ 0\.8 kg/.test(home) && /6\/7\s*▲ 2/.test(home) && /8,900/.test(home) && /goal 9,500/.test(home), home);
        t('PR line: Back Squat 105 kg (+5)', /New best: Back Squat 105 kg \(\+5\)/.test(home), home);
        t('"Omar reviewed your week" with the start of his reply', /reviewed your week/.test(home) && /massive week/.test(home), home);
        t('the card sits on Home inside the page', await page.eval(`!!document.querySelector('#cv2-cv2home-page #liw-home')`));
        await page.eval(`document.getElementById('liw-home').scrollIntoView({ block: 'center' }); 1`); await wait(200);
        await shot('1_home_your_week.png');
        await page.eval(`document.querySelector('#liw-home .liw-from').click(); 1`); await wait(800);
        const coach = await page.eval(`(function(){ var p = document.getElementById('cv2-cv2coach-page'); return p ? p.innerText : null; })()`);
        t('tapping it opens Coach: "Latest feedback" shows Omar\'s full reply', /Latest feedback/.test(coach || '') && /This week: same plan, keep steps near 9\.5k\./.test(coach || ''), (coach || '').slice(0, 300));
        t('...with the earlier reply tucked under "Earlier feedback (1)"', /Earlier feedback \(1\)/.test(coach || ''));
        t('no more "replies by message" placeholder once real feedback exists', !/reviews every check-in and sends feedback by message/.test(coach || ''));
        await page.eval(`(function(){ var c = [].slice.call(document.querySelectorAll('#cv2-cv2coach-page .cv2-card')).filter(function (x) { return /Latest feedback/.test(x.textContent); })[0]; if (c) c.scrollIntoView({ block: 'start' }); return 1; })()`); await wait(200);
        await shot('2_coach_feedback.png');
      } else {
        t('Friday: no recap card, but fresh feedback (20 h old) still shows as "From Omar"', home && !/Your week/.test(home) && /From Omar/.test(home) && /massive week/.test(home), home);
      }
      const errs = page.errors.filter((x) => !/Failed to load resource|favicon|service ?worker|disabled in test|net::ERR/i.test(x));
      t(label + ': no script errors', errs.length === 0, errs);
    } finally { close(); }
  }
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
