// ============================================================================
// LOCKED IN Push Notifications — MINIMAL PROOF handler
//
// Separate Edge Function (`push`). The `api` function is not touched and not
// redeployed by anything in this subsystem.
//
// Ops (POST, body { type, ... }, same request style as `api`):
//   pushStatus       client token  → VAPID public key + whether THIS endpoint is registered
//   pushSubscribe    client token  → register this browser's subscription
//   pushUnsubscribe  client token  → revoke this browser's subscription
//   coachPushSend    coach token   → send the fixed `test` template to one client
//   ping             none          → liveness + "is VAPID configured" (no secrets)
//
// Hard boundaries (each has a test in tests/push_proof.test.js):
//   * Client identity comes ONLY from verifyClientToken(token, storageKey).
//     Any client_id / clientId in the request body is ignored.
//   * PUSH_ALLOWED_CLIENTS gates every client and coach op. Unset = nobody.
//   * Endpoints must be https on an allow-listed push-service host.
//   * Responses never contain endpoints, subscription keys or VAPID private data.
//   * Payloads come from fixed templates only — no health, weight or calorie data.
//   * 404/410 from a push service expires the device and wipes its endpoint+keys.
// ============================================================================
import {
  b64urlDecode, importP256PublicEcdh, importVapidKeys, sendWebPush,
  type VapidKeys,
} from './webpush.ts';

export type PushEnv = {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  coachPasswordHash: string;
  allowedClients: Set<string>;
};

export function readPushEnv(get: (k: string) => string | undefined): PushEnv {
  const allowed = String(get('PUSH_ALLOWED_CLIENTS') ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    vapidPublicKey: get('VAPID_PUBLIC_KEY') ?? '',
    vapidPrivateKey: get('VAPID_PRIVATE_KEY') ?? '',
    vapidSubject: get('VAPID_SUBJECT') ?? '',
    coachPasswordHash: get('COACH_PASSWORD_HASH') ?? '',
    allowedClients: new Set(allowed),
  };
}

type Deps = {
  admin: any;                       // supabase-js client (service role) or test stand-in
  env: PushEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;               // ms
  log?: (op: string, code: string, detail: string) => void;
};

// ── constants ───────────────────────────────────────────────────────────────
export const PUSH_VERSION = 'push-proof-v1';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ENDPOINT_LEN = 1024;
const MAX_ACTIVE_DEVICES_PER_CLIENT = 5;
const MAX_EVENTS_PER_CLIENT_PER_DAY = 20;
const MAX_DEVICES_PER_SEND = 10;
const DISABLE_AFTER_FAILURES = 5;
const CLIENT_KEY_RE = /^[a-z0-9_]{2,40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Push-service hosts. Exact names, or a strict subdomain of a suffix entry.
const PUSH_HOSTS_EXACT = new Set([
  'web.push.apple.com',               // Safari / iOS Home-Screen web apps
  'fcm.googleapis.com',               // Chrome, Android, Edge (Chromium)
  'updates.push.services.mozilla.com' // Firefox
]);
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

// Fixed templates. Lock-screen safe: no numbers, no body data, no health terms.
export const TEMPLATES: Record<string, { kind: string; title: string; body: string; url: string; tag: string; ttlSec: number }> = {
  test: {
    kind: 'test',
    title: 'LOCKED IN',
    body: 'Test notification. Tap to open your programme.',
    url: './',
    tag: 'li-test',
    ttlSec: 3600,
  },
};

// ── http helpers (mirrors `api`) ────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ok  = (extra: Record<string, unknown> = {}) => json({ ok: true, ...extra });
const err = (reason: string, status = 200, extra: Record<string, unknown> = {}) => json({ ok: false, error: reason, ...extra }, status);

// ── hashing ─────────────────────────────────────────────────────────────────
async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const dig = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(dig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── validation ──────────────────────────────────────────────────────────────
export function validateEndpoint(raw: unknown): { ok: true; url: URL; host: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'endpoint_missing' };
  if (raw.length > MAX_ENDPOINT_LEN) return { ok: false, reason: 'endpoint_too_long' };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'endpoint_unparseable' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'endpoint_not_https' };
  if (u.username || u.password) return { ok: false, reason: 'endpoint_has_userinfo' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'endpoint_bad_port' };
  const host = u.hostname.toLowerCase();
  const allowed = PUSH_HOSTS_EXACT.has(host) ||
    PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
  if (!allowed) return { ok: false, reason: 'endpoint_host_not_allowed' };
  return { ok: true, url: u, host };
}

