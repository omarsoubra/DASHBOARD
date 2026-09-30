#!/usr/bin/env node
// Workout Completion V1 — headless-Chrome test of a THROWAWAY shell copy.
//
//   node scripts/workouts/browser_e2e.js PATCHED.html UNPATCHED.html STORAGE_KEY
//
// The shells are served from 127.0.0.1; EVERY *.supabase.co request is
// intercepted and answered locally by the REAL api handlers
// (tests/workout_completion_sandbox.js) — nothing reaches production.
// "Offline" is simulated by failing the intercepted request.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../tests/workout_completion_sandbox');

const [, , PATCHED, UNPATCHED, KEY] = process.argv;
const ROOT = path.join(__dirname, '..', '..');
const TOKEN = 'e2e-token-' + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── backend: the real handlers + one canary client ─────────────────────────
S.seed();
const db = S.db();
db.clients.push({ id: 'c_canary', storage_key: KEY, entitlement_legacy: false });
db.client_sessions.push({ client_id: 'c_canary', storage_key: KEY, token_hash: S.sha(TOKEN + 'salt_c'), salt: 'salt_c', access_status: 'active' });
db.client_entitlements.push({ id: 'e_c', client_id: 'c_canary', product_code: 'locked_in_1to1', status: 'active', starts_at: null, ends_at: null });
const canaryRows = () => db.workout_completions.filter((r) => r.client_id === 'c_canary');

