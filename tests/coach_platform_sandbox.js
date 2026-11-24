// Coach Platform V1 - local sandbox. Serves this checkout's files plus the REAL coach platform handlers on an in-memory
// database, so the coach app and the build worker can be exercised end to end with nothing leaving the machine.
//   node tests/coach_platform_sandbox.js [port]         (default 8791)
//   POST /api                 the handlers (same body shape as the Edge Function)
//   GET  /sandbox/state       builds + clients, for test scripts
//   POST /sandbox/coach       {name, brand, email} -> setup link (what Omar's "add coach" does)
// Sandbox only: nothing here is a production credential.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { M, DB, OMAR, BUILDER_KEY } = require('./coach_platform_fixture.js');
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || process.argv[2] || 8791);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml' };
const read = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => res(b)); });
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api') {
      let body; try { body = JSON.parse(await read(req)); } catch { return send(res, 200, JSON.stringify({ ok: false, error: 'bad_json' })); }
      const fn = /^cp[A-Z]/.test(String(body?.type)) ? M[body.type] : null;
      if (!fn) return send(res, 200, JSON.stringify({ ok: false, error: 'unknown_type' }));
      return send(res, 200, JSON.stringify((await fn(body)).__body));
    }
    if (req.method === 'POST' && url.pathname === '/sandbox/coach') {
      const b = JSON.parse(await read(req));
      const r = (await M.cpCoachCreate({ coachToken: OMAR, ...b })).__body;
      if (r.ok) r.setupLink = r.setupLink.replace('https://omarsoubra.github.io/DASHBOARD', `http://localhost:${PORT}`);
      return send(res, 200, JSON.stringify(r));
    }
    if (url.pathname === '/sandbox/state') {
      return send(res, 200, JSON.stringify({ builds: DB.plan_builds.map((b) => ({ id: b.id, key: b.storage_key, status: b.status, error: b.error })),
        clients: DB.clients.map((c) => ({ key: c.storage_key, coach: c.coach_id, internal: c.is_internal })) }));
    }
    if (url.pathname === '/sandbox/builder-key') return send(res, 200, BUILDER_KEY, 'text/plain');
    if (url.pathname === '/login/config.js') {             // the login page talks to this sandbox, not to production
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'login/config.js'), 'utf8').replace(/apiUrl:\s*'[^']*'/, "apiUrl: '/api'"), TYPES['.js']);
    }
    let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) return send(res, 403, 'no', 'text/plain');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] || 'application/octet-stream');
  } catch (e) { send(res, 500, String(e), 'text/plain'); }
}).listen(PORT, '127.0.0.1', () => console.log(`coach platform sandbox on http://localhost:${PORT}/coach/`));
