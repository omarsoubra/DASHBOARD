// LOCKED IN Push Notifications — MINIMAL PROOF test suite.
//
// 0 production invocations. Runs the REAL shipped source:
//   supabase/functions/push/webpush.ts   (transpiled with typescript)
//   supabase/functions/push/handler.ts   (transpiled with typescript)
//   sw.js                                 (executed in a vm sandbox)
// against:
//   * an in-memory Supabase stand-in whose tables/columns are parsed from the
//     push migration — an unknown column is an error, so handler ↔ schema drift fails here;
//   * a fake push service that DECRYPTS every message with node:crypto (an
//     implementation independent of the WebCrypto sender) and VERIFIES the
//     VAPID JWT signature, audience and expiry;
//   * the RFC 8291 Appendix A known-answer vector.
//
// Usage (from the DASHBOARD repo root):   node tests/push_proof.test.js
// Shared stand-in, fixtures and fake push service: tests/push_harness.js
'use strict';
const vm = require('vm');
const nodeCrypto = require('crypto');
const { execSync } = require('child_process');
const {
  ROOT, rd, WP, H, test, assert, eq, run, b64u, unb64u, sha256hex, MIGRATION,
  CANARY, OTHER, CANARY_TOKEN, OTHER_TOKEN, SECOND_TOKEN, COACH_HASH,
  makeVapid, makeBrowserSub, nodeDecrypt, verifyVapidHeader, world, assertNoLeak,
} = require('./push_harness');


// ════════════════════════════════════════════════════════════════════════════
// A. Crypto — RFC vectors and independent verification
// ════════════════════════════════════════════════════════════════════════════
test('A1 RFC 8291 Appendix A: byte-exact aes128gcm body', async () => {
  const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  const out = await WP.encryptPayload(
    new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    unb64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    unb64u('BTBZMqHH6r4Tts7J_aSIgg'),
    {
      senderPrivateRaw: unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      senderPublicRaw: unb64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
      salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    });
  eq(b64u(out), expected, 'RFC 8291 §5 body');
});

test('A2 random payloads decrypt with the independent node:crypto receiver', async () => {
  for (let i = 0; i < 25; i++) {
    const s = makeBrowserSub();
    const msg = JSON.stringify({ i, pad: 'x'.repeat(i * 97) });
    const body = await WP.encryptPayload(new TextEncoder().encode(msg), s.ecdh.getPublicKey(), s.auth);
    eq(nodeDecrypt(Buffer.from(body), s.ecdh, s.auth), msg, 'round-trip ' + i);
  }
});

test('A3 fresh salt + ephemeral key per message', async () => {
  const s = makeBrowserSub();
  const p = new TextEncoder().encode('same');
  const a = Buffer.from(await WP.encryptPayload(p, s.ecdh.getPublicKey(), s.auth));
  const b = Buffer.from(await WP.encryptPayload(p, s.ecdh.getPublicKey(), s.auth));
  assert(!a.subarray(0, 16).equals(b.subarray(0, 16)), 'salt differs');
  assert(!a.subarray(21, 86).equals(b.subarray(21, 86)), 'sender key differs');
});

test('A4 encryption rejects bad receiver keys / auth / oversize payload', async () => {
  const s = makeBrowserSub();
  const bad = async (fn, label) => { let threw = false; try { await fn(); } catch { threw = true; } assert(threw, label); };
  await bad(() => WP.encryptPayload(new Uint8Array(3), new Uint8Array(65), s.auth), 'all-zero point');
  await bad(() => WP.encryptPayload(new Uint8Array(3), s.ecdh.getPublicKey().subarray(0, 64), s.auth), 'short point');
  const offCurve = Buffer.from(s.ecdh.getPublicKey()); offCurve[64] ^= 1;
  await bad(() => WP.encryptPayload(new Uint8Array(3), offCurve, s.auth), 'off-curve point');
  await bad(() => WP.encryptPayload(new Uint8Array(3), s.ecdh.getPublicKey(), s.auth.subarray(0, 8)), 'short auth');
  await bad(() => WP.encryptPayload(new Uint8Array(WP.MAX_PAYLOAD_BYTES + 1), s.ecdh.getPublicKey(), s.auth), 'oversize');
});

