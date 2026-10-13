// APPLE HEALTH setup page (health/index.html, Omar 2026-10-14) in headless Chrome against a fake API.
//   the key leaves the address bar · consent needs both boxes · consent -> code + steps · "Check it worked" ·
//   stop sharing deletes · a missing / revoked link says so · no script errors
// usage: node tests/health_page.test.js [--shots <dir>]
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const KEY = 'lih_' + '0123456789abcdef0123456789abcdef01234567';
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

const STUB = String.raw`
(function () {
  var st = { active: false, lastDay: null, valid: true };
  window.__st = st; window.__calls = [];
  var real = window.fetch.bind(window);
  window.confirm = function () { return true; };
  window.fetch = function (u, o) {
    if (String(u).indexOf('supabase.co') < 0) return real(u, o);
    var b = JSON.parse((o && o.body) || '{}'); window.__calls.push(b);
    var r = !st.valid || b.healthKey !== '${KEY}' ? { ok: false, error: 'invalid_key' }
      : b.type === 'healthStatus' ? { ok: true, firstName: 'Omar', active: st.active, consentVersion: 'health-v1-2026-10-14', lastDay: st.lastDay }
      : b.type === 'healthConsent' ? (b.agree === true && b.version === 'health-v1-2026-10-14' ? (st.active = true, { ok: true, active: true }) : { ok: false, error: 'consent_required' })
      : b.type === 'healthRevoke' ? (st.valid = false, { ok: true, revoked: true, deleted: b.deleteData ? 3 : 0 })
      : { ok: false, error: 'unknown' };
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: 200 })); }, 60); });
  };
})();`;

function serve() {
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0].split('#')[0]); if (u.endsWith('/')) u += 'index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.png') ? 'image/png' : 'text/plain' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + JSON.stringify(d).slice(0, 300) : '')); } };
const vis = (id) => `!document.getElementById('${id}').hidden`;

(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(STUB);
  const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
  const shot = async (name) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); };
  try {
    console.log('apple health setup page');
    await page.goto(`${base}/health/#k=${KEY}`); await wait(400);
    const a = await page.eval(`({ url: location.href, consent: ${vis('consent')}, setup: ${vis('setup')}, hello: document.getElementById('hello').textContent,
      btn: document.getElementById('agreeBtn').disabled })`);
    t('opens on consent with the first name; the key is out of the address bar', a.consent && !a.setup && /Hey Omar/.test(a.hello) && !a.url.includes(KEY), a);
    t('agree button disabled until both boxes are ticked', a.btn === true);
    await shot('1_consent.png');
    await page.eval(`document.getElementById('agree').click(); 1`);
    t('one box is not enough', await page.eval(`document.getElementById('agreeBtn').disabled`) === true);
    await page.eval(`document.getElementById('adult').click(); document.getElementById('agreeBtn').click(); 1`); await wait(500);
    const b = await page.eval(`({ consent: ${vis('consent')}, setup: ${vis('setup')}, off: ${vis('off')}, code: document.getElementById('code').textContent,
      sent: __calls.filter(function (x) { return x.type === 'healthConsent'; })[0] })`);
    t('consent sent with agree + version -> code and setup steps shown', !b.consent && b.setup && b.off && b.code === KEY && b.sent && b.sent.agree === true && b.sent.version === 'health-v1-2026-10-14', b);
    await shot('2_setup.png');
    await page.eval(`document.getElementById('checkBtn').click(); 1`); await wait(300);
    t('"Check it worked" before any upload says nothing received', /Nothing received yet/.test(await page.eval(`document.getElementById('checkMsg').textContent`)));
    await page.eval(`__st.lastDay = '2026-10-14'; document.getElementById('checkBtn').click(); 1`); await wait(300);
    const d = await page.eval(`({ msg: document.getElementById('checkMsg').textContent, connected: ${vis('connected')} })`);
    t('after an upload: Received + connected card', /Received/.test(d.msg) && /14 October/.test(d.msg) && d.connected, d);
    await page.eval(`document.getElementById('offBtn').click(); 1`); await wait(300);
    const e = await page.eval(`({ stopped: ${vis('stopped')}, setup: ${vis('setup')}, msg: document.getElementById('stoppedMsg').textContent,
      sent: __calls.filter(function (x) { return x.type === 'healthRevoke'; })[0] })`);
    t('stop sharing: revoke with deleteData, everything else hidden, "3 days" deleted', e.stopped && !e.setup && /3 days/.test(e.msg) && e.sent.deleteData === true, e);
    await shot('3_stopped.png');
    // stopping already removed the key from this tab (sessionStorage), so a bare /health/ has no key
    await page.goto(`${base}/health/?nokey=1`); await wait(300);
    t('no key -> "This link isn\'t active"', await page.eval(vis('invalid')) && !(await page.eval(vis('consent'))));
    await page.goto(`${base}/health/?revoked=1#k=lih_${'f'.repeat(40)}`); await wait(400);
    t('unknown / revoked key -> "This link isn\'t active"', await page.eval(vis('invalid')));
    t('no script errors', page.errors.filter((x) => !/Failed to load resource|favicon/.test(x)).length === 0, page.errors);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
