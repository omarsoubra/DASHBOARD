// TESTIMONIAL FORM (testimonial.html, Omar 2026-10-16) in headless Chrome (iPhone-sized) against a fake backend.
//   bad / missing link -> "isn't working" · greeting by first name · empty send refused · send -> testimonialSubmit with the
//   link token, answers and consent -> thanks · reopening shows their answers (edit) · draft kept on the phone · no errors
const http = require('http'), fs = require('fs'), path = require('path');
const { launch, Page } = require('./client_app/cdp');
const ROOT = path.resolve(__dirname, '..');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TOK = 'Tk_' + 'a1B2c3'.repeat(7);
const INIT = String.raw`
(function () {
  var saved = null; try { saved = JSON.parse(sessionStorage.getItem('__fx_t') || 'null'); } catch (e) {}
  window.__t = { calls: [], saved: saved };
  var real = window.fetch.bind(window);
  window.fetch = function (u, o) {
    u = String((u && u.url) || u);
    if (u.indexOf(location.origin) === 0 || u.charAt(0) === '/' || !/^https?:/.test(u)) return real(u, o);
    if (!/supabase\.co\/functions\/v1\/api$/.test(u)) return Promise.reject(new TypeError('blocked ' + u));
    var b = {}; try { b = JSON.parse((o && o.body) || '{}'); } catch (e) {}
    __t.calls.push(b);
    var r = { ok: false, error: 'link_invalid' };
    if (b.t === '${TOK}') {
      if (b.type === 'testimonialFormGet') r = __t.saved ? { ok: true, firstName: 'Ali', submittedAt: '2026-10-16T01:00:00Z', answers: __t.saved.answers, consent: __t.saved.consent } : { ok: true, firstName: 'Ali', submittedAt: null, answers: {}, consent: {} };
      if (b.type === 'testimonialSubmit') { __t.saved = { answers: b.answers, consent: b.consent }; sessionStorage.setItem('__fx_t', JSON.stringify(__t.saved)); r = { ok: true, submittedAt: '2026-10-16T01:00:00Z' }; }
    }
    return new Promise(function (res) { setTimeout(function () { res(new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, 30); });
  };
})();`;
function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -- ' + JSON.stringify(d).slice(0, 300) : '')); } };
(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const { c, close } = await launch(); const page = new Page(c); await page.init(); await page.addInit(INIT);
  const wait = (ms) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);
  const vis = (id) => page.eval(`(function () { var e = document.getElementById(${JSON.stringify(id)}); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; })()`);
  const onlyOne = () => page.eval(`['loading', 'bad', 'thanks', 'f'].filter(function (id) { return getComputedStyle(document.getElementById(id)).display !== 'none'; }).length === 1`);
  const shot = async (n) => { if (!shots) return; const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, n), Buffer.from(r.data, 'base64')); };
  try {
    console.log('testimonial form');
    await page.goto(`${base}/testimonial.html`); await wait(300);
    t('no link -> "This link isn\'t working"', await vis('bad') && !(await vis('f')));
    await page.goto(`${base}/testimonial.html?t=${'Z'.repeat(43)}`); await wait(400);
    t('unknown link -> the same message', await vis('bad'));
    await page.goto(`${base}/testimonial.html?t=${TOK}`); await wait(500);
    t('valid link -> form, greeting by first name, name pre-filled', await vis('f') && /Ali, how did your block go\?/.test(await page.eval(`document.getElementById('hello').textContent`)) && (await page.eval(`document.getElementById('name').value`)) === 'Ali');
    t('only one state shows at a time (form)', await onlyOne());
    await shot('1_form.png');
    await page.eval(`document.getElementById('go').click(); 1`); await wait(200);
    t('sending with no answers is refused on the page', /at least one/.test(await page.eval(`document.getElementById('status').textContent`)) && !(await page.eval(`__t.calls.some(function (b) { return b.type === 'testimonialSubmit'; })`)));
    await page.eval(`(function () { document.getElementById('q1').value = 'Kept falling off.'; document.getElementById('q2').value = 'Down 4.7 kg, chest press 27 to 41 kg.'; document.getElementById('q6').value = 'More recipes';
      document.getElementById('c_name_init').click(); document.getElementById('c_photos_face').click(); document.getElementById('f').dispatchEvent(new Event('input')); return 1; })()`);
    t('the draft is kept on the phone while typing', /Kept falling off/.test(await page.eval(`JSON.stringify(localStorage)`)));
    await page.eval(`document.getElementById('go').click(); 1`); await wait(400);
    const sub = await page.eval(`__t.calls.filter(function (b) { return b.type === 'testimonialSubmit'; })[0] || null`);
    t('send -> testimonialSubmit with the link token, answers and consent (unanswered = blank)', !!sub && sub.t === TOK && sub.answers.q2 === 'Down 4.7 kg, chest press 27 to 41 kg.' && sub.consent.name === 'initials' && sub.consent.photos === 'face_hidden' && sub.consent.numbers === '', sub);
    t('no client token or storage key is ever sent', !(await page.eval(`__t.calls.some(function (b) { return 'token' in b || 'storageKey' in b || 'coachToken' in b; })`)));
    t('-> "Sent. Thank you"', await vis('thanks') && !(await vis('f')));
    t('the draft is cleared once sent', !/Kept falling off/.test(await page.eval(`JSON.stringify(localStorage)`)));
    t('only one state shows at a time (thanks)', await onlyOne());
    await shot('2_thanks.png');
    await page.goto(`${base}/testimonial.html?t=${TOK}`); await wait(500);
    t('reopening the link shows "Sent" with Edit', await vis('thanks'));
    await page.eval(`document.getElementById('edit').click(); 1`); await wait(100);
    t('Edit brings back their answers and choices', (await page.eval(`document.getElementById('q2').value`)) === 'Down 4.7 kg, chest press 27 to 41 kg.' && (await page.eval(`document.getElementById('c_photos_face').checked`)));
    const errs = page.errors.filter((x) => !/Failed to load resource|favicon|net::ERR|blocked/i.test(x));
    t('no script errors', errs.length === 0, errs);
  } finally { close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