test('A5 VAPID: JWT verifies with node:crypto; mismatched keypair refused', async () => {
  const v = await makeVapid();
  const keys = await WP.importVapidKeys(v.publicB64, v.privateB64, 'mailto:coach@example.com');
  const nowSec = 1_800_000_000;
  const jwt = await WP.createVapidJwt('https://web.push.apple.com', keys, nowSec);
  verifyVapidHeader(`vapid t=${jwt}, k=${v.publicB64}`, 'https://web.push.apple.com', v.publicB64, nowSec);
  const other = await makeVapid();
  let threw = ''; try { await WP.importVapidKeys(v.publicB64, other.privateB64, 'mailto:a@b.co'); } catch (e) { threw = e.message; }
  eq(threw, 'vapid_keypair_mismatch', 'mismatched pair');
  threw = ''; try { await WP.importVapidKeys(v.publicB64, v.privateB64, 'not-a-subject'); } catch (e) { threw = e.message; }
  eq(threw, 'vapid_subject_invalid', 'subject must be mailto:/https:');
});

test('A6 base64url decoder is strict', async () => {
  for (const bad of ['a+b', 'a/b', 'a b', 'abcde', '%%%']) {
    let threw = false; try { WP.b64urlDecode(bad); } catch { threw = true; }
    assert(threw, 'rejects ' + bad);
  }
  eq(b64u(WP.b64urlDecode('BTBZMqHH6r4Tts7J_aSIgg')), 'BTBZMqHH6r4Tts7J_aSIgg', 'round trip');
});

// ════════════════════════════════════════════════════════════════════════════
// B. Auth + identity
// ════════════════════════════════════════════════════════════════════════════
test('B1 subscribe: missing / wrong / other-client token → 401, nothing stored', async () => {
  const w = await world(); const s = w.newSub();
  eq((await w.subscribe(s, { token: '' })).j.error, 'missing_credentials', 'no token');
  eq((await w.subscribe(s, { token: 'x'.repeat(64) })).j.error, 'bad_token', 'wrong token');
  eq((await w.subscribe(s, { token: OTHER_TOKEN })).j.error, 'bad_token', "another client's token");
  eq((await w.subscribe(s, { token: SECOND_TOKEN })).j.error, 'bad_token', "allow-listed sibling's token");
  eq(w.db.T.push_devices.length, 0, 'no device rows');
  assertNoLeak(w);
});

test('B2 non-eligible client is refused after auth, with no writes; eligibility never leaks to unauthenticated callers', async () => {
  const w = await world(); const s = w.newSub();
  const writes = () => w.db.calls.filter((c) => c.mode !== 'select').length;
  const before = writes();
  const r = await w.call({ type: 'pushSubscribe', storageKey: OTHER, token: OTHER_TOKEN, subscription: s.json });
  eq(r.status, 403, 'status'); eq(r.j.error, 'push_not_enabled', 'authenticated but not eligible');
  eq(writes(), before, 'zero writes');
  eq((await w.call({ type: 'pushSubscribe', storageKey: OTHER, token: 'x'.repeat(40), subscription: s.json })).j.error, 'bad_token', 'bad token → auth error, not an eligibility answer');
  const w2 = await world({ allowed: [] });
  eq((await w2.subscribe(w2.newSub())).j.error, 'push_not_enabled', 'internal canary without the exception list = refused');
});

test('B3 caller-supplied client_id / clientId are ignored', async () => {
  const w = await world(); const s = w.newSub();
  const r = await w.subscribe(s, { client_id: w.otherId, clientId: w.otherId, storage_key: OTHER });
  eq(r.j.ok, true, 'ok');
  eq(w.db.T.push_devices[0].client_id, w.canaryId, 'stored against the VERIFIED client');
  eq(w.db.T.push_devices[0].storage_key, CANARY, 'storage key from auth');
});

test('B4 revoked / suspended access → refused', async () => {
  for (const st of ['revoked', 'suspended']) {
    const w = await world({ canaryAccess: st });
    eq((await w.subscribe(w.newSub())).j.error, 'access_' + st, st);
    eq(w.db.T.push_devices.length, 0, 'nothing stored ' + st);
  }
});

test('B5 coach auth: wrong / missing coach token → 401; client token is not a coach token', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  eq((await w.send({ coachToken: 'nope' })).status, 401, 'wrong');
  eq((await w.send({ coachToken: undefined })).status, 401, 'missing');
  eq((await w.send({ coachToken: CANARY_TOKEN })).status, 401, 'client token');
  eq(w.svc.received.length, 0, 'nothing sent');
  eq(w.db.T.notification_events.length, 0, 'nothing claimed');
});

