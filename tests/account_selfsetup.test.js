// IN-APP LOGIN SETUP (2026-10-15) — accountSelfStatus / accountSelfSetup / accountLegacyAudit.
//
// Runs the REAL source of verifyClientToken, the account helpers and the three
// actions against an in-memory Supabase stand-in and a fake public-page fetch.
// No network, no real credentials: every key is random per run.
//
//   node tests/account_selfsetup.test.js
const ts = require('typescript');
const fs = require('fs');
const crypto = require('crypto');
const SRC = fs.readFileSync(process.env.SRC_FILE || 'supabase/functions/api/index.ts', 'utf8');

function grab(startRe, endMarker) {
  const i = SRC.search(startRe); if (i < 0) throw new Error('locate ' + startRe);
  const j = SRC.indexOf(endMarker, i); if (j < 0) throw new Error('terminate ' + startRe);
  return SRC.slice(i, j + endMarker.length);
}
const snippet = [
  grab(/async function verifyClientToken/, '\n}'),
  grab(/async function sha256\(/, '\n}'),
  grab(/const EMAIL_RE/, ';'),
  grab(/function passwordProblem/, '\n}'),
  grab(/async function accountTarget/, '\n}'),
  grab(/const PUBLIC_PAGE_BASE/, ';'),
  grab(/async function keyIsPublic/, '\n}'),
  grab(/async function accountSelfStatus/, '\n}'),
  grab(/async function accountSelfSetup/, '\n}'),
  grab(/async function accountLegacyAudit/, '\n}'),
].join('\n');
const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// ── in-memory Supabase stand-in ────────────────────────────────────────────
const DB = { clients: [], profiles: [], client_sessions: [], client_device_tokens: [], legacy_intake_queue: [] };
const USERS = []; let DELETED = [];
const match = (row, f) => f.every(([op, c, v]) => op === 'eq' ? row[c] === v : op === 'is' ? (row[c] ?? null) === v : true);
function table(name) {
  const q = { f: [], mode: 'select', patch: null, wantRows: false };
  const rows = () => DB[name].filter((r) => match(r, q.f));
  const api = {
    select() { q.wantRows = true; return api; },
    eq(c, v) { q.f.push(['eq', c, v]); return api; },
    is(c, v) { q.f.push(['is', c, v]); return api; },
    order() { return api; }, limit() { return api; },
    update(p) { q.mode = 'update'; q.patch = p; return api; },
    single: async () => { const d = rows()[0] ?? null; return { data: d, error: d ? null : { message: 'no rows' } }; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then(res) {
      if (q.mode === 'update') {
        if (name === 'profiles' && RACE.on) { RACE.on = false; rows().forEach((r) => { r.auth_user_id = 'someone_else'; }); }   // the other tap wins this row
        const hit = rows(); hit.forEach((r) => Object.assign(r, q.patch));
        return res({ data: q.wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null });
      }
      return res({ data: rows(), error: null });
    },
  };
  return api;
}
const RACE = { on: false };
const admin = {
  from: table,
  auth: { admin: {
    createUser: async ({ email }) => {
      if (USERS.some((u) => u.email === email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
      const u = { id: 'u_' + crypto.randomBytes(4).toString('hex'), email }; USERS.push(u); return { data: { user: u }, error: null };
    },
    deleteUser: async (id) => { DELETED.push(id); const i = USERS.findIndex((u) => u.id === id); if (i >= 0) USERS.splice(i, 1); return { error: null }; },
  } },
};
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const logEfError = () => {};
const COACH = crypto.randomBytes(16).toString('hex');
const verifyCoachToken = (t) => !!t && t === COACH;

// Fake public pages: what https://…/clients/<key>/ serves.
const PAGES = {}; const FETCHED = [];
const fetchImpl = async (url) => {
  FETCHED.push(url);
  const m = /\/clients\/([a-z0-9_]+)\/\?v=\d+$/.exec(url);
  if (!m || !(m[1] in PAGES)) return { ok: false, status: 404, text: async () => '' };
  if (PAGES[m[1]] === 'THROW') throw new Error('network');
  return { ok: true, status: 200, text: async () => PAGES[m[1]] };
};

const M = {};
new Function('admin', 'ok', 'err', 'json', 'logEfError', 'verifyCoachToken', 'fetch', 'exports',
  js + '\nObject.assign(exports,{accountSelfStatus,accountSelfSetup,accountLegacyAudit});'
)(admin, ok, err, json, logEfError, verifyCoachToken, fetchImpl, M);
const B = (r) => r.__body;

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 200) : '')); } };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── seed ───────────────────────────────────────────────────────────────────
const KEY = {};
function seed(key, { status = 'active', legacy = false, page = true, account = false } = {}) {
  KEY[key] = crypto.randomBytes(32).toString('hex');
  const salt = 's_' + crypto.randomBytes(4).toString('hex');
  DB.clients.push({ id: 'c_' + key, storage_key: key, display_name: key.toUpperCase(), profile_id: 'p_' + key, is_internal: false });
  DB.profiles.push({ id: 'p_' + key, auth_user_id: account ? 'u_existing_' + key : null, email: account ? key + '@x.co' : null });
  DB.client_sessions.push({ storage_key: key, client_id: 'c_' + key, token_hash: sha(KEY[key] + salt), salt, access_status: status, clients: { storage_key: key } });
  if (page) PAGES[key] = legacy
    ? `<script>const CLIENT_TOKEN_LEGACY = '${KEY[key]}'; // PENDING_TOKEN_ROTATION</script>`
    : '<html>a page with no key in it</html>';
}
seed('linked');                               // got a personal link: key is NOT public
seed('published', { legacy: true });          // still on the key printed in its public page
seed('rotated');                              // page prints an OLD key; the live one came by link
PAGES.rotated = `<script>const CLIENT_TOKEN_LEGACY = '${crypto.randomBytes(32).toString('hex')}';</script>`;
seed('nopage', { page: false });
seed('flaky'); PAGES.flaky = 'THROW';
seed('has_acct', { account: true });
seed('revoked', { status: 'revoked' });
seed('other');
DB.legacy_intake_queue.push({ client_key: 'published', received_at: '2026-10-14T01:00:00Z', reason: 'bad_token', status: 'pending' },
                            { client_key: 'published', received_at: '2026-10-15T01:00:00Z', reason: 'bad_token', status: 'pending' });

