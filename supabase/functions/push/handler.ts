// ============================================================================
// LOCKED IN Push Notifications V1 — handler
//
// Separate Edge Function (`push`). The `api` function is not touched and not
// redeployed by anything in this subsystem.
//
// Ops (POST, body { type, ... }, same request style as `api`):
//   client token:
//     pushStatus       VAPID public key + whether THIS endpoint is registered
//     pushSubscribe    register this browser's subscription (= explicit opt-in)
//     pushUnsubscribe  revoke this browser's subscription
//     pushPrefsGet     read notification settings
//     pushPrefsSet     change notification settings (client-owned fields only)
//   coach token:
//     coachPushSend    send the fixed `test` template to one client
//   internal secret (sha256 in push_internal_auth):
//     pushTick         scheduler: weigh-in + check-in reminders, deferred events   [x-push-cron-secret]
//                      (V2: check-in adherence sequence due → followup → final for
//                       clients in PUSH_CHECKIN_V2_CLIENTS; see schedule.ts)
//     programUpdated   deploy notifier: a verified-live programme update            [x-push-deploy-secret]
//   none:
//     ping             liveness + "is VAPID configured" (no secrets)
//
// Hard boundaries (each has a test in tests/push_proof.test.js or push_v1.test.js):
//   * Client identity comes ONLY from verifyClientToken(token, storageKey).
//   * Push eligibility is decided server-side from trusted state and gates every
//     client, coach, scheduler and deploy op: NOT internal AND access active AND the
//     client's resolved products include locked_in_1to1 (the api's own resolution:
//     active client_entitlements rows, else the pre-cutover entitlement_legacy marker).
//     Self-guided-only, internal, revoked/suspended and unprovisioned clients: refused.
//     PUSH_ALLOWED_CLIENTS is only an explicit exception list (e.g. _push_canary).
//     Any read error → not eligible (fail closed). No caller-supplied flag is read.
//   * Endpoints must be https on an allow-listed push-service host.
//   * Responses and logs never contain endpoints, subscription keys, tokens or secrets.
//   * Payloads come from fixed, lock-screen-safe templates only.
//   * Reminders are sent only after the client's CURRENT state says they are needed;
//     every logical notification has a deterministic dedupe key (claimed once, ever).
//   * 404/410 from a push service expires the device and wipes its endpoint+keys.
// ============================================================================
import {
  b64urlDecode, importP256PublicEcdh, importVapidKeys, sendWebPush,
  type VapidKeys,
} from './webpush.ts';
import {
  decideReminder, evaluateCheckin, evaluateCheckinStage, evaluateWeighin, formatTime, inQuietHours,
  isValidTimezone, localParts, nextLocalTime, parseTime, type Observation, type Prefs,
} from './schedule.ts';

export type PushEnv = {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  coachPasswordHash: string;
  allowedClients: Set<string>;
  /** V2 check-in adherence sequence rollout: '*' = every eligible client, else these keys. Unset = nobody (V1 single reminder). */
  checkinSequence?: { all: boolean; keys: Set<string> };
};