test('B6 coach send to a non-allow-listed client is refused', async () => {
  const w = await world();
  const r = await w.send({ storageKey: OTHER });
  eq(r.j.error, 'push_not_enabled', 'refused');
  eq(w.db.T.notification_events.length, 0, 'nothing claimed');
});

test('B7 verifyClientToken is a verbatim copy of the api implementation', async () => {
  const grabFn = (src) => {
    const i = src.indexOf('async function verifyClientToken');
    assert(i >= 0, 'function present');
    let depth = 0, j = src.indexOf('{', src.indexOf(')', src.indexOf('Promise<', i)));
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1).replace(/\s+/g, ' ');
    }
    throw new Error('unterminated');
  };
  eq(grabFn(rd('supabase/functions/push/handler.ts')), grabFn(rd('supabase/functions/api/index.ts')), 'identical');
});

// ════════════════════════════════════════════════════════════════════════════
// C. Subscription validation + endpoint allow-list
// ════════════════════════════════════════════════════════════════════════════
test('C1 endpoint allow-list: every hostile / malformed endpoint rejected', async () => {
  const bad = [
    'http://web.push.apple.com/abc',                   // not https
    'https://evil.example.com/abc',
    'https://web.push.apple.com.evil.com/abc',          // suffix trick
    'https://evilweb.push.apple.com.attacker.io/x',
    'https://push.apple.com/x',                         // bare suffix, not a subdomain
    'https://fcm.googleapis.com.evil.io/x',
    'https://user:pw@web.push.apple.com/x',             // userinfo
    'https://web.push.apple.com:8443/x',                // port
    'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data',
    'https://localhost/x', 'https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/api',
    'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '',
    'https://web.push.apple.com/' + 'a'.repeat(1100),
  ];
  const w = await world();
  for (const e of bad) {
    const s = makeBrowserSub(); s.json.endpoint = e;
    const r = await w.subscribe(s);
    eq(r.j.ok, false, 'rejected: ' + e.slice(0, 60));
    eq(r.status, 400, 'status 400: ' + e.slice(0, 60));
  }
  const nonString = await w.call({ type: 'pushSubscribe', storageKey: CANARY, token: CANARY_TOKEN, subscription: { endpoint: { href: 'x' }, keys: {} } });
  eq(nonString.j.ok, false, 'non-string endpoint');
  eq(w.db.T.push_devices.length, 0, 'nothing stored');
});

test('C2 allow-listed push services accepted', async () => {
  const ok = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'api.push.apple.com', 'wns2-par02p.notify.windows.com'];
  for (const h of ok) {
    const r = H.validateEndpoint(`https://${h}/abc`);
    assert(r.ok, 'accepted ' + h);
  }
  assert(H.validateEndpoint('https://WEB.PUSH.APPLE.COM/abc').ok, 'case-insensitive host');
});

test('C3 subscription key validation', async () => {
  const w = await world();
  const cases = [
    (s) => { delete s.json.keys; },
    (s) => { s.json.keys.p256dh = 'short'; },
    (s) => { s.json.keys.p256dh = b64u(Buffer.alloc(65)); },                       // not on curve
    (s) => { const k = unb64u(s.json.keys.p256dh); k[64] ^= 1; s.json.keys.p256dh = b64u(k); },
    (s) => { s.json.keys.auth = b64u(Buffer.alloc(8)); },
    (s) => { s.json.keys.auth = '!!notb64!!'; },
    (s) => { s.json.keys.p256dh = 12345; },
  ];
  for (const [i, mut] of cases.entries()) {
    const s = makeBrowserSub(); mut(s);
    eq((await w.subscribe(s)).j.ok, false, 'bad keys case ' + i);
  }
  eq(w.db.T.push_devices.length, 0, 'nothing stored');
});

test('C4 oversize / malformed request bodies', async () => {
  const w = await world();
  eq((await w.call('{not json')).j.error, 'bad_json', 'bad json');
  eq((await w.call(JSON.stringify({ type: 'pushSubscribe', pad: 'x'.repeat(9000) }))).status, 413, 'too large');
  eq((await w.call({ type: 'nope' })).j.error, 'unknown_type', 'unknown type');
  eq((await w.call({ type: 'pushSubscribe', storageKey: '../etc', token: 'x' })).j.error, 'bad_storageKey', 'bad key');
});