const st = async (key, tok = KEY[key]) => B(await M.accountSelfStatus({ storageKey: key, token: tok }));
const setup = async (key, extra = {}, tok = KEY[key]) => B(await M.accountSelfSetup({ storageKey: key, token: tok, email: key + '@mail.com', password: 'correct horse', ...extra }));
const linkedTo = (key) => DB.profiles.find((p) => p.id === 'p_' + key).auth_user_id;

(async () => {
  console.log('\n[S1] a phone signed in by a personal link sets up its login in the app');
  let r = await st('linked');
  t('status: no account, can set up', r.ok && r.account === 'none' && r.canSetup === true, r);
  t('status reads the client\'s own public page', FETCHED.at(-1).startsWith('https://omarsoubra.github.io/DASHBOARD/clients/linked/?v='));
  r = await setup('linked', { email: '  Linked@Mail.COM ' });
  t('setup ok, email normalised', r.ok && r.email === 'linked@mail.com', r);
  t('login created and linked to THIS client\'s profile', !!linkedTo('linked') && USERS.some((u) => u.id === linkedTo('linked') && u.email === 'linked@mail.com'));
  t('the existing key keeps working (not rotated)', (await st('linked')).ok === true);
  r = await st('linked');
  t('status afterwards: account active, nothing more to set up', r.account === 'active' && r.canSetup === false, r);
  t('a second setup is refused', (await setup('linked')).error === 'account_exists');

  console.log('\n[S2] a key printed in the public page proves nothing → personal invite instead');
  r = await st('published');
  t('status: cannot set up', r.ok && r.canSetup === false, r);
  const before = USERS.length;
  t('setup refused needs_invite', (await setup('published')).error === 'needs_invite');
  t('no login created', USERS.length === before && !linkedTo('published'));
  t('a page that prints an OLD dead key does not block the live linked key', (await st('rotated')).canSetup === true);

  console.log('\n[S3] fail closed when the public page cannot be checked');
  t('404 → cannot set up', (await st('nopage')).canSetup === false);
  t('404 → setup needs_invite', (await setup('nopage')).error === 'needs_invite');
  t('network error → needs_invite', (await setup('flaky')).error === 'needs_invite');

  console.log('\n[S4] identity is the verified key, never the named client');
  t('wrong key → bad_token', (await setup('other', {}, crypto.randomBytes(32).toString('hex'))).error === 'bad_token');
  t('another client\'s key for this client → bad_token', (await setup('other', {}, KEY.rotated)).error === 'bad_token');
  t('status without a key → refused', (await st('other', '')).error === 'missing_credentials');
  t('revoked access → refused', (await setup('revoked')).error === 'access_revoked');
  t('nothing linked to other / revoked', !linkedTo('other') && !linkedTo('revoked'));

  console.log('\n[S5] validation, duplicates and races');
  t('existing account → account_exists', (await setup('has_acct')).error === 'account_exists');
  for (const [x, code] of [[{ email: 'nope' }, 'bad_email'], [{ password: 'short' }, 'password_too_short'], [{ password: 'aaaaaaaaaa' }, 'password_too_weak'], [{ password: 123456789 }, 'password_required']])
    t(`${JSON.stringify(x)} → ${code}`, (await setup('other', x)).error === code);
  t('an email already used by another login → email_in_use', (await setup('rotated', { email: 'linked@mail.com' })).error === 'email_in_use');
  t('…and nothing linked', !linkedTo('rotated'));
  DELETED = []; RACE.on = true;
  const n = USERS.length;
  t('profile linked by a concurrent tap → account_exists', (await setup('rotated')).error === 'account_exists');
  t('…the half-made login is deleted (no orphan)', DELETED.length === 1 && USERS.length === n);
  DB.profiles.find((p) => p.id === 'p_rotated').auth_user_id = null;

  console.log('\n[S6] coach audit: who can set up in the app, who needs a link');
  t('coach token required', (B(await M.accountLegacyAudit({ coachToken: 'nope' }))).error === 'unauthorized');
  const a = B(await M.accountLegacyAudit({ coachToken: COACH }));
  const row = (k) => a.clients.find((c) => c.storageKey === k);
  t('published live key flagged', row('published').publishedKey && row('published').publishedKeyWorks);
  t('old printed key that no longer works: not flagged as working', row('rotated').publishedKey && !row('rotated').publishedKeyWorks);
  t('clean page: no published key', !row('other').publishedKey && !row('other').publishedKeyWorks);
  t('unreadable pages reported', row('nopage').pageReadable === false && row('flaky').pageReadable === false);
  t('account state', row('linked').account === 'active' && row('other').account === 'none', [row('linked'), row('other')].map((x) => x && x.account));
  t('token-less save attempts counted', row('published').tokenlessAttempts === 2 && row('published').lastTokenlessAt === '2026-10-15T01:00:00Z');
  const blob = JSON.stringify(a);
  t('audit output carries no key, hash or salt', !Object.values(KEY).some((k) => blob.includes(k)) && !DB.client_sessions.some((x) => blob.includes(x.token_hash) || blob.includes(x.salt)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
