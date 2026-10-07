#!/usr/bin/env node
// Client accounts V1 — headless-Chrome test of the REAL login page against a LOCAL
// Supabase Auth + api stack (see scripts/accounts/accounts_e2e.mjs for the stack).
//
//   ACC_API=http://127.0.0.1:54400/functions/v1/api ACC_SUPABASE=http://127.0.0.1:54400 \
//   ACC_ANON_JWT_FILE=.../anon_jwt node scripts/accounts/login_e2e.js
//
// Serves this repo's login/ page from 127.0.0.1 with a local config.js. Client pages
// are stand-ins that read the device key exactly like real shells
// (localStorage['<key>_access_token']) and show which client's data that key reaches.
// Two separate browser profiles = two separate clients. Nothing touches production.
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const API = process.env.ACC_API, SUPA = process.env.ACC_SUPABASE, ANON = fs.readFileSync(process.env.ACC_ANON_JWT_FILE, 'utf8').trim();
const COACH = crypto.createHash('sha256').update('coach-test').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sql = (q) => execFileSync('docker', ['exec', '-i', 'acc_db', 'psql', '-U', 'supabase_admin', '-h', 'localhost', '-d', 'postgres', '-tA', '-q', '-c', q]).toString().trim();
const api = async (b) => (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) })).json();

const CLIENT_PAGE = (key) => `<!doctype html><meta charset="utf-8"><title>${key}</title><body><h1 id="who">${key}</h1><pre id="data">loading</pre>
<a id="logout" href="../../login/#logout">Log out</a><script>
const KEY='${key}', TOK=localStorage.getItem(KEY+'_access_token')||'';
fetch(${JSON.stringify(API)},{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({type:'weightLog',token:TOK,storageKey:KEY,client:KEY==='alice_a'?'bob_b':'alice_a'})})
 .then(r=>r.json()).then(j=>{document.getElementById('data').textContent=JSON.stringify(j)});</script>`;

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (u === '/login/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.LI_AUTH_CONFIG=${JSON.stringify({ supabaseUrl: SUPA, anonKey: ANON, apiUrl: API })};`);
  }
  const m = /^\/clients\/([a-z0-9_]+)\/(index\.html)?$/.exec(u);
  if (m) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(CLIENT_PAGE(m[1])); }
  let f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.json') ? 'application/json' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(f).pipe(res);
});