// ════════════════════════════════════════════════════════════════════════════
// D. Registration lifecycle
// ════════════════════════════════════════════════════════════════════════════
test('D1 valid subscribe stores one active device with hashed identity; no secrets echoed', async () => {
  const w = await world(); const s = w.newSub();
  const r = await w.subscribe(s);
  eq(r.j.ok, true, 'ok'); eq(r.j.created, true, 'created');
  const d = w.db.T.push_devices[0];
  eq(d.status, 'active', 'active'); eq(d.endpoint_hash, sha256hex(s.json.endpoint), 'endpoint hash');
  eq(d.push_host, 'web.push.apple.com', 'host'); eq(d.timezone, 'Australia/Sydney', 'tz'); eq(d.standalone, true, 'standalone');
  assertNoLeak(w);
});

test('D2 duplicate registration (same client) updates in place — never a second row', async () => {
  const w = await world(); const s = w.newSub();
  const a = await w.subscribe(s);
  const b = await w.subscribe(s, { timezone: 'Europe/London' });
  eq(b.j.created, false, 'not created'); eq(b.j.deviceId, a.j.deviceId, 'same device id');
  eq(w.db.T.push_devices.length, 1, 'one row'); eq(w.db.T.push_devices[0].timezone, 'Europe/London', 'updated tz');
});

test('D3 same endpoint under a different client → 409, original row untouched', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  const snapshot = JSON.stringify(w.db.T.push_devices);
  const r = await w.call({ type: 'pushSubscribe', storageKey: '_push_canary2', token: SECOND_TOKEN, subscription: s.json });
  eq(r.status, 409, 'conflict'); eq(r.j.error, 'endpoint_conflict', 'error');
  eq(JSON.stringify(w.db.T.push_devices), snapshot, 'unchanged');
});

test('D4 invalid timezone is dropped, not stored', async () => {
  const w = await world();
  await w.subscribe(w.newSub(), { timezone: 'Mars/Olympus_Mons' });
  await w.subscribe(w.newSub(), { timezone: '<script>' });
  assert(w.db.T.push_devices.every((d) => d.timezone === null), 'null timezones');
});

test('D5 device cap per client', async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) eq((await w.subscribe(w.newSub())).j.ok, true, 'device ' + i);
  eq((await w.subscribe(w.newSub())).j.error, 'too_many_devices', 'sixth refused');
});

test('D6 pushStatus: returns VAPID public key + registration, never endpoint/keys', async () => {
  const w = await world(); const s = w.newSub();
  let r = await w.call({ type: 'pushStatus', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.ok, true, 'ok'); eq(r.j.vapidPublicKey, w.vapid.publicB64, 'public key'); eq(r.j.registered, false, 'not yet');
  await w.subscribe(s);
  r = await w.call({ type: 'pushStatus', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.registered, true, 'registered');
  r = await w.call({ type: 'pushStatus', storageKey: '_push_canary2', token: SECOND_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.registered, false, "another client can't see this device");
  eq(r.j.deviceStatus, null, 'no status leak');
  assertNoLeak(w);
});

test('D7 unsubscribe revokes + wipes endpoint/keys; scoped to the caller', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  const foreign = await w.call({ type: 'pushUnsubscribe', storageKey: '_push_canary2', token: SECOND_TOKEN, endpoint: s.json.endpoint });
  eq(foreign.j.revoked, false, "other client can't revoke");
  eq(w.db.T.push_devices[0].status, 'active', 'still active');
  const r = await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint });
  eq(r.j.revoked, true, 'revoked');
  const d = w.db.T.push_devices[0];
  eq(d.status, 'revoked', 'status'); eq(d.endpoint, '', 'endpoint wiped'); eq(d.p256dh, '', 'p256dh wiped'); eq(d.auth_secret, '', 'auth wiped');
  eq((await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: CANARY_TOKEN, endpoint: s.json.endpoint })).j.revoked, false, 'idempotent');
  const sent = await w.send();
  eq(sent.j.status, 'suppressed', 'no send after unsubscribe'); eq(sent.j.reason, 'no_active_device', 'reason');
  eq(w.svc.received.length, 0, 'nothing delivered');
  // Re-subscribing the same browser later reactivates the row with fresh keys.
  eq((await w.subscribe(s)).j.created, false, 'reactivated in place');
  eq(w.db.T.push_devices[0].status, 'active', 'active again');
});

