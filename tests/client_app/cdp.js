// Minimal Chrome DevTools Protocol driver - no dependencies (Node >= 22 has a global WebSocket).
// Launches the locally installed Chrome headless with a throwaway profile; never touches the user's profile.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const p = CHROME_PATHS.find(x => { try { return fs.statSync(x).isFile(); } catch (e) { return false; } });
  if (!p) throw new Error('Chrome not found. Set CHROME_PATH.');
  return p;
}

class Conn {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        this.listeners.forEach(l => l(m.method, m.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.listeners.push(fn); }
  once(method, timeoutMs = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for ' + method)), timeoutMs);
      const fn = (m, p) => { if (m === method) { clearTimeout(t); this.listeners = this.listeners.filter(x => x !== fn); res(p); } };
      this.listeners.push(fn);
    });
  }
}

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbo-app-test-'));
  const proc = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--window-size=390,844', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } });
    proc.on('exit', c => rej(new Error('Chrome exited ' + c)));
  });
  const port = new URL(wsUrl).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageWs = list.find(t => t.type === 'page').webSocketDebuggerUrl;
  const ws = new WebSocket(pageWs);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const c = new Conn(ws);
  const close = () => { try { ws.close(); } catch (e) {} try { proc.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
  return { c, close };
}

class Page {
  constructor(c) { this.c = c; this.errors = []; this.initIds = []; }
  async init() {
    const c = this.c;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
    await c.send('Emulation.setTimezoneOverride', { timezoneId: 'Australia/Sydney' });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    c.on((m, p) => {
      if (m === 'Runtime.exceptionThrown') this.errors.push('exception: ' + ((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text).split('\n')[0]);
      if (m === 'Runtime.consoleAPICalled' && p.type === 'error') this.errors.push('console.error: ' + p.args.map(a => a.value != null ? a.value : a.description).join(' ').slice(0, 200));
    });
  }
  async addInit(source) { const r = await this.c.send('Page.addScriptToEvaluateOnNewDocument', { source }); this.initIds.push(r.identifier); }
  async clearInits() { for (const id of this.initIds) await this.c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }); this.initIds = []; }
  async goto(url) { const ld = this.c.once('Page.loadEventFired'); await this.c.send('Page.navigate', { url }); await ld; }
  async reload() { const ld = this.c.once('Page.loadEventFired'); await this.c.send('Page.reload', {}); await ld; }
  async eval(expr) {
    const r = await this.c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  }
}

module.exports = { launch, Page };
