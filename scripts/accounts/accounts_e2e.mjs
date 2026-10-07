// Client accounts V1 — end-to-end against REAL Supabase Auth (GoTrue) + the REAL api function.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const G = 'http://127.0.0.1:54400', API = G + '/functions/v1/api', AUTH = G + '/auth/v1';
const ANON = readFileSync(process.env.ACC_ANON_JWT_FILE, 'utf8').trim();
const COACH = createHash('sha256').update('coach-test').digest('hex');
const sh = (s) => createHash('sha256').update(s).digest('hex');
const sql = (q) => execFileSync('docker', ['exec', '-i', 'acc_db', 'psql', '-U', 'supabase_admin', '-h', 'localhost', '-d', 'postgres', '-tA', '-q', '-c', q]).toString().trim();
const api = async (body) => { const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }); return r.json(); };
const authPost = async (path, body, token) => { const r = await fetch(AUTH + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const login = (email, password) => authPost('/token?grant_type=password', { email, password });
const R = []; const check = (n, c, d) => R.push(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : '  ' + JSON.stringify(d).slice(0, 300)}`);

// ── seed two existing clients with data + legacy link tokens ────────────────
sql(`delete from client_device_tokens; delete from client_invites; delete from weight_logs; delete from client_sessions; delete from clients; delete from profiles; delete from auth.users;`);
const legacy = {};
for (const [key, name, kg] of [['alice_a', 'Alice Smith', 61], ['bob_b', 'Bob Jones', 92]]) {
  const pid = sql(`insert into profiles(full_name) values ('${name}') returning id`).split('\n')[0];
  const cid = sql(`insert into clients(profile_id, storage_key, display_name) values ('${pid}','${key}','${name}') returning id`).split('\n')[0];
  const tok = randomBytes(32).toString('hex'), salt = 'salt_' + key; legacy[key] = tok;
  sql(`insert into client_sessions(storage_key, client_id, token_hash, salt) values ('${key}','${cid}','${sh(tok + salt)}','${salt}')`);
  sql(`insert into weight_logs(client_id, client_key, weight_kg, notes) values ('${cid}','${key}',${kg},'${key} private')`);
}
const linkToken = (link) => link.split('#')[1].split('=').slice(1).join('=');

// 1. invite-only: public sign-up refused
const su = await authPost('/signup', { email: 'stranger@example.com', password: 'whatever123' });
check('public sign-up is disabled (invite-only)', su.status >= 400, su);

// 2. coach invites Alice; link carries the token in the fragment only
const inv = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'alice_a' });
check('coach issues invite link', inv.ok && /#invite=/.test(inv.link) && !/\?/.test(inv.link), inv);
check('only the hash is stored', sql(`select count(*) from client_invites where token_hash = '${sh(linkToken(inv.link))}'`) === '1' && !sql(`select string_agg(token_hash,'') from client_invites`).includes(linkToken(inv.link)));
const insp = await api({ type: 'accountInviteInspect', token: linkToken(inv.link) });
check('invite shows first name only', insp.ok && insp.firstName === 'Alice' && insp.purpose === 'invite' && !JSON.stringify(insp).includes('alice_a'), insp);
check('non-coach cannot issue invites', (await api({ type: 'accountInviteCreate', coachToken: 'nope', storageKey: 'alice_a' })).error === 'unauthorized');

// 3. claim: validation, then success, then single-use
check('weak password refused', (await api({ type: 'accountClaim', token: linkToken(inv.link), email: 'alice@example.com', password: 'short' })).error === 'password_too_short');
check('bad email refused', (await api({ type: 'accountClaim', token: linkToken(inv.link), email: 'nope', password: 'alicepass123' })).error === 'bad_email');
const claim = await api({ type: 'accountClaim', token: linkToken(inv.link), email: 'Alice@Example.com', password: 'alicepass123' });
check('Alice accepts invite → account created + linked to HER profile', claim.ok && sql(`select count(*) from profiles p join clients c on c.profile_id = p.id where c.storage_key='alice_a' and p.auth_user_id is not null and p.email='alice@example.com'`) === '1', claim);
check('invite link is single-use', (await api({ type: 'accountClaim', token: linkToken(inv.link), email: 'x@example.com', password: 'anotherpass1' })).error === 'invite_used');
check('second invite for a linked client refused (use reset)', (await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'alice_a' })).error === 'account_exists');

// Bob: resend replaces the first link; email collision refused
const b1 = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'bob_b' });
const b2 = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'bob_b' });
check('resend: the previous link stops working', (await api({ type: 'accountInviteInspect', token: linkToken(b1.link) })).error === 'invite_replaced');
check('an email already used by another client is refused', (await api({ type: 'accountClaim', token: linkToken(b2.link), email: 'alice@example.com', password: 'bobpass12345' })).error === 'email_in_use');
check('…and the link is still usable after that refusal', (await api({ type: 'accountClaim', token: linkToken(b2.link), email: 'bob@example.com', password: 'bobpass12345' })).ok);

// 4. login → device key → own data only
const la = await login('alice@example.com', 'alicepass123');
check('Alice logs in with email + password (Supabase Auth)', la.status === 200 && la.j.access_token && la.j.refresh_token, la);
const sa = await api({ type: 'accountSession', accessToken: la.j.access_token, deviceLabel: 'iPhone test' });
check('session → per-device key for HER client', sa.ok && sa.storageKey === 'alice_a' && sa.pagePath === 'clients/alice_a/' && sa.deviceToken, sa);
const lb = await login('bob@example.com', 'bobpass12345');
const sb = await api({ type: 'accountSession', accessToken: lb.j.access_token });
check('Bob gets a key for HIS client', sb.ok && sb.storageKey === 'bob_b', sb);
const wa = await api({ type: 'weightLog', token: sa.deviceToken, storageKey: 'alice_a' });
check('Alice reads her own weights with her device key', Array.isArray(wa) && wa.length === 1 && Number(wa[0].weightKg) === 61, wa);
const wx = await api({ type: 'weightLog', token: sa.deviceToken, storageKey: 'alice_a', client: 'bob_b' });
check('Alice naming Bob still only gets Alice (isolation fix)', Array.isArray(wx) && wx.every((r) => Number(r.weightKg) === 61), wx);
check('Alice\'s key does not open Bob\'s key', (await api({ type: 'weightLog', token: sa.deviceToken, storageKey: 'bob_b' })).error === 'bad_token');
check('Bob\'s key does not open Alice', (await api({ type: 'weightLog', token: sb.deviceToken, storageKey: 'alice_a' })).error === 'bad_token');
check('a forged / random key is refused', (await api({ type: 'weightLog', token: randomBytes(32).toString('base64url'), storageKey: 'alice_a' })).error === 'bad_token');
check('a bogus session cannot mint a key', (await api({ type: 'accountSession', accessToken: 'eyJhbGciOiJIUzI1NiJ9.e30.x' })).error === 'session_invalid');
check('device keys stored as hashes only', sql(`select count(*) from client_device_tokens where token_hash = '${sh(sa.deviceToken)}'`) === '1');

// 5. stays logged in: refresh token → new access token → new key (as the login page does on reopen)
const rf = await authPost('/token?grant_type=refresh_token', { refresh_token: la.j.refresh_token });
const s2 = await api({ type: 'accountSession', accessToken: rf.j.access_token });
check('refresh keeps Alice signed in (new key after reopen)', rf.status === 200 && s2.ok && s2.storageKey === 'alice_a', rf);
check('two devices both work', (await api({ type: 'authClient', token: s2.deviceToken, storageKey: 'alice_a' })).ok && (await api({ type: 'authClient', token: sa.deviceToken, storageKey: 'alice_a' })).ok);

// 6. logout revokes just that device
await api({ type: 'accountSignOut', token: s2.deviceToken, storageKey: 'alice_a' });
check('logout revokes that device key', (await api({ type: 'authClient', token: s2.deviceToken, storageKey: 'alice_a' })).ok === false);
check('…the other device stays signed in', (await api({ type: 'authClient', token: sa.deviceToken, storageKey: 'alice_a' })).ok);

// 7. password reset via coach-issued link
const rs = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'alice_a', purpose: 'reset' });
check('coach issues a reset link (24 h)', rs.ok && /#reset=/.test(rs.link) && (Date.parse(rs.expiresAt) - Date.now()) < 24.1 * 3600e3, rs);
const rc = await api({ type: 'accountClaim', token: linkToken(rs.link), password: 'newalicepass9' });
check('Alice sets a new password', rc.ok && rc.purpose === 'reset', rc);
check('old password no longer works', (await login('alice@example.com', 'alicepass123')).status >= 400);
check('new password works', (await login('alice@example.com', 'newalicepass9')).status === 200);
check('reset signs out every existing device', (await api({ type: 'authClient', token: sa.deviceToken, storageKey: 'alice_a' })).ok === false);

// 8. deactivate → everything stops; reactivate → login again
const lb2 = await login('bob@example.com', 'bobpass12345'); const sb2 = await api({ type: 'accountSession', accessToken: lb2.j.access_token });
await api({ type: 'setAccessStatus', coachToken: COACH, storageKey: 'bob_b', status: 'revoked' });
check('deactivate: Bob\'s device keys stop immediately', (await api({ type: 'weightLog', token: sb2.deviceToken, storageKey: 'bob_b' })).error === 'access_revoked');
check('deactivate: Bob cannot get a new key even with a valid login', (await api({ type: 'accountSession', accessToken: (await login('bob@example.com', 'bobpass12345')).j.access_token })).error === 'access_not_active');
check('deactivate: keys are revoked in the table too', sql(`select count(*) from client_device_tokens where storage_key='bob_b' and revoked_at is null`) === '0');
check('deactivate: no new invite/reset links', (await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'bob_b', purpose: 'reset' })).error === 'access_not_active');
await api({ type: 'setAccessStatus', coachToken: COACH, storageKey: 'bob_b', status: 'active' });
const sb3 = await api({ type: 'accountSession', accessToken: (await login('bob@example.com', 'bobpass12345')).j.access_token });
check('reactivate: Bob logs in again', sb3.ok && sb3.storageKey === 'bob_b', sb3);

// 9. expiry + transition
const ex = await api({ type: 'accountInviteCreate', coachToken: COACH, storageKey: 'bob_b', purpose: 'reset' });
sql(`update client_invites set expires_at = now() - interval '1 minute' where token_hash = '${sh(linkToken(ex.link))}'`);
check('expired link refused', (await api({ type: 'accountClaim', token: linkToken(ex.link), password: 'whatever123' })).error === 'invite_expired');
check('legacy link token still works during the transition', (await api({ type: 'authClient', token: legacy.alice_a, storageKey: 'alice_a' })).ok);

// 10. coach view
const list = await api({ type: 'accountList', coachToken: COACH });
const a = list.clients?.find((c) => c.storageKey === 'alice_a'), b = list.clients?.find((c) => c.storageKey === 'bob_b');
check('coach list: status per client, no secrets', list.ok && a.account === 'active' && a.email === 'alice@example.com' && b.activeDevices === 1 && !JSON.stringify(list).match(/token_hash|[0-9a-f]{64}/), list);
check('coach list refused without coach token', (await api({ type: 'accountList', coachToken: 'x' })).error === 'unauthorized');

console.log(R.join('\n')); console.log(`\n${R.filter((l) => l.startsWith('PASS')).length}/${R.length} passed`);