test('D8 unsubscribe requires auth', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  eq((await w.call({ type: 'pushUnsubscribe', storageKey: CANARY, token: 'bad'.repeat(10), endpoint: s.json.endpoint })).status, 401, '401');
  eq(w.db.T.push_devices[0].status, 'active', 'untouched');
});

// ════════════════════════════════════════════════════════════════════════════
// E. Sending
// ════════════════════════════════════════════════════════════════════════════
test('E1 coach test send: encrypted, VAPID-signed, lock-screen-safe payload, logged', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  const r = await w.send();
  eq(r.j.ok, true, 'ok'); eq(r.j.status, 'sent', 'sent');
  eq(w.svc.received.length, 1, 'one push');
  const p = w.svc.received[0].payload;
  eq(p.title, 'LOCKED IN', 'title'); eq(p.url, './', 'url is scope-relative'); eq(p.kind, 'test', 'kind');
  eq(w.svc.received[0].headers.Topic, 'li-test', 'topic');
  const ev = w.db.T.notification_events[0];
  eq(ev.status, 'sent', 'event status'); eq(ev.success_count, 1, 'success count'); eq(ev.created_by, 'coach', 'created_by');
  assert(!JSON.stringify(ev.results).includes(s.json.endpoint), 'results never hold the endpoint');
  assert(w.db.T.push_devices[0].last_success_at, 'last_success_at set');
  assertNoLeak(w);
});

test('E2 duplicate requestId → no second push', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  const a = await w.send({ requestId: 'fixed_request_0001' });
  const b = await w.send({ requestId: 'fixed_request_0001' });
  eq(b.j.duplicate, true, 'duplicate'); eq(b.j.eventId, a.j.eventId, 'same event');
  eq(w.svc.received.length, 1, 'exactly one push'); eq(w.db.T.notification_events.length, 1, 'one event');
});

test('E3 410 Gone → device expired + wiped; next send suppressed', async () => {
  const w = await world(); const s = w.newSub();
  await w.subscribe(s);
  w.svc.setStatus(() => 410);
  const r = await w.send();
  eq(r.j.status, 'failed', 'event failed'); eq(r.j.results[0].outcome, 'expired', 'outcome');
  const d = w.db.T.push_devices[0];
  eq(d.status, 'expired', 'expired'); eq(d.disabled_reason, 'push_service_410', 'reason');
  eq(d.endpoint + d.p256dh + d.auth_secret, '', 'wiped');
  eq((await w.send()).j.reason, 'no_active_device', 'next send suppressed');
});

test('E4 404 → expired; 5xx/429/network → counted failure, device kept; 5 failures → disabled', async () => {
  let w = await world(); await w.subscribe(w.newSub());
  w.svc.setStatus(() => 404); await w.send();
  eq(w.db.T.push_devices[0].status, 'expired', '404 expires');

  w = await world(); await w.subscribe(w.newSub());
  const seq = [500, 429, 'throw', 503];
  let i = 0; w.svc.setStatus(() => seq[i++]);
  for (let k = 0; k < 4; k++) await w.send();
  eq(w.db.T.push_devices[0].status, 'active', 'still active after 4 transient failures');
  eq(w.db.T.push_devices[0].failure_count, 4, 'failure count');
  w.svc.setStatus(() => 500); await w.send();
  eq(w.db.T.push_devices[0].status, 'disabled', 'disabled after 5');
  w.svc.setStatus(() => 201);
  eq((await w.send()).j.reason, 'no_active_device', 'disabled device not used');
});

test('E5 partial: one device ok, one gone', async () => {
  const w = await world();
  const a = w.newSub(); const b = w.newSub('fcm.googleapis.com');
  await w.subscribe(a); await w.subscribe(b);
  w.svc.setStatus((url) => url === a.json.endpoint ? 201 : 410);
  const r = await w.send();
  eq(r.j.status, 'partial', 'partial'); eq(w.svc.received.length, 2, 'both attempted');
});

test('E6 access revoked after subscribing → send suppressed', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  w.db.T.client_sessions[0].access_status = 'revoked';
  const r = await w.send();
  eq(r.j.status, 'suppressed', 'suppressed'); eq(r.j.reason, 'access_not_active', 'reason');
  eq(w.svc.received.length, 0, 'nothing sent');
});

