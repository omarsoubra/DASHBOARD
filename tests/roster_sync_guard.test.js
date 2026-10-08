// ROSTER SYNC — fresh-device guard (2026-10-08)
//
// Incident: opening the live coach dashboard in a browser with no saved roster
// pushed the 28 hardcoded defaults (then defaults + registry) over the real
// roster, wiping revoked flags, review history and notes.
//
// Runs the REAL loadClients / saveClients / pushRoster / pullRoster /
// mergeAndPersistRegistry from coach_dashboard.html through the same order
// loadAll() uses (pull, then registry merge), against an in-memory roster store.
//
//   node tests/roster_sync_guard.test.js                       → checks the working tree
//   SRC_FILE=/path/to/coach_dashboard.html node tests/...      → checks another revision
const fs = require('fs');
const SRC = fs.readFileSync(process.env.SRC_FILE || 'coach_dashboard.html', 'utf8');
function grab(startRe, endMarker) {
  const i = SRC.search(startRe); if (i < 0) throw new Error('locate ' + startRe);
  const j = SRC.indexOf(endMarker, i); if (j < 0) throw new Error('terminate ' + startRe);
  return SRC.slice(i, j + endMarker.length);
}
const code = [
  grab(/const LS_CLIENTS\s+=/, ';'), grab(/const LS_CLIENTS_TS\s+=/, ';'), grab(/const LS_ROSTER_SYNCED\s+=/, ';'),
  grab(/function loadClients\(/, '\n}'), grab(/function saveClients\(/, '\n}'),
  grab(/async function pushRoster\(/, '\n}'), grab(/async function pullRoster\(/, '\n}'),
  grab(/async function mergeAndPersistRegistry\(/, '\n}'),
].join('\n');

const DEFAULTS = Array.from({ length: 28 }, (_, i) => ({ storageKey: 'legacy_' + i, name: 'Legacy ' + i }));
const REAL = DEFAULTS.map(c => ({ ...c })).concat(Array.from({ length: 29 }, (_, i) => ({ storageKey: 'client_' + i, programStatus: 'active', accessStatus: 'active', coachReviewHistory: [{ at: '2026-10-01' }] })));
['legacy_0', 'legacy_1', 'legacy_2', 'client_0'].forEach(k => { REAL.find(c => c.storageKey === k).accessStatus = 'revoked'; });
const REGISTRY = { clients: [{ storageKey: 'client_0' }, { storageKey: 'brand_new' }] };

function device({ local = null, cloud = [], rosterGetFails = false } = {}) {
  const store = new Map(Object.entries(local || {}));
  const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const server = { snapshots: cloud.map(s => ({ ...s })), puts: [] };
  const coachFetch = async (type, body) => {
    if (type === 'rosterGet') {
      if (rosterGetFails) throw new Error('network');
      const last = server.snapshots[server.snapshots.length - 1];
      return last ? { ok: true, ts: last.ts, roster: JSON.parse(JSON.stringify(last.roster)) } : { ok: true, ts: 0, roster: [] };
    }
    if (type === 'rosterPut') { server.puts.push(body); server.snapshots.push({ ts: body.ts, roster: JSON.parse(JSON.stringify(body.roster)) }); return { ok: true }; }
    throw new Error('unexpected ' + type);
  };
  // registry merge stand-in: appends registry entries missing from the roster (as the real merge does for new programs)
  const mergeRegistryIntoRoster = (before, reg) => {
    const list = before.map(c => ({ ...c })); const added = [];
    for (const r of reg.clients) if (!list.some(c => c.storageKey === r.storageKey)) { list.push({ storageKey: r.storageKey, programStatus: 'onboarding', accessStatus: 'active' }); added.push(r.storageKey); }
    return { list, added, updated: [], missing: [] };
  };
  const COACH = { webhookUrl: 'https://api.example/fn', defaultClients: DEFAULTS, clients: [] };
  const _coachToken = () => 'coach-test-token';
  const M = {};
  new Function('localStorage', 'coachFetch', 'COACH', '_coachToken', 'mergeRegistryIntoRoster', 'console', 'M',
    code + '\nObject.assign(M,{loadClients,saveClients,pushRoster,pullRoster,mergeAndPersistRegistry});'
  )(localStorage, coachFetch, COACH, _coachToken, mergeRegistryIntoRoster, { warn() {}, info() {} }, M);
  // page boot: the first render reads COACH.clients (a loadClients() getter), then
  // loadAll() runs pull + registry fetch in parallel and merges
  const boot = async () => { M.loadClients(); await M.pullRoster().catch(() => false); await M.mergeAndPersistRegistry(REGISTRY); await new Promise(r => setTimeout(r, 0)); };
  return { M, server, localStorage, boot };
}

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 200) : '')); } };
const revoked = r => r.filter(c => c.accessStatus === 'revoked').length;
const reviewed = r => r.filter(c => (c.coachReviewHistory || []).length).length;
const latest = s => s.snapshots[s.snapshots.length - 1].roster;
const CLOUD = [{ ts: Date.parse('2026-10-08T01:23:00Z'), roster: REAL }];