(async () => {
  // seed: two existing clients with private data, no accounts yet
  sql(`delete from client_device_tokens; delete from client_invites; delete from weight_logs; delete from client_sessions; delete from clients; delete from profiles; delete from auth.users;`);
  for (const [key, name, kg] of [['alice_a', 'Alice Smith', 61], ['bob_b', 'Bob Jones', 92]]) {
    const pid = sql(`insert into profiles(full_name) values ('${name}') returning id`).split('\n')[0];
    const cid = sql(`insert into clients(profile_id, storage_key, display_name) values ('${pid}','${key}','${name}') returning id`).split('\n')[0];
    sql(`insert into client_sessions(storage_key, client_id, token_hash, salt) values ('${key}','${cid}','${sh(crypto.randomBytes(16).toString('hex'))}','s')`);
    sql(`insert into weight_logs(client_id, client_key, weight_kg) values ('${cid}','${key}',${kg})`);
  }
  await new Promise((r) => srv.listen(9951, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:9951';
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'login-e2e-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9953', '--no-first-run', '--disable-background-networking', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9953/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.text + ' ' + ((d.params.exceptionDetails.exception || {}).description || '')); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  async function profile() {   // an isolated browser profile (own localStorage = own device)
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
    const go = async (url, wait = 2500) => { await send('Page.navigate', { url }, s); await sleep(wait); };
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
    const type = async (sel, text) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const click = async (sel) => ev(`(()=>{document.querySelector(${JSON.stringify(sel)}).click();return true})()`);
    const visible = (vid) => ev(`!document.getElementById('${vid}').hidden`);
    return { ev, go, until, type, click, visible, s };
  }
  const C = []; const check = (n, c, d) => C.push({ n, c: !!c, d });
  const linkOf = (l) => l.replace('https://omarsoubra.github.io/DASHBOARD/login/', BASE + '/login/');

  // ── Alice (profile 1) accepts her invite in the browser
  const A = await profile();
  const inv = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'alice_a' });
  await A.go(linkOf(inv.link));
  check('invite link opens the set-up screen with her first name', await A.until(`!document.getElementById('v-claim').hidden && document.getElementById('claim-title').textContent.includes('Alice')`), await A.ev(`document.getElementById('claim-title').textContent`));
  check('the token is removed from the address bar immediately', !(await A.ev('location.hash')).includes('invite='), await A.ev('location.href'));
  await A.type('#claim-email', 'alice@example.com'); await A.type('#claim-password', 'alicepass123'); await A.type('#claim-confirm', 'different1');
  await A.click('#claim-btn');
  check('mismatched confirmation caught before sending', (await A.ev(`document.getElementById('claim-confirm-err').textContent`)).includes('match'));
  await A.type('#claim-confirm', 'alicepass123'); await A.click('#claim-btn');
  check('account created → lands on HER program', await A.until(`location.pathname === '/clients/alice_a/'`, 12000), await A.ev('location.href'));
  const kgs = (P) => P.ev(`(()=>{try{const j=JSON.parse(document.getElementById('data').textContent);return Array.isArray(j)?j.map(r=>Number(r.weightKg)).join():'err:'+(j.error||'')}catch(e){return 'pending'}})()`);
  check('her page reaches only her data (61 kg), even when it asks for Bob', await A.until(`document.getElementById('data').textContent !== 'loading'`) && (await kgs(A)) === '61', await kgs(A));
  check('no password stored anywhere in browser storage', !(await A.ev(`JSON.stringify(Object.assign({}, localStorage, sessionStorage)).includes('alicepass123')`)));

  // stays logged in: reopen the shared URL → straight back in, no login-form flash
  // Record, from inside the page, whether the login form is EVER shown during this visit.
  const probe = await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded',()=>{const v=document.getElementById('v-login');if(!v)return;
    const mark=()=>{if(!v.hidden)localStorage.setItem('e2e_login_shown','1')};mark();new MutationObserver(mark).observe(v,{attributes:true});});` }, A.s);
  await A.ev(`localStorage.removeItem('e2e_login_shown')`);
  await A.go(BASE + '/login/', 3000);
  check('reopening the app restores the session first (login form never shown)', (await A.ev(`localStorage.getItem('e2e_login_shown')`)) === null);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier }, A.s);
  check('…and opens her program without logging in again', await A.until(`location.pathname === '/clients/alice_a/'`, 10000), await A.ev('location.href'));

  // changing the URL never exposes another client
  await A.go(BASE + '/clients/bob_b/');
  check('typing Bob\'s URL in Alice\'s browser shows no Bob data', await A.until(`document.getElementById('data').textContent !== 'loading'`) && !/92/.test(await A.ev(`document.getElementById('data').textContent`)), await A.ev(`document.getElementById('data').textContent`));

  // logout
  const aliceKey = await A.ev(`localStorage.getItem('alice_a_access_token')`);
  await A.go(BASE + '/clients/alice_a/'); await A.click('#logout');
  check('log out → back to the login screen with a confirmation', await A.until(`!document.getElementById('v-login').hidden && document.getElementById('login-alert').textContent.includes('logged out')`), await A.ev('document.body.innerText.slice(0,200)'));
  check('logout removed the device key from the browser', (await A.ev(`localStorage.getItem('alice_a_access_token')`)) === null);
  check('logout revoked the key on the server', (await api({ type: 'authClient', token: aliceKey, storageKey: 'alice_a' })).ok === false);
  await A.go(BASE + '/login/');
  check('after logout the app asks to log in', await A.until(`!document.getElementById('v-login').hidden`));

  // wrong password, then right password
  await A.type('#login-email', 'alice@example.com'); await A.type('#login-password', 'wrongpass99'); await A.click('#login-btn');
  check('wrong password → clear error, stays on login', await A.until(`!document.getElementById('login-alert').hidden && document.getElementById('login-alert').textContent.includes('don’t match')`), await A.ev(`document.getElementById('login-alert').textContent`));
  await A.type('#login-password', 'alicepass123'); await A.click('#login-btn');
  check('right password → her program', await A.until(`location.pathname === '/clients/alice_a/'`, 12000));
  await A.go(BASE + '/login/'); await A.until(`location.pathname === '/clients/alice_a/'`, 10000);

  // ── Bob (profile 2): own account, own data
  const Bp = await profile();
  const binv = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'bob_b' });
  await Bp.go(linkOf(binv.link)); await Bp.until(`!document.getElementById('v-claim').hidden`);
  await Bp.type('#claim-email', 'alice@example.com'); await Bp.type('#claim-password', 'bobpass12345'); await Bp.type('#claim-confirm', 'bobpass12345'); await Bp.click('#claim-btn');
  check('Bob using Alice\'s email is refused with a clear message', await Bp.until(`document.getElementById('claim-email-err').textContent.includes('already used')`), await Bp.ev(`document.getElementById('claim-email-err').textContent`));
  await Bp.type('#claim-email', 'bob@example.com'); await Bp.click('#claim-btn');
  check('Bob lands on HIS program', await Bp.until(`location.pathname === '/clients/bob_b/'`, 12000), await Bp.ev('location.href'));
  check('Bob sees only his data (92 kg)', await Bp.until(`document.getElementById('data').textContent !== 'loading'`) && (await kgs(Bp)) === '92', await kgs(Bp));
  await Bp.go(BASE + '/clients/alice_a/');
  check('Bob typing Alice\'s URL gets nothing of hers', await Bp.until(`document.getElementById('data').textContent !== 'loading'`) && !/61/.test(await Bp.ev(`document.getElementById('data').textContent`)), await Bp.ev(`document.getElementById('data').textContent`));

  // ── forgot password + reset link
  await Bp.go(BASE + '/login/#logout'); await Bp.until(`!document.getElementById('v-login').hidden`);
  await Bp.click('#to-forgot');
  check('"Forgot password?" explains the reset link process', await Bp.until(`!document.getElementById('v-forgot').hidden && /Omar/.test(document.getElementById('v-forgot').textContent)`));
  const rs = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'bob_b', purpose: 'reset' });
  await Bp.go(linkOf(rs.link));
  check('reset link opens "Set a new password" (no email field)', await Bp.until(`!document.getElementById('v-claim').hidden && document.getElementById('claim-title').textContent.includes('new password') && document.getElementById('claim-email-wrap').hidden`));
  await Bp.type('#claim-password', 'newbobpass77'); await Bp.type('#claim-confirm', 'newbobpass77'); await Bp.click('#claim-btn');
  check('new password saved → logged straight in to his program', await Bp.until(`location.pathname === '/clients/bob_b/'`, 12000));
  await Bp.go(linkOf(rs.link));
  check('the reset link cannot be used twice', await Bp.until(`!document.getElementById('v-badlink').hidden && /already been used/.test(document.getElementById('bad-title').textContent)`));
  await Bp.go(BASE + '/login/#logout'); await Bp.until(`!document.getElementById('v-login').hidden`);
  await Bp.type('#login-email', 'bob@example.com'); await Bp.type('#login-password', 'bobpass12345'); await Bp.click('#login-btn');
  check('old password no longer works', await Bp.until(`!document.getElementById('login-alert').hidden`));
  await Bp.type('#login-password', 'newbobpass77'); await Bp.click('#login-btn');
  check('new password works', await Bp.until(`location.pathname === '/clients/bob_b/'`, 12000));

  // ── deactivation reaches an open session
  await api({ type: 'setAccessStatus', coachToken: COACH, storageKey: 'bob_b', status: 'revoked' });
  await Bp.go(BASE + '/clients/bob_b/');
  check('deactivated: his page can no longer read data', await Bp.until(`/access_revoked/.test(document.getElementById('data').textContent)`), await Bp.ev(`document.getElementById('data').textContent`));
  await Bp.go(BASE + '/login/');
  check('deactivated: reopening the app shows the paused message, not his program', await Bp.until(`!document.getElementById('v-login').hidden && /paused/.test(document.getElementById('login-alert').textContent)`, 10000), await Bp.ev('document.body.innerText.slice(0,300)'));
  check('Alice is unaffected', (await A.ev(`location.pathname`)) === '/clients/alice_a/' && (await kgs(A)) === '61', await kgs(A));

  check('no page errors', errors.length === 0, errors.slice(0, 3));
  const pass = C.filter((c) => c.c).length;
  for (const c of C) console.log(`${c.c ? 'PASS' : 'FAIL'}  ${c.n}${c.c ? '' : '  ' + JSON.stringify(c.d)}`);
  console.log(`\nlogin_e2e: ${pass}/${C.length} passed`);
  chrome.kill(); srv.close(); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(pass === C.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