test('E7 only fixed templates; bad requestId refused', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  eq((await w.send({ template: 'custom', title: 'Your weight is 92kg' })).j.error, 'unknown_template', 'no free text');
  eq((await w.send({ requestId: 'short' })).j.error, 'bad_requestId', 'short id');
  eq((await w.send({ requestId: 'has spaces in it' })).j.error, 'bad_requestId', 'spaces');
  eq(w.svc.received.length, 0, 'nothing sent');
});

test('E8 templates are lock-screen safe (no numbers, no targets/units/body data)', async () => {
  // The word "weight" is allowed ONLY in Omar's approved weigh-in copy, which
  // asks for an action and carries no value.
  const APPROVED_WEIGHT_COPY = "Morning bro. Log your weight when you're up.";
  for (const [k, t] of Object.entries(H.TEMPLATES)) {
    const text = t.title + ' ' + t.body;
    assert(!/\d/.test(text), k + ': no digits');
    assert(!/\b(kg|kgs|lb|lbs|kcal|calorie|calories|protein|carb|carbs|fat|macro|macros|bmi|body|deficit|target|goal)\b/i.test(text), k + ': no targets/units/body data');
    if (/\bweigh/i.test(text)) eq(t.body, APPROVED_WEIGHT_COPY, k + ': "weight" only in the approved copy');
    // Scope-relative; the only query allowed is a daily-reminder deep link to an existing shell section.
    assert(/^\.\/[A-Za-z0-9#_-]*$/.test(t.url) || /^\.\/\?li=(training|nutrition)$/.test(t.url), k + ': url is scope-relative');
  }
});

test('E9 daily cap', async () => {
  const w = await world(); await w.subscribe(w.newSub());
  for (let i = 0; i < 20; i++) await w.send();
  eq((await w.send()).j.error, 'daily_cap_reached', 'capped at 20/day');
  eq(w.svc.received.length, 20, '20 delivered');
});

test('E10 VAPID not configured → fail closed everywhere', async () => {
  const w = await world({ noVapid: true });
  eq((await w.subscribe(w.newSub())).j.error, 'push_not_configured', 'subscribe');
  eq((await w.send()).j.error, 'push_not_configured', 'send');
  eq((await w.call('ping', 'GET')).j.configured, false, 'ping says not configured');
  eq(w.db.T.push_devices.length + w.db.T.notification_events.length, 0, 'nothing written');
});

test('E11 ping exposes nothing sensitive', async () => {
  const w = await world();
  const r = await w.call('ping', 'GET');
  eq(r.j.ok, true, 'ok'); eq(r.j.configured, true, 'configured');
  eq(Object.keys(r.j).sort().join(','), 'configured,ok,v', 'only ok/v/configured');
});

// ════════════════════════════════════════════════════════════════════════════
// F. Service worker (sw.js executed in a sandbox)
// ════════════════════════════════════════════════════════════════════════════
const SCOPE = 'https://omarsoubra.github.io/DASHBOARD/clients/_push_canary/';
function loadSw() {
  const listeners = {};
  const shown = [], opened = [], focused = [];
  let windows = [];
  const self = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    registration: { scope: SCOPE, showNotification: (title, o) => { shown.push({ title, o }); return Promise.resolve(); } },
    location: { href: 'https://omarsoubra.github.io/DASHBOARD/sw.js' },
    clients: {
      matchAll: async () => windows,
      openWindow: async (u) => { opened.push(u); },
      claim: async () => {},
    },
    skipWaiting: () => {},
  };
  const ctx = vm.createContext({ self, URL, caches: { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], match: async () => null }, fetch: async () => new Response(''), Promise, console });
  vm.runInContext(rd('sw.js'), ctx);
  const fire = async (type, ev) => {
    const waits = [];
    ev.waitUntil = (p) => waits.push(p);
    for (const fn of listeners[type] || []) fn(ev);
    await Promise.all(waits);
  };
  return { listeners, shown, opened, focused, fire, setWindows: (w) => { windows = w; } };
}

test('F1 sw.js keeps its existing handlers and adds push', async () => {
  const sw = loadSw();
  for (const t of ['install', 'activate', 'fetch', 'notificationclick', 'push']) assert(sw.listeners[t] && sw.listeners[t].length === 1, 'one ' + t + ' listener');
});