async function validateKeys(keys: any): Promise<{ ok: true; p256dh: string; auth: string } | { ok: false; reason: string }> {
  if (!keys || typeof keys !== 'object') return { ok: false, reason: 'keys_missing' };
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 128 || auth.length > 64) {
    return { ok: false, reason: 'keys_invalid' };
  }
  try {
    const pub = b64urlDecode(p256dh);
    await importP256PublicEcdh(pub);                 // rejects bad length / off-curve points
    if (b64urlDecode(auth).length !== 16) return { ok: false, reason: 'auth_secret_invalid' };
  } catch {
    return { ok: false, reason: 'keys_invalid' };
  }
  return { ok: true, p256dh: p256dh.replace(/=+$/, ''), auth: auth.replace(/=+$/, '') };
}

function validTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
export function makePushHandler(deps: Deps): (req: Request) => Promise<Response> {
  const admin = deps.admin;
  const env = deps.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((op, code, detail) => {
    console.error(JSON.stringify({ ef: 'push', op, code, detail: String(detail).slice(0, 200) }));
  });

  let vapidPromise: Promise<VapidKeys> | null = null;
  function vapid(): Promise<VapidKeys> {
    if (!vapidPromise) {
      vapidPromise = importVapidKeys(env.vapidPublicKey, env.vapidPrivateKey, env.vapidSubject);
      vapidPromise.catch(() => { vapidPromise = null; });
    }
    return vapidPromise;
  }
  async function vapidOrNull(): Promise<VapidKeys | null> {
    try { return await vapid(); } catch (e) { log('vapid', 'not_configured', String((e as any)?.message ?? e)); return null; }
  }

  // ── auth: verbatim copy of api/index.ts verifyClientToken ─────────────────
  // tests/push_proof.test.js fails if this body drifts from the api's.
  async function verifyClientToken(token: string | undefined, storageKey: string | undefined): Promise<{ ok: boolean; storageKey?: string; reason?: string }> {
    if (!token || !storageKey) return { ok: false, reason: 'missing_credentials' };
    const { data, error } = await admin
      .from('client_sessions')
      .select('token_hash, salt, access_status, clients(storage_key)')
      .eq('storage_key', storageKey.toLowerCase())
      .single();
    if (error || !data) return { ok: false, reason: 'unknown_client' };
    if (data.access_status === 'revoked')   return { ok: false, reason: 'access_revoked' };
    if (data.access_status === 'suspended') return { ok: false, reason: 'access_suspended' };
    const hash = await sha256(token + (data.salt ?? ''));
    if (hash !== data.token_hash) return { ok: false, reason: 'bad_token' };
    return { ok: true, storageKey };
  }

  function verifyCoachToken(token: unknown): boolean {
    if (typeof token !== 'string' || !token || !env.coachPasswordHash) return false;
    return timingSafeEqual(token, env.coachPasswordHash);
  }

  /** Allow-list → token → canonical client id. Returns a Response on failure. */
  async function authClient(body: any): Promise<{ clientId: string; storageKey: string } | Response> {
    const storageKey = String(body?.storageKey ?? '').trim().toLowerCase();
    if (!CLIENT_KEY_RE.test(storageKey)) return err('bad_storageKey', 400);
    if (!env.allowedClients.has(storageKey)) return err('push_not_enabled', 403);
    const token = typeof body?.token === 'string' ? body.token : undefined;
    const v = await verifyClientToken(token, storageKey);
    if (!v.ok) return err(v.reason ?? 'unauthorized', 401);
    const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
    if (!client?.id) return err('unknown_client', 401);
    return { clientId: client.id, storageKey };
  }

  // ── pushStatus ────────────────────────────────────────────────────────────
  async function pushStatus(body: any): Promise<Response> {
    const a = await authClient(body);
    if (a instanceof Response) return a;
    const v = await vapidOrNull();
    if (!v) return err('push_not_configured', 503);
    let registered = false;
    let deviceStatus: string | null = null;
    if (typeof body?.endpoint === 'string' && body.endpoint && body.endpoint.length <= MAX_ENDPOINT_LEN) {
      const h = await sha256(body.endpoint);
      const { data: dev } = await admin.from('push_devices')
        .select('id, client_id, status').eq('endpoint_hash', h).maybeSingle();
      if (dev && dev.client_id === a.clientId) {
        deviceStatus = dev.status;
        registered = dev.status === 'active';
      }
    }
    return ok({ storageKey: a.storageKey, vapidPublicKey: v.publicKeyB64, registered, deviceStatus });
  }

  // ── pushSubscribe ─────────────────────────────────────────────────────────
  async function pushSubscribe(body: any): Promise<Response> {
    const a = await authClient(body);
    if (a instanceof Response) return a;
    if (!(await vapidOrNull())) return err('push_not_configured', 503);

    const sub = body?.subscription;
    const ep = validateEndpoint(sub?.endpoint);
    if (!ep.ok) return err(ep.reason, 400);
    const keys = await validateKeys(sub?.keys);
    if (!keys.ok) return err(keys.reason, 400);

    const endpoint: string = sub.endpoint;
    const endpointHash = await sha256(endpoint);
    const nowIso = new Date(now()).toISOString();
    const timezone = validTimezone(body?.timezone);
    const standalone = body?.standalone === true;

    const { data: existing } = await admin.from('push_devices')
      .select('id, client_id, status').eq('endpoint_hash', endpointHash).maybeSingle();

    if (existing && existing.client_id !== a.clientId) {
      // A push endpoint is minted for one browser registration. Seeing it under a
      // different client is a replay or a mix-up; never move a device silently.
      log('pushSubscribe', 'endpoint_conflict', a.storageKey);
      return err('endpoint_conflict', 409);
    }

    const fields = {
      endpoint, p256dh: keys.p256dh, auth_secret: keys.auth, push_host: ep.host,
      standalone, timezone, status: 'active', disabled_reason: null, failure_count: 0,
      last_seen_at: nowIso, updated_at: nowIso,
    };

    if (existing) {
      const { error } = await admin.from('push_devices').update(fields)
        .eq('id', existing.id).eq('client_id', a.clientId);
      if (error) { log('pushSubscribe', 'update_failed', error.message); return err('write_failed', 500); }
      return ok({ deviceId: existing.id, created: false });
    }

    const { count } = await admin.from('push_devices')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', a.clientId).eq('status', 'active');
    if ((count ?? 0) >= MAX_ACTIVE_DEVICES_PER_CLIENT) return err('too_many_devices', 429);

    const { data: created, error } = await admin.from('push_devices').insert({
      client_id: a.clientId, storage_key: a.storageKey, endpoint_hash: endpointHash,
      created_at: nowIso, ...fields,
    }).select('id').single();
    if (error || !created?.id) {
      if (/duplicate key|23505/i.test(`${error?.message ?? ''} ${(error as any)?.code ?? ''}`)) {
        return err('retry', 409);    // concurrent insert of the same endpoint
      }
      log('pushSubscribe', 'insert_failed', error?.message ?? 'no_id');
      return err('write_failed', 500);
    }
    return ok({ deviceId: created.id, created: true });
  }

  // ── pushUnsubscribe ───────────────────────────────────────────────────────
  async function pushUnsubscribe(body: any): Promise<Response> {
    const a = await authClient(body);
    if (a instanceof Response) return a;
    const endpoint = body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LEN) return err('endpoint_missing', 400);
    const h = await sha256(endpoint);
    const nowIso = new Date(now()).toISOString();
    // Scoped to the authenticated client: an endpoint belonging to anyone else
    // matches zero rows. Endpoint + keys are wiped; the row stays for audit.
    const { data, error } = await admin.from('push_devices').update({
      status: 'revoked', disabled_reason: 'client_unsubscribed',
      endpoint: '', p256dh: '', auth_secret: '', updated_at: nowIso,
    }).eq('endpoint_hash', h).eq('client_id', a.clientId).eq('status', 'active').select('id');
    if (error) { log('pushUnsubscribe', 'update_failed', error.message); return err('write_failed', 500); }
    return ok({ revoked: (data ?? []).length > 0 });
  }

  // ── coachPushSend ─────────────────────────────────────────────────────────
  async function coachPushSend(body: any): Promise<Response> {
    if (!verifyCoachToken(body?.coachToken)) return err('unauthorized', 401);
    const storageKey = String(body?.storageKey ?? '').trim().toLowerCase();
    if (!CLIENT_KEY_RE.test(storageKey)) return err('bad_storageKey', 400);
    if (!env.allowedClients.has(storageKey)) return err('push_not_enabled', 403);
    const tpl = TEMPLATES[String(body?.template ?? '')];
    if (!tpl) return err('unknown_template', 400);
    const requestId = String(body?.requestId ?? '');
    if (!REQUEST_ID_RE.test(requestId)) return err('bad_requestId', 400);
    const v = await vapidOrNull();
    if (!v) return err('push_not_configured', 503);

    const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
    if (!client?.id) return err('unknown_client', 404);
    const clientId: string = client.id;
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    // Daily cap (cheap guard against a runaway script).
    const { count: recent } = await admin.from('notification_events')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).gte('created_at', new Date(nowMs - 86400_000).toISOString());
    if ((recent ?? 0) >= MAX_EVENTS_PER_CLIENT_PER_DAY) return err('daily_cap_reached', 429);

    // Claim. The unique dedupe_key is the ONLY thing that authorises a send:
    // a repeated requestId inserts nothing and therefore sends nothing.
    const dedupeKey = `coach:${requestId}:${clientId}`;
    const { data: ev, error: claimErr } = await admin.from('notification_events').insert({
      client_id: clientId, storage_key: storageKey, kind: tpl.kind, dedupe_key: dedupeKey,
      status: 'claimed', title: tpl.title, body: tpl.body, url: tpl.url,
      created_by: 'coach', request_id: requestId, created_at: nowIso,
    }).select('id').single();
    if (claimErr || !ev?.id) {
      if (/duplicate key|23505/i.test(`${claimErr?.message ?? ''} ${(claimErr as any)?.code ?? ''}`)) {
        const { data: prior } = await admin.from('notification_events')
          .select('id, status').eq('dedupe_key', dedupeKey).maybeSingle();
        return ok({ duplicate: true, eventId: prior?.id ?? null, status: prior?.status ?? null });
      }
      log('coachPushSend', 'claim_failed', claimErr?.message ?? 'no_id');
      return err('write_failed', 500);
    }
    const eventId: string = ev.id;

    const finish = async (fields: Record<string, unknown>) => {
      const { error } = await admin.from('notification_events').update(fields).eq('id', eventId);
      if (error) log('coachPushSend', 'finish_failed', error.message);
    };

    // Access is re-checked at send time: a revoked/suspended client gets nothing.
    const { data: sess } = await admin.from('client_sessions')
      .select('access_status').eq('storage_key', storageKey).maybeSingle();
    if (!sess || (sess.access_status ?? 'active') !== 'active') {
      await finish({ status: 'suppressed', suppression_reason: 'access_not_active' });
      return ok({ eventId, status: 'suppressed', reason: 'access_not_active', results: [] });
    }

    const { data: devices } = await admin.from('push_devices')
      .select('id, endpoint, p256dh, auth_secret, push_host, failure_count')
      .eq('client_id', clientId).eq('status', 'active').limit(MAX_DEVICES_PER_SEND);
    const targets = (devices ?? []).filter((d: any) => d.endpoint && d.p256dh && d.auth_secret);
    if (!targets.length) {
      await finish({ status: 'suppressed', suppression_reason: 'no_active_device' });
      return ok({ eventId, status: 'suppressed', reason: 'no_active_device', results: [] });
    }

    const payload = JSON.stringify({ v: 1, kind: tpl.kind, title: tpl.title, body: tpl.body, url: tpl.url, tag: tpl.tag, eventId });
    const results: Array<Record<string, unknown>> = [];
    for (const d of targets) {                                  // bounded: ≤ MAX_DEVICES_PER_SEND
      const r = await sendWebPush(
        { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth_secret }, payload, v,
        { ttlSec: tpl.ttlSec, urgency: 'normal', topic: tpl.tag }, fetchImpl, Math.floor(nowMs / 1000));
      let outcome: 'delivered' | 'expired' | 'failed';
      if (r.status >= 200 && r.status < 300) {
        outcome = 'delivered';
        await admin.from('push_devices').update({ last_success_at: nowIso, failure_count: 0, updated_at: nowIso }).eq('id', d.id);
      } else if (r.status === 404 || r.status === 410) {
        outcome = 'expired';
        await admin.from('push_devices').update({
          status: 'expired', disabled_reason: `push_service_${r.status}`,
          endpoint: '', p256dh: '', auth_secret: '', last_failure_at: nowIso, updated_at: nowIso,
        }).eq('id', d.id);
      } else {
        outcome = 'failed';
        const fc = (d.failure_count ?? 0) + 1;
        await admin.from('push_devices').update({
          failure_count: fc, last_failure_at: nowIso, updated_at: nowIso,
          ...(fc >= DISABLE_AFTER_FAILURES ? { status: 'disabled', disabled_reason: 'repeated_failures' } : {}),
        }).eq('id', d.id);
      }
      results.push({ deviceId: d.id, host: d.push_host, httpStatus: r.status, outcome, ...(r.error ? { error: r.error } : {}) });
    }

    const delivered = results.filter((r) => r.outcome === 'delivered').length;
    const status = delivered === results.length ? 'sent' : delivered > 0 ? 'partial' : 'failed';
    await finish({
      status, results, device_count: results.length, success_count: delivered,
      sent_at: delivered > 0 ? nowIso : null,
    });
    return ok({ eventId, status, results });
  }

  // ── entry ─────────────────────────────────────────────────────────────────
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method === 'GET') {
      const t = new URL(req.url).searchParams.get('type');
      if (t === 'ping') return ok({ v: PUSH_VERSION, configured: !!(await vapidOrNull()) });
      return err('post_only', 405);
    }
    if (req.method !== 'POST') return err('method_not_allowed', 405);

    let text: string;
    try { text = await req.text(); } catch { return err('bad_body', 400); }
    if (text.length > MAX_BODY_BYTES) return err('body_too_large', 413);
    let body: any;
    try { body = JSON.parse(text); } catch { return err('bad_json', 400); }
    const type: string = typeof body?.type === 'string' ? body.type : '';

    try {
      switch (type) {
        case 'ping':            return ok({ v: PUSH_VERSION, configured: !!(await vapidOrNull()) });
        case 'pushStatus':      return await pushStatus(body);
        case 'pushSubscribe':   return await pushSubscribe(body);
        case 'pushUnsubscribe': return await pushUnsubscribe(body);
        case 'coachPushSend':   return await coachPushSend(body);
        default:                return err('unknown_type', 400);
      }
    } catch (e) {
      log(type, 'internal_error', String((e as any)?.message ?? e));
      return err('internal_error', 500);    // no detail: never echo internals to callers
    }
  };
}
