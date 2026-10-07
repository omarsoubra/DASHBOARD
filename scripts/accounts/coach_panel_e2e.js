#!/usr/bin/env node
// Client accounts V1 — the coach dashboard "App login" panel in headless Chrome.
// The REAL coach_dashboard.html is served from 127.0.0.1; its api calls to production are
// intercepted and forwarded to the LOCAL stack (scripts/accounts). Nothing reaches production.
//   ACC_API=http://127.0.0.1:54400/functions/v1/api node scripts/accounts/coach_panel_e2e.js
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..'), API = process.env.ACC_API;
const COACH = crypto.createHash('sha256').update('coach-test').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('docker', ['exec', '-i', 'acc_db', 'psql', '-U', 'supabase_admin', '-h', 'localhost', '-d', 'postgres', '-tA', '-q', '-c', q]).toString().trim();
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'coach_dashboard.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  sql(`delete from client_device_tokens; delete from client_invites; delete from auth.users; update profiles set auth_user_id = null; update client_sessions set access_status='active';`);
  await new Promise((r) => srv.listen(9961, '127.0.0.1', r));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-e2e-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9963', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9963/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(), handlers = [], errors = [], calls = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  handlers.push(async (d) => {
    if (d.sessionId !== s) return;
    if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text);
    if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, s).catch(() => {});
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params; let body = '{"ok":true}';
      if (request.method === 'POST' && request.postData) {
        const b = JSON.parse(request.postData); calls.push(b.type);
        if (/^account|setAccessStatus/.test(b.type)) body = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: request.postData })).text();
        else if (b.type === 'rosterGet') body = JSON.stringify({ ok: true, roster: [] });
      }
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, s).catch(() => {});
    }
  });
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] }, s);
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, s)).result.value;
  const until = async (e, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(e).catch(() => false)) return true; await sleep(200); } return false; };
  await send('Page.navigate', { url: 'http://127.0.0.1:9961/coach_dashboard.html' }, s); await sleep(1500);
  // signed-in coach + a two-client roster in this browser only
  await ev(`localStorage.setItem('sbo_coach_token', ${JSON.stringify(COACH)}); localStorage.setItem(LS_CLIENTS, JSON.stringify([
    {storageKey:'alice_a', name:'Alice Smith', accessStatus:'active', status:'active'}, {storageKey:'bob_b', name:'Bob Jones', accessStatus:'active', status:'active'}])); true`);
  await send('Page.reload', {}, s); await sleep(2500);
  const C = []; const check = (n, c, d) => C.push({ n, c: !!c, d });
  await ev(`navigator.clipboard.writeText = async (t) => { window.__copied = t; }; openClientForm('alice_a'); true`);
  check('App login panel renders "No account yet"', await until(`/No account yet/.test(document.getElementById('cf-account-current').textContent)`), await ev(`document.getElementById('cf-account-current').textContent`));
  check('offers "Create invite link"', await ev(`/Create invite link/.test(document.getElementById('cf-account-buttons').textContent)`));
  await ev(`[...document.querySelectorAll('#cf-account-buttons button')].find(b=>/Create invite link/.test(b.textContent)).click(); true`);
  check('invite link created, copied and shown', await until(`/login\\/#invite=/.test(window.__copied||'') && !document.getElementById('cf-account-link-row').hidden`), await ev(`window.__copied||''`));
  check('status shows the pending invite with its expiry', await until(`/Invite sent — expires/.test(document.getElementById('cf-account-current').textContent)`), await ev(`document.getElementById('cf-account-current').textContent`));
  check('Copy + WhatsApp buttons available', await ev(`/Copy link/.test(document.getElementById('cf-account-buttons').textContent) && /WhatsApp/.test(document.getElementById('cf-account-buttons').textContent)`));
  const firstLink = await ev(`window.__copied`);
  await ev(`[...document.querySelectorAll('#cf-account-buttons button')].find(b=>/New invite link/.test(b.textContent)).click(); true`);
  check('"New invite link" replaces the old one (confirmed)', await until(`window.__copied && window.__copied !== ${JSON.stringify(firstLink)}`));
  const inspectOld = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ type: 'accountInviteInspect', token: firstLink.split('#invite=')[1] }) })).json();
  check('…and the old link stops working', inspectOld.error === 'invite_replaced', inspectOld);
  // client accepts → panel shows the active account
  const tok = (await ev(`window.__copied`)).split('#invite=')[1];
  await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ type: 'accountClaim', token: tok, email: 'alice@example.com', password: 'alicepass123' }) });
  await ev(`[...document.querySelectorAll('#cf-account-buttons button')].find(b=>/Refresh/.test(b.textContent)).click(); true`);
  check('after the client accepts: "Active — alice@example.com"', await until(`/Active — alice@example.com/.test(document.getElementById('cf-account-current').textContent)`), await ev(`document.getElementById('cf-account-current').textContent`));
  check('offers "Password reset link" (no second invite)', await ev(`/Password reset link/.test(document.getElementById('cf-account-buttons').textContent) && !/invite link/i.test(document.getElementById('cf-account-buttons').textContent)`));
  await ev(`[...document.querySelectorAll('#cf-account-buttons button')].find(b=>/Password reset link/.test(b.textContent)).click(); true`);
  check('reset link created + copied', await until(`/login\\/#reset=/.test(window.__copied||'')`), await ev(`window.__copied||''`));
  check('existing access panel still renders', await ev(`document.getElementById('cf-access-buttons').children.length > 0`));
  check('no page errors from the new panel', !errors.some((e) => /_acc|Account/.test(e)), errors.slice(0, 3));
  const pass = C.filter((c) => c.c).length;
  for (const c of C) console.log(`${c.c ? 'PASS' : 'FAIL'}  ${c.n}${c.c ? '' : '  ' + JSON.stringify(c.d)}`);
  console.log(`\ncoach_panel_e2e: ${pass}/${C.length} passed`);
  chrome.kill(); srv.close(); try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(pass === C.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