test('F2 push: always shows a notification; click URL confined to scope', async () => {
  const sw = loadSw();
  const cases = [
    [{ title: 'LOCKED IN', body: 'b', url: './' }, SCOPE],
    [{ title: 'T', url: './#checkin' }, SCOPE + '#checkin'],
    [{ title: 'T', url: 'https://evil.example/phish' }, SCOPE],
    [{ title: 'T', url: '//evil.example/x' }, SCOPE],
    [{ title: 'T', url: '../zac/' }, SCOPE],
    [{ title: 'T', url: '/DASHBOARD/coach_dashboard.html' }, SCOPE],
    [{ title: 'T', url: 'javascript:alert(1)' }, SCOPE],
    [{ title: 'T', url: 42 }, SCOPE],
  ];
  for (const [payload, expectUrl] of cases) {
    await sw.fire('push', { data: { json: () => payload } });
    eq(sw.shown.at(-1).o.data.url, expectUrl, 'click url for ' + JSON.stringify(payload.url));
  }
  await sw.fire('push', { data: null });
  eq(sw.shown.at(-1).title, 'LOCKED IN', 'empty push still shows');
  await sw.fire('push', { data: { json: () => { throw new Error('bad'); } } });
  eq(sw.shown.at(-1).title, 'LOCKED IN', 'malformed push still shows');
  await sw.fire('push', { data: { json: () => ({ title: 'x'.repeat(500), tag: 'bad tag!' }) } });
  eq(sw.shown.at(-1).title.length, 80, 'title clamped'); eq(sw.shown.at(-1).o.tag, 'locked-in', 'bad tag replaced');
});

test('F3 notificationclick: opens only in-scope URLs; focuses existing window', async () => {
  const sw = loadSw();
  const note = (url) => ({ notification: { close() {}, data: { url } } });
  await sw.fire('notificationclick', note('https://evil.example/'));
  eq(sw.opened.at(-1), SCOPE, 'evil → scope');
  await sw.fire('notificationclick', note(SCOPE + '#x'));
  eq(sw.opened.at(-1), SCOPE + '#x', 'in-scope kept');
  let focusedCount = 0;
  sw.setWindows([{ url: SCOPE, focus: async () => { focusedCount++; } }]);
  const before = sw.opened.length;
  await sw.fire('notificationclick', note(SCOPE));
  eq(focusedCount, 1, 'focused'); eq(sw.opened.length, before, 'no new window');
});

// ════════════════════════════════════════════════════════════════════════════
// G. Static security + isolation
// ════════════════════════════════════════════════════════════════════════════
const CLIENT_VISIBLE = ['push-client.js', 'sw.js', 'clients/_push_canary/index.html', 'clients/_push_canary/manifest.json'];

test('G1 no secrets in any client-visible file', async () => {
  const patterns = [
    [/service_role/i, 'service role'], [/SUPABASE_SERVICE/i, 'service key name'], [/VAPID_PRIVATE/i, 'vapid private name'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'], [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub PAT'],
    [/\bsb_secret_/, 'supabase secret key'], [/COACH_PASSWORD/i, 'coach secret name'], [/coachToken/, 'coach token field'],
    [/\b[A-Za-z0-9_-]{43}\b/, '43-char base64url (32-byte key-shaped)'],
    [/\b[a-f0-9]{64}\b/, '64-hex (sha256-shaped secret)'],
  ];
  for (const f of CLIENT_VISIBLE) {
    const src = rd(f);
    for (const [re, label] of patterns) assert(!re.test(src), `${f}: contains ${label}`);
  }
});