export function readPushEnv(get: (k: string) => string | undefined): PushEnv {
  const allowed = String(get('PUSH_ALLOWED_CLIENTS') ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const seq = String(get('PUSH_CHECKIN_V2_CLIENTS') ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    vapidPublicKey: get('VAPID_PUBLIC_KEY') ?? '',
    vapidPrivateKey: get('VAPID_PRIVATE_KEY') ?? '',
    vapidSubject: get('VAPID_SUBJECT') ?? '',
    coachPasswordHash: get('COACH_PASSWORD_HASH') ?? '',
    allowedClients: new Set(allowed),
    checkinSequence: { all: seq.includes('*'), keys: new Set(seq.filter((k) => k !== '*')) },
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
export const PUSH_VERSION = 'push-v2';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ENDPOINT_LEN = 1024;
const MAX_ACTIVE_DEVICES_PER_CLIENT = 5;
const MAX_EVENTS_PER_CLIENT_PER_DAY = 20;
const MAX_DEVICES_PER_SEND = 10;
const MAX_TICK_CLIENTS = 500;
const LOCKED_IN_1TO1 = 'locked_in_1to1';

// Verbatim copy of api/index.ts entitlementRowIsActive — tests/push_v1.test.js
// fails if this body drifts from the api's, so both functions agree on "active".
function entitlementRowIsActive(row: { status?: string; starts_at?: string | null; ends_at?: string | null }, nowMs: number): boolean {
  if (row?.status !== 'active') return false;
  if (row.starts_at && Date.parse(row.starts_at) > nowMs) return false;
  if (row.ends_at   && Date.parse(row.ends_at)  <= nowMs) return false;
  return true;
}
const MAX_DEFERRED_PER_TICK = 50;
const DISABLE_AFTER_FAILURES = 5;
const CLIENT_KEY_RE = /^[a-z0-9_]{2,40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

// Push-service hosts. Exact names, or a strict subdomain of a suffix entry.
const PUSH_HOSTS_EXACT = new Set([
  'web.push.apple.com',               // Safari / iOS Home-Screen web apps
  'fcm.googleapis.com',               // Chrome, Android, Edge (Chromium)
  'updates.push.services.mozilla.com' // Firefox
]);
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

type Template = { kind: string; title: string; body: string; url: string; tag: string; ttlSec: number };

// Fixed templates. Lock-screen safe: no numbers, no targets, no health data.
// url is resolved by sw.js against the client's own registration scope.
export const TEMPLATES: Record<string, Template> = {
  test:             { kind: 'test',             title: 'LOCKED IN', body: 'Test notification. Tap to open your programme.', url: './', tag: 'li-test',    ttlSec: 3600 },
  weighin_reminder: { kind: 'weighin_reminder', title: 'LOCKED IN', body: "Morning bro. Log your weight when you're up.", url: './', tag: 'li-weighin', ttlSec: 2 * 3600 },
  checkin_reminder: { kind: 'checkin_reminder', title: 'LOCKED IN', body: 'Your weekly check-in is ready when you are.',  url: './', tag: 'li-checkin', ttlSec: 6 * 3600 },
  program_update:   { kind: 'program_update',   title: 'LOCKED IN', body: 'Your program has been updated. Tap to view it.', url: './', tag: 'li-program', ttlSec: 24 * 3600 },
  // V2 check-in adherence sequence. Same kind + tag: a later stage replaces an
  // unread earlier one on the lock screen instead of stacking. TTLs end before
  // the next default stage, so an offline phone never receives a stale stage.
  checkin_due:      { kind: 'checkin_reminder', title: 'LOCKED IN', body: 'Your weekly check-in is ready. Take a minute to get it done.', url: './', tag: 'li-checkin', ttlSec: 6 * 3600 },
  checkin_followup: { kind: 'checkin_reminder', title: 'LOCKED IN', body: 'Your check-in is still waiting. Get it done tonight so Omar can review your week.', url: './', tag: 'li-checkin', ttlSec: 3 * 3600 },
  checkin_final:    { kind: 'checkin_reminder', title: 'LOCKED IN', body: 'You missed your weekly check-in. Get it done today so your coaching stays on track.', url: './', tag: 'li-checkin', ttlSec: 8 * 3600 },
};

// Settings: defaults (conservative — nothing is sent until the client opts in).
const PREF_COLUMNS = 'client_id, notifications_enabled, consent_at, timezone, weighin_available, weighin_enabled, weighin_time, checkin_enabled, checkin_dow, checkin_time, program_updates_enabled, quiet_start, quiet_end';
// Scheduler only: + the coach-owned V2 stage schedule (migration 20260930120000).
const TICK_PREF_COLUMNS = PREF_COLUMNS + ', checkin_followup_time, checkin_final_time, checkin_final_day_offset';
export const DEFAULT_PREFS = {
  notifications_enabled: false, timezone: null as string | null, weighin_available: false,
  weighin_enabled: true, weighin_time: '07:30', checkin_enabled: true, checkin_dow: 0,
  checkin_time: '09:00', program_updates_enabled: true, quiet_start: '21:00', quiet_end: '07:00',
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

const isDup = (e: any) => /duplicate key|23505/i.test(`${e?.message ?? ''} ${e?.code ?? ''}`);

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
  return isValidTimezone(tz) ? tz : null;
}

/** Client-facing view of a preferences row (camelCase, HH:MM, no internals). */
function publicPrefs(row: any | null) {
  const p = { ...DEFAULT_PREFS, ...(row ?? {}) };
  const t = (v: string) => formatTime(parseTime(v) ?? 0);
  return {
    optedIn: !!row?.consent_at,
    notificationsEnabled: !!p.notifications_enabled,
    timezone: p.timezone ?? null,
    weighinAvailable: !!p.weighin_available,
    weighinEnabled: !!p.weighin_enabled,
    weighinTime: t(p.weighin_time),
    checkinEnabled: !!p.checkin_enabled,
    checkinDow: p.checkin_dow,
    checkinTime: t(p.checkin_time),
    programUpdatesEnabled: !!p.program_updates_enabled,
    quietStart: t(p.quiet_start),
    quietEnd: t(p.quiet_end),
  };
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

  /** Internal callers: sha256(presented secret) must equal push_internal_auth.<name>. No row → refused. */
  async function verifyInternal(name: 'cron' | 'deploy', presented: string | null): Promise<boolean> {
    if (!presented || presented.length < 32 || presented.length > 256) return false;
    const { data, error } = await admin.from('push_internal_auth').select('secret_sha256').eq('name', name).maybeSingle();
    if (error || !data?.secret_sha256) return false;
    return timingSafeEqual(await sha256(presented), String(data.secret_sha256));
  }

  type ClientRow = { id: string; storage_key: string; is_internal?: boolean | null; entitlement_legacy?: boolean | null };
  const CLIENT_ELIG_COLS = 'id, storage_key, is_internal, entitlement_legacy';

  /**
   * Push eligibility for a batch of clients — trusted server state only.
   *   eligible ⇔ explicit PUSH_ALLOWED_CLIENTS entry
   *            OR (NOT is_internal AND client_sessions.access_status = 'active'
   *                AND resolved products ∋ locked_in_1to1)
   *   resolved products = active client_entitlements rows (same rule as the api),
   *                       else ['locked_in_1to1'] when entitlement_legacy = true, else none.
   * Returns the eligible ids and each client's access status. Any read error → nobody.
   */
  async function resolveEligibility(rows: ClientRow[]): Promise<{ eligible: Set<string>; access: Map<string, string> }> {
    const eligible = new Set<string>(), access = new Map<string, string>();
    if (!rows.length) return { eligible, access };
    const { data: sess, error: sErr } = await admin.from('client_sessions')
      .select('storage_key, access_status').in('storage_key', rows.map((r) => r.storage_key));
    const { data: ents, error: eErr } = await admin.from('client_entitlements')
      .select('client_id, product_code, status, starts_at, ends_at').in('client_id', rows.map((r) => r.id));
    if (sErr || eErr) { log('eligibility', 'read_failed', (sErr ?? eErr)?.message ?? ''); return { eligible, access }; }
    for (const s of sess ?? []) access.set(s.storage_key, String(s.access_status ?? ''));
    const nowMs = now();
    const products = new Map<string, Set<string>>();
    for (const e of ents ?? []) {
      if (!entitlementRowIsActive(e, nowMs)) continue;
      if (!products.has(e.client_id)) products.set(e.client_id, new Set());
      products.get(e.client_id)!.add(String(e.product_code));
    }
    for (const r of rows) {
      if (env.allowedClients.has(r.storage_key)) { eligible.add(r.id); continue; }   // explicit exception list
      if (r.is_internal !== false) continue;                    // internal (or unknown) → never automatic
      if (access.get(r.storage_key) !== 'active') continue;
      const p = products.get(r.id) ?? (r.entitlement_legacy === true ? new Set([LOCKED_IN_1TO1]) : new Set<string>());
      if (p.has(LOCKED_IN_1TO1)) eligible.add(r.id);
    }
    return { eligible, access };
  }

  async function isEligible(row: ClientRow): Promise<boolean> {
    return (await resolveEligibility([row])).eligible.has(row.id);
  }

  /** Token → canonical client → eligibility. Returns a Response on failure. */
  async function authClient(body: any): Promise<{ clientId: string; storageKey: string } | Response> {
    const storageKey = String(body?.storageKey ?? '').trim().toLowerCase();
    if (!CLIENT_KEY_RE.test(storageKey)) return err('bad_storageKey', 400);
    const token = typeof body?.token === 'string' ? body.token : undefined;
    const v = await verifyClientToken(token, storageKey);
    if (!v.ok) return err(v.reason ?? 'unauthorized', 401);
    const { data: client } = await admin.from('clients').select(CLIENT_ELIG_COLS).eq('storage_key', storageKey).single();
    if (!client?.id) return err('unknown_client', 401);
    if (!(await isEligible(client))) return err('push_not_enabled', 403);
    return { clientId: client.id, storageKey };
  }

  async function loadPrefs(clientId: string): Promise<any | null> {
    const { data } = await admin.from('push_preferences').select(PREF_COLUMNS).eq('client_id', clientId).maybeSingle();
    return data ?? null;
  }

  // ── shared delivery: one event → all active devices of one client ─────────
  async function deliver(eventId: string, clientId: string, tpl: Template, v: VapidKeys, nowMs: number):
      Promise<{ status: string; reason?: string; results: Array<Record<string, unknown>> }> {
    const nowIso = new Date(nowMs).toISOString();
    const finish = async (fields: Record<string, unknown>) => {
      const { error } = await admin.from('notification_events').update(fields).eq('id', eventId);
      if (error) log('deliver', 'finish_failed', error.message);
    };
    const { data: devices } = await admin.from('push_devices')
      .select('id, endpoint, p256dh, auth_secret, push_host, failure_count')
      .eq('client_id', clientId).eq('status', 'active').limit(MAX_DEVICES_PER_SEND);
    const targets = (devices ?? []).filter((d: any) => d.endpoint && d.p256dh && d.auth_secret);
    if (!targets.length) {
      await finish({ status: 'suppressed', suppression_reason: 'no_active_device' });
      return { status: 'suppressed', reason: 'no_active_device', results: [] };
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
    await finish({ status, results, device_count: results.length, success_count: delivered, sent_at: delivered > 0 ? nowIso : null });
    return { status, results };
  }

  /** Insert the event row. The unique dedupe_key IS the send authorisation. */
  async function claim(row: Record<string, unknown>): Promise<{ id: string } | 'duplicate' | null> {
    const { data, error } = await admin.from('notification_events').insert(row).select('id').single();
    if (data?.id) return { id: data.id };
    if (isDup(error)) return 'duplicate';
    log('claim', 'insert_failed', error?.message ?? 'no_id');
    return null;
  }

  async function activeDeviceCount(clientId: string): Promise<number> {
    const { count } = await admin.from('push_devices').select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).eq('status', 'active');
    return count ?? 0;
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

  // ── pushSubscribe (= the explicit opt-in) ─────────────────────────────────
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

    let deviceId: string;
    let created: boolean;
    if (existing) {
      const { error } = await admin.from('push_devices').update(fields)
        .eq('id', existing.id).eq('client_id', a.clientId);
      if (error) { log('pushSubscribe', 'update_failed', error.message); return err('write_failed', 500); }
      deviceId = existing.id; created = false;
    } else {
      const { count } = await admin.from('push_devices')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', a.clientId).eq('status', 'active');
      if ((count ?? 0) >= MAX_ACTIVE_DEVICES_PER_CLIENT) return err('too_many_devices', 429);
      const { data: ins, error } = await admin.from('push_devices').insert({
        client_id: a.clientId, storage_key: a.storageKey, endpoint_hash: endpointHash,
        created_at: nowIso, ...fields,
      }).select('id').single();
      if (error || !ins?.id) {
        if (isDup(error)) return err('retry', 409);   // concurrent insert of the same endpoint
        log('pushSubscribe', 'insert_failed', error?.message ?? 'no_id');
        return err('write_failed', 500);
      }
      deviceId = ins.id; created = true;
    }

    // Opt-in: a subscription is only ever created from a user gesture in the
    // browser, so this is where consent is recorded and notifications enabled.
    const prefs = await loadPrefs(a.clientId);
    if (!prefs) {
      const { error } = await admin.from('push_preferences').insert({
        client_id: a.clientId, storage_key: a.storageKey, notifications_enabled: true,
        consent_at: nowIso, timezone, updated_at: nowIso, updated_by: 'client',
      });
      if (error && !isDup(error)) log('pushSubscribe', 'prefs_insert_failed', error.message);
    } else {
      const { error } = await admin.from('push_preferences').update({
        notifications_enabled: true, consent_at: prefs.consent_at ?? nowIso,
        timezone: prefs.timezone ?? timezone, updated_at: nowIso, updated_by: 'client',
      }).eq('client_id', a.clientId);
      if (error) log('pushSubscribe', 'prefs_update_failed', error.message);
    }
    return ok({ deviceId, created });
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

  // ── pushPrefsGet / pushPrefsSet ───────────────────────────────────────────
  async function pushPrefsGet(body: any): Promise<Response> {
    const a = await authClient(body);
    if (a instanceof Response) return a;
    return ok({ prefs: publicPrefs(await loadPrefs(a.clientId)) });
  }

  async function pushPrefsSet(body: any): Promise<Response> {
    const a = await authClient(body);
    if (a instanceof Response) return a;
    const prefs = await loadPrefs(a.clientId);
    if (!prefs?.consent_at) return err('not_opted_in', 409);   // settings exist only after the opt-in tap
    const inp = body?.prefs;
    if (!inp || typeof inp !== 'object') return err('bad_prefs', 400);

    // Client-owned fields ONLY. weighin_available and checkin_dow are coach-owned.
    const patch: Record<string, unknown> = {};
    const bools: Array<[string, string]> = [
      ['notificationsEnabled', 'notifications_enabled'], ['weighinEnabled', 'weighin_enabled'],
      ['checkinEnabled', 'checkin_enabled'], ['programUpdatesEnabled', 'program_updates_enabled'],
    ];
    for (const [k, col] of bools) {
      if (k in inp) { if (typeof inp[k] !== 'boolean') return err('bad_' + k, 400); patch[col] = inp[k]; }
    }
    const times: Array<[string, string]> = [
      ['weighinTime', 'weighin_time'], ['checkinTime', 'checkin_time'],
      ['quietStart', 'quiet_start'], ['quietEnd', 'quiet_end'],
    ];
    for (const [k, col] of times) {
      if (k in inp) {
        const m = parseTime(inp[k]);
        if (m === null || m % 15 !== 0) return err('bad_' + k, 400);    // 15-minute steps, like the UI
        patch[col] = formatTime(m);
      }
    }
    if ('timezone' in inp) {
      if (!isValidTimezone(inp.timezone)) return err('bad_timezone', 400);
      patch.timezone = inp.timezone;
    }
    const unknown = Object.keys(inp).filter((k) => ![...bools, ...times].some(([n]) => n === k) && k !== 'timezone');
    if (unknown.length) return err('unknown_field', 400, { field: unknown[0].slice(0, 40) });
    if (!Object.keys(patch).length) return ok({ prefs: publicPrefs(prefs) });

    const nowIso = new Date(now()).toISOString();
    const { error } = await admin.from('push_preferences')
      .update({ ...patch, updated_at: nowIso, updated_by: 'client' }).eq('client_id', a.clientId);
    if (error) { log('pushPrefsSet', 'update_failed', error.message); return err('write_failed', 500); }
    return ok({ prefs: publicPrefs(await loadPrefs(a.clientId)) });
  }

  // ── coachPushSend ─────────────────────────────────────────────────────────
  async function coachPushSend(body: any): Promise<Response> {
    if (!verifyCoachToken(body?.coachToken)) return err('unauthorized', 401);
    const storageKey = String(body?.storageKey ?? '').trim().toLowerCase();
    if (!CLIENT_KEY_RE.test(storageKey)) return err('bad_storageKey', 400);
    const tpl = String(body?.template ?? '') === 'test' ? TEMPLATES.test : null;   // coach: test only
    if (!tpl) return err('unknown_template', 400);
    const { data: client } = await admin.from('clients').select(CLIENT_ELIG_COLS).eq('storage_key', storageKey).maybeSingle();
    if (!client?.id) return err('unknown_client', 404);
    if (!(await isEligible(client))) return err('push_not_enabled', 403);
    const requestId = String(body?.requestId ?? '');
    if (!REQUEST_ID_RE.test(requestId)) return err('bad_requestId', 400);
    const v = await vapidOrNull();
    if (!v) return err('push_not_configured', 503);
    const clientId: string = client.id;
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    const { count: recent } = await admin.from('notification_events')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).gte('created_at', new Date(nowMs - 86400_000).toISOString());
    if ((recent ?? 0) >= MAX_EVENTS_PER_CLIENT_PER_DAY) return err('daily_cap_reached', 429);

    const dedupeKey = `coach:${requestId}:${clientId}`;
    const c = await claim({
      client_id: clientId, storage_key: storageKey, kind: tpl.kind, dedupe_key: dedupeKey,
      status: 'claimed', title: tpl.title, body: tpl.body, url: tpl.url,
      created_by: 'coach', request_id: requestId, created_at: nowIso, eligible_at: nowIso,
    });
    if (c === 'duplicate') {
      const { data: prior } = await admin.from('notification_events')
        .select('id, status').eq('dedupe_key', dedupeKey).maybeSingle();
      return ok({ duplicate: true, eventId: prior?.id ?? null, status: prior?.status ?? null });
    }
    if (!c) return err('write_failed', 500);

    const { data: sess } = await admin.from('client_sessions')
      .select('access_status').eq('storage_key', storageKey).maybeSingle();
    if (!sess || (sess.access_status ?? 'active') !== 'active') {
      await admin.from('notification_events').update({ status: 'suppressed', suppression_reason: 'access_not_active' }).eq('id', c.id);
      return ok({ eventId: c.id, status: 'suppressed', reason: 'access_not_active', results: [] });
    }
    const r = await deliver(c.id, clientId, tpl, v, nowMs);
    return ok({ eventId: c.id, ...r });
  }

  /** V2 rollout gate (PUSH_CHECKIN_V2_CLIENTS). Off-sequence clients keep the V1 single Sunday reminder. */
  function inCheckinSequence(storageKey: string): boolean {
    const s = env.checkinSequence;
    return !!s && (s.all || s.keys.has(storageKey));
  }

  // ── pushTick: the scheduler ───────────────────────────────────────────────
  // Called every 15 minutes by pg_cron. A timer firing is NOT a reason to send:
  // for each allow-listed, opted-in client it asks "is a reminder window open?",
  // then checks the client's real state, then claims a deterministic dedupe key.
  // Anything uncertain → silence. Bounded: ≤ MAX_TICK_CLIENTS clients × 2 kinds,
  // ≤ MAX_DEFERRED_PER_TICK deferred events, ≤ MAX_DEVICES_PER_SEND per send.
  async function pushTick(req: Request): Promise<Response> {
    if (!(await verifyInternal('cron', req.headers.get('x-push-cron-secret')))) return err('unauthorized', 401);
    const v = await vapidOrNull();
    if (!v) return err('push_not_configured', 503);
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const summary = { clients: 0, due: 0, sent: 0, duplicates: 0, suppressed: {} as Record<string, number>, stateErrors: 0, deferredSent: 0,
                      checkinStages: { due: 0, followup: 0, final: 0 } as Record<string, number> };
    const bump = (r: string) => { summary.suppressed[r] = (summary.suppressed[r] ?? 0) + 1; };

    // ── V2 check-in adherence sequence: one step per client per tick ───────
    // evaluateCheckinStage says which stage (if any) is open; decideReminder
    // applies the one adherence pattern; the dedupe claim authorises the send.
    const checkinSequenceStep = async (c: any, pr: any, active: boolean): Promise<void> => {
      const ev = evaluateCheckinStage(pr, nowMs, c.start_date);
      if (!ev.due) return;
      summary.due++;
      const key = `checkin_${ev.stage}:${c.id}:${ev.periodKey}`;
      // Already decided for this stage (sent OR suppressed) → nothing, ever. The
      // due stage also honours a V1 single reminder already claimed for the same
      // period, so moving a client onto the sequence mid-Sunday cannot double up.
      const prior = [key, ...(ev.stage === 'due' ? [`checkin:${c.id}:${ev.periodKey}`] : [])];
      const { data: seen, error: seenErr } = await admin.from('notification_events').select('id').in('dedupe_key', prior).limit(1);
      if (seenErr) { summary.stateErrors++; log('pushTick', 'dedupe_read_failed', seenErr.message); return; }
      if ((seen ?? []).length) { summary.duplicates++; return; }
      // Observation: the client's check-in state, read immediately before deciding.
      const { count, error } = await admin.from('check_ins').select('id', { count: 'exact', head: true }).eq('client_id', c.id)
        .gte('submitted_at', new Date(ev.stateFrom).toISOString()).lte('submitted_at', new Date(ev.stateTo).toISOString());
      const observation: Observation = error || typeof count !== 'number' ? 'unknown' : count > 0 ? 'completed' : 'incomplete';
      const d = decideReminder({
        due: true, observation, eligible: true /* tick evaluates eligible clients only */, active,
        enabled: ev.suppress !== 'disabled', quiet: ev.suppress === 'quiet_hours',
        hasDevice: observation === 'incomplete' ? (await activeDeviceCount(c.id)) > 0 : true,
      });
      if (!d.send && !d.record) {                                   // unknown state → silence, retry next tick
        summary.stateErrors++; log('pushTick', 'state_query_failed', `checkin_${ev.stage}:${error?.message ?? 'no_count'}`); return;
      }
      const tpl = TEMPLATES[`checkin_${ev.stage}`];
      const reason = d.send ? null : d.reason;
      const got = await claim({
        client_id: c.id, storage_key: c.storage_key, kind: tpl.kind, dedupe_key: key,
        status: reason ? 'suppressed' : 'claimed', suppression_reason: reason,
        title: tpl.title, body: tpl.body, url: tpl.url, created_by: 'system',
        created_at: nowIso, eligible_at: new Date(ev.eligibleAt).toISOString(), period_key: ev.periodKey,
      });
      if (got === 'duplicate') { summary.duplicates++; return; }
      if (!got) { summary.stateErrors++; return; }
      if (reason) { bump(reason); return; }
      const r = await deliver(got.id, c.id, tpl, v, nowMs);
      if (r.status === 'sent' || r.status === 'partial') { summary.sent++; summary.checkinStages[ev.stage]++; }
      else bump(r.reason ?? r.status);
    };

    // Only clients who opted in have a preferences row; evaluate those, and only
    // the ones that are push-eligible right now (entitlement / access / internal).
    const { data: prefAll, error: pErr } = await admin.from('push_preferences').select(TICK_PREF_COLUMNS).limit(MAX_TICK_CLIENTS);
    if (pErr) { log('pushTick', 'prefs_failed', pErr.message); return err('state_unavailable', 503); }
    const optedIds = (prefAll ?? []).filter((p: any) => p.consent_at).map((p: any) => p.client_id);
    if (!optedIds.length) return ok({ summary });

    const { data: clients, error: cErr } = await admin.from('clients')
      .select(`${CLIENT_ELIG_COLS}, is_paused, start_date`).in('id', optedIds);
    if (cErr) { log('pushTick', 'clients_failed', cErr.message); return err('state_unavailable', 503); }
    const { eligible, access } = await resolveEligibility((clients ?? []) as ClientRow[]);
    const byId = new Map<string, any>((clients ?? []).filter((c: any) => eligible.has(c.id)).map((c: any) => [c.id, c]));
    const isActive = (c: any) => access.get(c.storage_key) === 'active' && c.is_paused !== true;
    const prefRows = (prefAll ?? []).filter((p: any) => byId.has(p.client_id));

    for (const pr of (prefRows ?? []) as Prefs[] & any[]) {
      const c = byId.get(pr.client_id);
      if (!c || !pr.consent_at) continue;                         // never opted in → never evaluated
      summary.clients++;
      const onSequence = inCheckinSequence(c.storage_key);
      const checks: Array<[string, ReturnType<typeof evaluateWeighin>]> = [
        ['weighin_reminder', evaluateWeighin(pr, nowMs)],
        ...(onSequence ? [] : [['checkin_reminder', evaluateCheckin(pr, nowMs, c.start_date)] as [string, ReturnType<typeof evaluateWeighin>]]),
      ];
      if (onSequence) await checkinSequenceStep(c, pr, isActive(c));
      for (const [kind, ev] of checks) {
        if (!ev.due) continue;
        summary.due++;
        const tpl = TEMPLATES[kind];
        let reason: string | null = ev.suppress ?? null;
        if (!reason && !isActive(c)) reason = 'inactive_client';
        if (!reason && (await activeDeviceCount(c.id)) === 0) reason = 'no_active_device';
        if (kind === 'checkin_reminder') {
          // Rollback safety: a V2 due stage already claimed for this period counts as this reminder.
          const { data: v2seen, error: v2err } = await admin.from('notification_events').select('id').eq('dedupe_key', `checkin_due:${c.id}:${ev.periodKey}`).limit(1);
          if (v2err) { summary.stateErrors++; log('pushTick', 'dedupe_read_failed', v2err.message); continue; }
          if ((v2seen ?? []).length) { summary.duplicates++; continue; }
        }
        if (!reason) {
          // Current client state, read immediately before claiming.
          const q = kind === 'weighin_reminder'
            ? admin.from('weight_logs').select('id', { count: 'exact', head: true }).eq('client_id', c.id)
                .gte('logged_at', new Date(ev.stateFrom).toISOString()).lt('logged_at', new Date(ev.stateTo).toISOString())
            : admin.from('check_ins').select('id', { count: 'exact', head: true }).eq('client_id', c.id)
                .gte('submitted_at', new Date(ev.stateFrom).toISOString()).lte('submitted_at', new Date(ev.stateTo).toISOString());
          const { count, error } = await q;
          if (error || typeof count !== 'number') {                // unknown state → silence, retry next tick
            summary.stateErrors++; log('pushTick', 'state_query_failed', `${kind}:${error?.message ?? 'no_count'}`); continue;
          }
          if (count > 0) reason = kind === 'weighin_reminder' ? 'already_logged' : 'already_completed';
        }
        const got = await claim({
          client_id: c.id, storage_key: c.storage_key, kind, dedupe_key: `${kind === 'weighin_reminder' ? 'weighin' : 'checkin'}:${c.id}:${ev.periodKey}`,
          status: reason ? 'suppressed' : 'claimed', suppression_reason: reason,
          title: tpl.title, body: tpl.body, url: tpl.url, created_by: 'system',
          created_at: nowIso, eligible_at: new Date(ev.eligibleAt).toISOString(), period_key: ev.periodKey,
        });
        if (got === 'duplicate') { summary.duplicates++; continue; }
        if (!got) { summary.stateErrors++; continue; }
        if (reason) { bump(reason); continue; }
        const r = await deliver(got.id, c.id, tpl, v, nowMs);
        if (r.status === 'sent' || r.status === 'partial') summary.sent++; else bump(r.reason ?? r.status);
      }
    }

    // Deferred event-driven notifications whose quiet hours have ended.
    const { data: deferred } = await admin.from('notification_events')
      .select('id, client_id, storage_key, kind').eq('status', 'deferred')
      .lte('eligible_at', nowIso).limit(MAX_DEFERRED_PER_TICK);
    for (const e of deferred ?? []) {
      const c = byId.get(e.client_id);
      const tpl = TEMPLATES[e.kind];
      const pr = await loadPrefs(e.client_id);
      let reason: string | null = null;
      if (!c || !tpl) reason = 'not_allowlisted';
      else if (!pr?.notifications_enabled || !pr?.program_updates_enabled) reason = 'disabled';
      else if (!isActive(c)) reason = 'inactive_client';
      if (reason) {
        await admin.from('notification_events').update({ status: 'suppressed', suppression_reason: reason }).eq('id', e.id).eq('status', 'deferred');
        bump(reason); continue;
      }
      // Take it out of 'deferred' first so a concurrent tick cannot send it twice.
      const { data: took } = await admin.from('notification_events').update({ status: 'claimed' })
        .eq('id', e.id).eq('status', 'deferred').select('id');
      if (!(took ?? []).length) { summary.duplicates++; continue; }
      const r = await deliver(e.id, e.client_id, tpl, v, nowMs);
      if (r.status === 'sent' || r.status === 'partial') summary.deferredSent++; else bump(r.reason ?? r.status);
    }
    return ok({ summary });
  }

  // ── programUpdated: observes a verified-live deploy, then notifies ────────
  // Called ONLY by the deploy notifier after the served shell bytes equal the
  // committed bytes. It never causes or participates in the deployment.
  async function programUpdated(req: Request, body: any): Promise<Response> {
    if (!(await verifyInternal('deploy', req.headers.get('x-push-deploy-secret')))) return err('unauthorized', 401);
    const storageKey = String(body?.storageKey ?? '').trim().toLowerCase();
    if (!CLIENT_KEY_RE.test(storageKey)) return err('bad_storageKey', 400);
    const deployHash = String(body?.deployHash ?? '');
    if (!SHA256_HEX_RE.test(deployHash)) return err('bad_deployHash', 400);
    const commit = body?.commit == null ? null : String(body.commit);
    if (commit !== null && !COMMIT_RE.test(commit)) return err('bad_commit', 400);
    const v = await vapidOrNull();
    if (!v) return err('push_not_configured', 503);

    const { data: c } = await admin.from('clients').select(`${CLIENT_ELIG_COLS}, is_paused`).eq('storage_key', storageKey).maybeSingle();
    if (!c?.id) return err('unknown_client', 404);
    if (!(await isEligible(c))) return err('push_not_enabled', 403);   // nothing recorded for ineligible clients
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const tpl = TEMPLATES.program_update;
    const pr = await loadPrefs(c.id);
    const { data: sess } = await admin.from('client_sessions').select('access_status').eq('storage_key', storageKey).maybeSingle();

    let reason: string | null = null;
    let deferUntil: number | null = null;
    if (!pr?.consent_at || !pr.notifications_enabled || !pr.program_updates_enabled) reason = 'disabled';
    else if (!sess || (sess.access_status ?? 'active') !== 'active' || c.is_paused === true) reason = 'inactive_client';
    else if (!isValidTimezone(pr.timezone)) reason = 'no_timezone';
    else if ((await activeDeviceCount(c.id)) === 0) reason = 'no_active_device';
    else {
      const qs = parseTime(pr.quiet_start) ?? 0, qe = parseTime(pr.quiet_end) ?? 0;
      if (inQuietHours(localParts(nowMs, pr.timezone).minuteOfDay, qs, qe)) deferUntil = nextLocalTime(nowMs, qe, pr.timezone);
    }

    const got = await claim({
      client_id: c.id, storage_key: storageKey, kind: tpl.kind, dedupe_key: `program_update:${c.id}:${deployHash}`,
      status: reason ? 'suppressed' : deferUntil ? 'deferred' : 'claimed', suppression_reason: reason,
      title: tpl.title, body: tpl.body, url: tpl.url, created_by: 'system', request_id: commit,
      created_at: nowIso, eligible_at: new Date(deferUntil ?? nowMs).toISOString(), period_key: deployHash,
    });
    if (got === 'duplicate') return ok({ duplicate: true });
    if (!got) return err('write_failed', 500);
    if (reason) return ok({ eventId: got.id, status: 'suppressed', reason });
    if (deferUntil) return ok({ eventId: got.id, status: 'deferred', eligibleAt: new Date(deferUntil).toISOString() });
    const r = await deliver(got.id, c.id, tpl, v, nowMs);
    return ok({ eventId: got.id, ...r });
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
        case 'pushPrefsGet':    return await pushPrefsGet(body);
        case 'pushPrefsSet':    return await pushPrefsSet(body);
        case 'coachPushSend':   return await coachPushSend(body);
        case 'pushTick':        return await pushTick(req);
        case 'programUpdated':  return await programUpdated(req, body);
        default:                return err('unknown_type', 400);
      }
    } catch (e) {
      log(type, 'internal_error', String((e as any)?.message ?? e));
      return err('internal_error', 500);    // no detail: never echo internals to callers
    }
  };
}