// ── static server ──────────────────────────────────────────────────────────
let SHELL = PATCHED;
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = null;
  if (u === `/clients/${KEY}/` || u === `/clients/${KEY}/index.html`) f = SHELL;
  else if (u === '/sw.js' || u === '/push-client.js') f = path.join(ROOT, u);
  if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => srv.listen(9931, '127.0.0.1', r));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-e2e-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=9933', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9933/json/version')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const handlers = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else handlers.forEach((h) => h(d)); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const R = { checks: [], errors: [], dialogs: [], apiCalls: [], workoutWrites: { patched: [], unpatched: [] } };
  const check = (name, cond, detail) => R.checks.push({ name, pass: !!cond, ...(detail !== undefined ? { detail } : {}) });
  let OFFLINE = false, MODE = 'patched', ACCEPT_DIALOGS = true;

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  handlers.push(async (d) => {
    if (d.sessionId !== s) return;
    if (d.method === 'Runtime.exceptionThrown') R.errors.push((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text);
    if (d.method === 'Page.javascriptDialogOpening') {
      R.dialogs.push(d.params.message);
      send('Page.handleJavaScriptDialog', { accept: ACCEPT_DIALOGS }, s).catch(() => {});
    }
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params;
      if (OFFLINE) return send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }, s).catch(() => {});
      let body = request.method === 'GET' ? '{}' : '{"ok":true}';
      if (/\/functions\/v1\/api/.test(request.url) && request.method === 'POST') {
        const b = JSON.parse(request.postData || '{}');
        R.apiCalls.push(b.type);
        if (b.type === 'workoutComplete') body = JSON.stringify(S.B(await S.M.workoutComplete(b)));
        else if (b.type === 'workoutCompleteUndo') body = JSON.stringify(S.B(await S.M.workoutCompleteUndo(b)));
        else if (b.type === 'workoutCompletionsGet') body = JSON.stringify(S.B(await S.M.workoutCompletionsGet(b)));
        else if (b.type === 'workout') {
          const { timestamp, clientRef, token, ...rest } = b;
          R.workoutWrites[MODE].push(rest);
          body = JSON.stringify({ ok: true, tab: 'workout_log_entries', id: 'row_' + R.workoutWrites[MODE].length });
        } else if (b.type === 'authClient') body = JSON.stringify({ ok: true, storageKey: KEY, accessStatus: 'active' });
      } else if (/\/functions\/v1\/push/.test(request.url)) body = '{"ok":false,"error":"push_not_enabled"}';
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, s);
    }
  });
  await send('Runtime.enable', {}, s);
  await send('Page.enable', {}, s);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co*' }] }, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  const setToken = (t) => `try { localStorage.setItem('${KEY}_access_token', '${t}'); } catch (e) {}`;
  const tokScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: setToken(TOKEN) }, s);
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s); if (r.exceptionDetails) throw new Error(expr.slice(0, 60) + ': ' + (r.exceptionDetails.exception || {}).description); return r.result.value; };
  const load = async () => { await send('Page.navigate', { url: `http://127.0.0.1:9931/clients/${KEY}/` }, s); await sleep(3000); await ev(`(showSection('training'), true)`); await sleep(600); };
  const doneText = () => ev(`(document.getElementById('tv2-done')||{}).innerText || ''`);
  const workText = () => ev(`(document.getElementById('tv2-workout')||{}).innerText || ''`);
  const ledger = () => ev(`JSON.parse(localStorage.getItem('${KEY}_workout_sessions') || '{}')`);
  const wcOf = async (di) => { const L = await ledger(); const ss = L['p1.d' + di] || []; return ss.length ? ss[ss.length - 1].wc || null : null; };
  const logExercise = async (i) => {             // log every prescribed set of exercise i through the real UI path
    const n = await ev(`(function(){ var el=document.querySelectorAll('#tv2-workout .tv2-set'); return el.length; })()`);
    for (let k = 0; k < n; k++) {
      await ev(`(function(){ var w=document.getElementById('tv2-w${k}'), r=document.getElementById('tv2-r${k}'); if(w){w.value='60';} if(r){r.value='8';} tv2LogSet(${k}); return true; })()`);
      await sleep(150);
    }
  };

  try {
    // ── A. patched shell ────────────────────────────────────────────────────
    await load();
    check('Training V2 home rendered', /Training|Day/.test(await ev(`document.getElementById('tv2-home').innerText`)));

    // A1 zero-log finish on a fresh sheet
    await ev(`(tv2Open(0), true)`); await sleep(400);
    check('fresh sheet shows Finish workout', /Finish workout/i.test(await workText()));
    await ev(`(tv2Finish(), true)`); await sleep(1500);
    check('zero-log confirmation text', R.dialogs.includes('No exercises have been logged. Mark this workout as completed?'), R.dialogs.slice(-1)[0]);
    check('server: exactly one completion after zero-log finish', canaryRows().length === 1);
    check('UI: ✓ Workout completed', /✓ Workout completed/i.test(await doneText()));
    const w0 = await wcOf(0);
    check('ledger holds the ref + synced state', w0 && /^cmp_/.test(w0.ref) && w0.state === 'synced');
    check('server row matches the stated session', canaryRows()[0].phase_key === '1' && canaryRows()[0].day_index === 0 && canaryRows()[0].exercises_logged === 0);

    // A2 double tap: two synchronous calls on a new occurrence
    await ev(`(tv2Open(1), true)`); await sleep(300);
    const before2 = canaryRows().length;
    await ev(`(tv2Finish(), tv2Finish(), true)`); await sleep(1500);
    check('double tap → one new server row', canaryRows().length === before2 + 1, canaryRows().length - before2);

    // A3 refresh restores completed state, sends nothing new
    const callsBefore = R.apiCalls.filter((t) => t === 'workoutComplete').length;
    await load(); await ev(`(tv2OpenSession(0, 1), true)`); await sleep(500);
    check('after reload: day 1 summary still shows ✓ Workout completed', /✓ Workout completed/i.test(await doneText()));
    check('reload re-sent nothing', R.apiCalls.filter((t) => t === 'workoutComplete').length === callsBefore);
    check('reload did not duplicate rows', canaryRows().length === before2 + 1);

    // A3b the same workout again later → a NEW occurrence, new ref, new row; the older
    //     occurrence is history: it shows its completion and never offers Finish again
    const beforeAgain = canaryRows().length;
    await ev(`(tv2Open(1), true)`); await sleep(300);
    check('day already done → fresh sheet for the next occurrence', /Finish workout/i.test(await workText()));
    await ev(`(tv2Finish(), true)`); await sleep(1500);
    const d1 = (await ledger())['p1.d1'] || [];
    check('same workout later → second occurrence, second row, different refs', canaryRows().length === beforeAgain + 1 && d1.length === 2 && d1[0].wc.ref !== d1[1].wc.ref);
    await ev(`(tv2OpenSession(1, 1), true)`); await sleep(400);
    const histTxt = await doneText();
    check('history occurrence: shows ✓, never offers Finish', /✓ Workout completed/i.test(histTxt) && !/Finish workout/i.test(histTxt), histTxt.slice(0, 200));

    // A4 partial-log finish with confirmation
    await ev(`(tv2Open(2), true)`); await sleep(400);
    await logExercise(0); await sleep(600);
    const pr = await ev(`(function(){ var t=document.querySelector('#tv2-workout .tv2-count'); return t ? t.innerText : ''; })()`);
    await ev(`(tv2Finish(), true)`); await sleep(1500);
    const partialMsg = R.dialogs.slice(-1)[0] || '';
    check('partial-log confirmation text', /^Finish workout with 1 of \d+ exercises logged\?$/.test(partialMsg), partialMsg + ' | header ' + pr);
    const partialRow = canaryRows()[canaryRows().length - 1];
    check('partial completion recorded with its counts', partialRow.day_index === 2 && partialRow.exercises_logged === 1 && partialRow.sets_logged > 0, { logged: partialRow.exercises_logged, sets: partialRow.sets_logged });
    check('rx fingerprint sent (sha256)', /^[0-9a-f]{64}$/.test(partialRow.rx_fingerprint || ''));

    // A5 cancelling the confirmation creates nothing
    await ev(`(tv2Open(3), true)`); await sleep(300);
    ACCEPT_DIALOGS = false; const beforeC = canaryRows().length;
    await ev(`(tv2Finish(), true)`); await sleep(800); ACCEPT_DIALOGS = true;
    check('cancel → no row, no local completion', canaryRows().length === beforeC && !(await wcOf(3)));

    // A6 offline finish → pending → survives reload → syncs once when online
    OFFLINE = true; const beforeO = canaryRows().length;
    await ev(`(tv2Finish(), true)`); await sleep(1800);
    const wOff = await wcOf(3);
    check('offline: saved on this phone (pending), no server row', wOff && wOff.state === 'pending' && canaryRows().length === beforeO, wOff && wOff.state);
    check('offline UI message', /saved on this phone/i.test(await doneText()));
    await load();                                   // app restart while still offline
    const wOff2 = await wcOf(3);
    check('restart while offline keeps the SAME ref, still pending', wOff2 && wOff2.ref === wOff.ref && wOff2.state === 'pending');
    OFFLINE = false;
    await ev(`(window.dispatchEvent(new Event('online')), true)`); await sleep(1500);
    await ev(`(window.dispatchEvent(new Event('online')), true)`); await sleep(1500);   // a second online event must not duplicate
    check('back online → synced once', canaryRows().length === beforeO + 1 && (await wcOf(3)).state === 'synced');
    check('server row carries the offline ref', canaryRows().some((r) => r.completion_ref === wOff.ref));

    // A7 undo (latest, < 24 h) → revoked, kept; finish again → new ref
    await ev(`(tv2OpenSession(3, 1), true)`); await sleep(400);
    check('undo offered on the latest completion', /Undo completion/i.test(await doneText()));
    await ev(`(tv2FinishUndo(), true)`); await sleep(1500);
    const revoked = canaryRows().find((r) => r.completion_ref === wOff.ref);
    check('undo → server row revoked, not deleted', revoked && revoked.status === 'revoked' && revoked.revoked_by === 'client');
    check('UI shows Completion undone + Finish again', /Completion undone/i.test(await doneText()) && /Finish workout/i.test(await doneText()));
    const beforeR = canaryRows().length;
    await ev(`(tv2Finish(), true)`); await sleep(1500);
    const again = await wcOf(3);
    check('finish again → NEW ref, new row; revoked row kept in audit', canaryRows().length === beforeR + 1 && again.ref !== wOff.ref && (await ledger())['p1.d3'].slice(-1)[0].wcPast.length === 1);
    check('older completion shows no undo', !/Undo completion/i.test((await ev(`(tv2OpenSession(0, 1), document.getElementById('tv2-done').innerText)`)) || ''));

    // A8 wrong token → rejected (not transient), nothing written
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: tokScript.identifier }, s);
    await ev(`(localStorage.setItem('${KEY}_access_token', 'not-the-token'), true)`);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `/* token left as set */` }, s);
    await load(); await ev(`(tv2Open(4), true)`); await sleep(300);
    const beforeT = canaryRows().length;
    await ev(`(tv2Finish(), true)`); await sleep(1500);
    const wt = await wcOf(4);
    check('wrong token → error state, no row', wt && wt.state === 'error' && wt.err === 'bad_token' && canaryRows().length === beforeT, wt && wt.err);
    check('error shown to the client', /could not be recorded/i.test(await doneText()));

    // ── B. exercise logging parity: identical actions on the UNPATCHED copy ──
    const patchedWrites = R.workoutWrites.patched.slice();
    MODE = 'unpatched'; SHELL = UNPATCHED;
    await ev(`(localStorage.clear(), true)`);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: setToken(TOKEN) }, s);
    await load(); await ev(`(tv2Open(2), true)`); await sleep(400); await logExercise(0); await sleep(800);
    const norm = (a) => JSON.stringify(a.map((x) => ({ ...x, storageKey: undefined, client: undefined })));
    check('exercise-log writes identical (patched vs unpatched, same actions)', patchedWrites.length > 0 && norm(patchedWrites) === norm(R.workoutWrites.unpatched),
      { patched: patchedWrites.length, unpatched: R.workoutWrites.unpatched.length });
    check('unpatched shell has no Finish workout', !/Finish workout/i.test(await workText() + await doneText()));
  } catch (e) { R.errors.push('driver: ' + e.message); }

  R.serverRows = canaryRows().map((r) => ({ ref: r.completion_ref.slice(0, 12) + '…', phase: r.phase_key, day: r.day_index, kind: r.session_kind, logged: r.exercises_logged, status: r.status }));
  R.pass = R.checks.filter((c) => c.pass).length; R.fail = R.checks.length - R.pass;
  console.log(JSON.stringify(R, null, 1));
  ws.close(); chrome.kill('SIGTERM'); srv.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(R.fail || R.errors.length ? 1 : 0);
})();