test('G2 permission requested ONLY inside the Turn-on tap handler', async () => {
  const src = rd('push-client.js');
  const hits = src.match(/requestPermission/g) || [];
  eq(hits.length, 1, 'exactly one requestPermission call');
  const start = src.indexOf('Push.prototype._onEnable = function');
  const end = src.indexOf('Push.prototype._onDisable');
  const at = src.indexOf('requestPermission');
  assert(start > 0 && at > start && at < end, 'it is inside _onEnable');
  assert(/addEventListener\('click', handler\)/.test(src), '_onEnable is wired to a click');
  assert(!/requestPermission|new Notification\(/.test(rd('clients/_push_canary/index.html')), 'canary shell never prompts on its own');
  assert(!/setTimeout\([^)]*requestPermission/.test(src), 'no timer prompt');
});

test('G3 token never placed in a URL, the console or innerHTML by push-client.js', async () => {
  const src = rd('push-client.js');
  assert(!/innerHTML/.test(src), 'no innerHTML');
  assert(!/console\.(log|info|warn|error)/.test(src), 'no console output');
  assert(!/[?&]token=/.test(src), 'no token query param');
  assert(/token: this\.o\.getToken\(\)/.test(src), 'token only in POST body');
});

test('G4 canary shell is isolated: canary key only, push endpoint only, never api', async () => {
  const src = rd('clients/_push_canary/index.html');
  assert(/storageKey: '_push_canary'/.test(src), 'canary key');
  assert(!/functions\/v1\/api/.test(src), 'no api calls');
  assert(/functions\/v1\/push'/.test(src), 'push endpoint');
  assert(/Content-Security-Policy/.test(src), 'CSP present');
  assert(/history\.replaceState/.test(src), 'strips ?t= from the address bar');
  const man = JSON.parse(rd('clients/_push_canary/manifest.json'));
  eq(man.display, 'standalone', 'standalone'); eq(man.scope, './', 'scope'); eq(man.start_url, './', 'no token in start_url');
});

test('G5 migration is additive + locked down', async () => {
  const live = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert(!/\bdrop\b/i.test(live), 'no DROP outside the commented DOWN block');
  assert(!/alter table public\.(clients|client_sessions|programs|weight_logs|check_ins)/i.test(live), 'no existing table altered');
  for (const t of ['push_devices', 'notification_events']) {
    assert(new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(live), t + ' RLS');
    assert(new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`).test(live), t + ' revoke');
    assert(!new RegExp(`create policy[^;]*${t}`, 'i').test(live), t + ' has no policy (default deny)');
  }
  assert(/unique \(endpoint_hash\)/.test(live) && /unique \(dedupe_key\)/.test(live), 'unique constraints');
});

test('G6 push and api stay separate; sw.js cache/fetch logic untouched', async () => {
  // Pinned against the pre-push baseline (f68e464), so this holds after commit
  // and in CI's shallow checkout: sha256 of sw.js up to the push section.
  const SW_PREFIX_SHA256 = 'f108f10d63f32dd37b293eedba1f013a71230e6d39321837bf7937da845c4915';
  const MARKER = '// ─────────────────────────────────────────────────────────────────────────\n// LOCKED IN Push';
  const sw = rd('sw.js');
  assert(sw.includes(MARKER), 'push section marker present');
  eq(sha256hex(sw.slice(0, sw.indexOf(MARKER))), SW_PREFIX_SHA256, 'install/activate/fetch section byte-identical to pre-push baseline');
  // The api now evolves on its own approved, separately tested work (workout completion,
  // coach view, Phase 0 isolation fix, client accounts), so freezing its bytes no longer
  // tests what this guard was for. The invariant that matters is SEPARATION: the push
  // subsystem never touches the api, and the api never writes push state.
  const api = rd('supabase/functions/api/index.ts');
  for (const t of ['push_devices', 'notification_events', 'push_internal_auth', 'push_plan_facts']) {
    assert(!new RegExp(`from\\('${t}'\\)`).test(api), `api never touches ${t}`);
  }
  const prefUses = [...api.matchAll(/from\('push_preferences'\)([^;]*)/g)].map((m) => m[1]);
  assert(prefUses.every((u) => /\.select\(/.test(u) && !/\.(insert|update|upsert|delete)\(/.test(u)), 'api only READS push_preferences (coach view timezone)');
  const pushSrc = ['handler.ts', 'schedule.ts', 'webpush.ts', 'index.ts'].map((f) => rd('supabase/functions/push/' + f)).join('\n');
  assert(!/functions\/v1\/api|from '\.\.\/api/.test(pushSrc), 'push never calls or imports the api');
  assert(/const CACHE_NAME = 'strengthbyo-v4-2026-08-30-pwa-refresh';/.test(rd('sw.js')), 'CACHE_NAME not bumped (no forced reload for existing users)');
});

test('G7 handler never follows redirects and caps work per call', async () => {
  const wp = rd('supabase/functions/push/webpush.ts');
  const h = rd('supabase/functions/push/handler.ts');
  assert(/redirect: 'manual'/.test(wp), 'redirect manual');
  assert(/limit\(MAX_DEVICES_PER_SEND\)/.test(h), 'device fan-out bounded');
  assert(!/\bwhile\s*\(/.test(h + wp), 'no while loops (Rule 2)');
});

run('push_proof');
