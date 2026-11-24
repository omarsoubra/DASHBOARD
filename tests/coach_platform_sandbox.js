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
const FULL = require('./coach_platform_full.js');     // the whole Edge Function, so the real coach dashboard runs here too
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
      return send(res, 200, JSON.stringify(await FULL.call(body)));
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
    if (url.pathname === '/sandbox/seed') {                // a demo coach with clients in every state, to look at the screens
      const seedFile = path.join(ROOT, '..', 'seed_build.json');
      if (!fs.existsSync(seedFile)) return send(res, 200, JSON.stringify({ ok: false, error: 'no_seed_build' }));
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      const crypto = require('crypto'), DAY = 86400000, iso = (d) => new Date(Date.now() + d * DAY).toISOString();
      const token = crypto.randomBytes(32).toString('base64url'), had = DB.coaches.find((c) => c.slug === 'demo'), coachId = had ? had.id : crypto.randomUUID();
      DB.coach_sessions.push({ id: 9000 + DB.coach_sessions.length, coach_id: coachId, token_hash: crypto.createHash('sha256').update(token).digest('hex'), expires_at: iso(30), revoked_at: null });
      if (had) return send(res, 200, JSON.stringify({ ok: true, session: token }));
      DB.coaches.push({ id: coachId, slug: 'demo', name: 'Demo Coach', brand: 'Demo Coaching', email: 'demo@example.test', status: 'active', client_limit: 25, accent: null, logo: null });
      const add = (first, startDays, weeks, o) => {
        const key = 'c_demo_' + first.toLowerCase() + '_tester', id = crypto.randomUUID();
        DB.clients.push({ id, storage_key: key, display_name: first + ' Tester', start_weight: 88, goal_weight: 76.9, start_date: iso(startDays).slice(0, 10), coach_id: coachId, is_internal: true, profile_id: null, program_url: null });
        DB.client_sessions.push({ storage_key: key, access_status: 'active', last_access_at: o.opened ? iso(-1) : null });
        DB.plan_builds.push({ id: crypto.randomUUID(), coach_id: coachId, storage_key: key, is_update: false, status: 'live', form: { ...seed.form, firstName: first, startDate: iso(startDays).slice(0, 10), weeks },
          summary: { ...seed.summary, storageKey: key, firstName: first, name: first + ' Tester', weeks }, plan: seed.plan, error: null, created_at: iso(startDays - 1), updated_at: iso(startDays - 1), published_at: iso(startDays - 1) });
        for (let d = -startDays; d >= (o.lastLog ?? 0) && o.logs; d -= 2) {
          const day = d;    // days ago
          DB.weight_logs.push({ client_key: key, logged_at: iso(-day), weight_kg: Math.round((88 - (-startDays - day) * 0.09 + Math.sin(day) * 0.4) * 10) / 10 });
          DB.workout_log_entries.push({ client_key: key, logged_at: iso(-day), exercise_name: 'Barbell Bench Press', weight: 80, sets_done: 3, reps_done: 8, phase_key: '1', day_index: 0 });
          DB.meal_logs.push({ client_id: id, logged_at: iso(-day), meal_name: 'Chicken Rice Bowl', kcal: 620, protein_g: 48 }, { client_id: id, logged_at: iso(-day), meal_name: 'Peanut Butter Oats', kcal: 540, protein_g: 32 });
        }
        (o.checkins || []).forEach((ago, i) => DB.check_ins.push({ client_key: key, submitted_at: iso(-ago), week_number: Math.max(1, Math.round((-startDays - ago) / 7)), weight_kg: 85.2 - i * 0.6,
          energy_1to10: 7, sleep_hours: 7, stress_1to10: 4, diet_adherence_1to10: 8, training_adherence_1to10: 9, notes: i ? 'Good week, hit every session.' : 'Felt flat on leg day, weekend was off plan.' }));
        return key;
      };
      add('Sam', -72, 12, { opened: true, logs: true, lastLog: 1, checkins: [1, 8, 15] });     // new check-in + plan ending
      add('Leo', -30, 12, { opened: true, logs: true, lastLog: 10, checkins: [12] });         // gone quiet
      add('Mia', -6, 12, { opened: false, logs: false });                                      // never opened
      add('Zoe', -20, 16, { opened: true, logs: true, lastLog: 0, checkins: [2] });            // fine once the check-in is read
      const zoe = DB.plan_builds.find((b) => b.storage_key === 'c_demo_zoe_tester');
      DB.plan_builds.push({ ...zoe, id: crypto.randomUUID(), is_update: true, status: 'built', created_at: iso(0), updated_at: iso(0), published_at: null });   // a plan update waiting for review
      return send(res, 200, JSON.stringify({ ok: true, session: token }));
    }
    if (url.pathname === '/sandbox/schema') {              // the Drafted schema file, readable by a browser tab on another origin
      const f = path.join(ROOT, '..', 'drafted', 'drafted_schema.sql');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
      return res.end(fs.existsSync(f) ? fs.readFileSync(f) : '');
    }
    if (url.pathname === '/sandbox/builder-key') return send(res, 200, BUILDER_KEY, 'text/plain');
    if (url.pathname === '/login/config.js') {             // the login page talks to this sandbox, not to production
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'login/config.js'), 'utf8').replace(/apiUrl:\s*'[^']*'/, "apiUrl: '/api'"), TYPES['.js']);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(302, { Location: '/coach/' }); return res.end(); }   // never serve Omar's own dashboard here
    let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!p.startsWith(ROOT)) return send(res, 403, 'no', 'text/plain');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] || 'application/octet-stream');
  } catch (e) { send(res, 500, String(e), 'text/plain'); }
}).listen(PORT, '127.0.0.1', () => console.log(`coach platform sandbox on http://localhost:${PORT}/coach/`));