(async () => {
  console.log('\n[R1] FRESH DEVICE, real roster in the cloud');
  { const d = device({ cloud: CLOUD }); await d.boot();
    t('never pushes the 28 seeded defaults', !d.server.puts.some(p => p.roster.length === 28), d.server.puts.map(p => p.roster.length));
    t('every push keeps all revoked flags + review history', d.server.puts.every(p => revoked(p.roster) === 4 && reviewed(p.roster) === 29), d.server.puts.map(p => [revoked(p.roster), reviewed(p.roster)]));
    t('cloud still has the real roster (+ the new registry program)', latest(d.server).length === 58 && revoked(latest(d.server)) === 4 && reviewed(latest(d.server)) === 29, latest(d.server).length);
    t('device adopted the cloud roster', revoked(d.M.loadClients()) === 4 && reviewed(d.M.loadClients()) === 29); }

  console.log('\n[R2] FRESH DEVICE, cloud unreachable on boot');
  { const d = device({ cloud: CLOUD, rosterGetFails: true }); await d.boot();
    t('nothing is pushed until the device has synced', d.server.puts.length === 0, d.server.puts.map(p => p.roster.length));
    d.M.saveClients(d.M.loadClients()); await d.M.pushRoster();
    t('an edit before the first sync is not pushed either', d.server.puts.length === 0);
    t('cloud roster untouched', latest(d.server) === CLOUD[0].roster || (latest(d.server).length === 57 && revoked(latest(d.server)) === 4)); }

  console.log('\n[R3] FRESH DEVICE, empty cloud (brand-new system)');
  { const d = device({ cloud: [] }); await d.boot();
    t('device seeds the empty cloud', d.server.puts.length >= 1 && latest(d.server).length >= 28, d.server.puts.map(p => p.roster.length)); }

  console.log('\n[R4] SYNCED DEVICE — existing behaviour unchanged');
  { const T = CLOUD[0].ts;
    const synced = (roster, ts) => ({ coach_clients_v1: JSON.stringify(roster), coach_clients_v1_ts: String(ts), coach_clients_v1_synced_ts: String(T) });
    const edited = REAL.map(c => ({ ...c })); edited[5].coachNotes = 'new note';
    let d = device({ local: synced(edited, T + 60000), cloud: CLOUD }); await d.M.pullRoster(); await new Promise(r => setTimeout(r, 0));
    t('local newer → pushes local', d.server.puts.length === 1 && latest(d.server)[5].coachNotes === 'new note');
    d = device({ local: synced(REAL.slice(0, 50), T - 60000), cloud: CLOUD }); const changed = await d.M.pullRoster();
    t('cloud newer → adopts cloud, no push', changed === true && d.M.loadClients().length === 57 && d.server.puts.length === 0);
    d = device({ local: synced(REAL, T), cloud: CLOUD }); await d.M.pullRoster();
    t('tie → no change, no push', d.server.puts.length === 0);
    d = device({ local: synced(REAL, T), cloud: CLOUD }); const l = d.M.loadClients(); l[0].coachNotes = 'x'; d.M.saveClients(l); await d.M.pushRoster();
    t('coach edit on a synced device pushes', d.server.puts.length === 1 && latest(d.server)[0].coachNotes === 'x'); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
