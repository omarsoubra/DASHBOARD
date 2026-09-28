// ============================================================================
// LOCKED IN Push Notifications — standard Web Push, no vendor SDK.
//
//   RFC 8291  Message Encryption for Web Push        (aes128gcm body)
//   RFC 8188  Encrypted Content-Encoding for HTTP    (record header)
//   RFC 8292  VAPID                                  (ES256 JWT auth)
//
// WebCrypto only. No Deno or Node APIs, so the exact same source runs in the
// Supabase Edge runtime and in the Node test harness (tests/push_proof.test.js),
// where it is checked against the RFC 8291 Appendix A vector and against an
// independent decryptor built on node:crypto.
//
// Secrets: the VAPID private key enters this module only as a CryptoKey built
// by importVapidKeys(). Nothing here logs, returns or serialises it.
// ============================================================================

const enc = new TextEncoder();

// ── base64url ───────────────────────────────────────────────────────────────
const B64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict decoder: throws on anything that is not base64url. */
export function b64urlDecode(str: string): Uint8Array {
  if (typeof str !== 'string' || !B64URL_RE.test(str)) throw new Error('bad_base64url');
  const clean = str.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('bad_base64url');
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((clean.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ── P-256 key helpers ───────────────────────────────────────────────────────
/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
export function isUncompressedP256(bytes: Uint8Array): boolean {
  return bytes.length === 65 && bytes[0] === 0x04;
}

/** Imports a receiver (browser) public key; rejects points not on the curve. */
export async function importP256PublicEcdh(raw: Uint8Array): Promise<CryptoKey> {
  if (!isUncompressedP256(raw)) throw new Error('bad_p256_point');
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

function jwkFromRaw(publicRaw: Uint8Array, privateRaw?: Uint8Array): JsonWebKey {
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256',
    x: b64urlEncode(publicRaw.slice(1, 33)),
    y: b64urlEncode(publicRaw.slice(33, 65)),
    ext: false,
  };
  if (privateRaw) jwk.d = b64urlEncode(privateRaw);
  return jwk;
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────────
export type VapidKeys = {
  publicKeyB64: string;          // 65-byte uncompressed point, base64url — public
  privateKey: CryptoKey;         // ECDSA P-256 signing key — never serialised
  subject: string;               // mailto: or https: contact for push services
};

const VAPID_SUBJECT_RE = /^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/;

/**
 * Builds the VAPID signing key from the two base64url env values and proves
 * they are one keypair (sign → verify). A mismatched pair would make every
 * push service answer 403, so it fails here, loudly, instead.
 */
export async function importVapidKeys(publicB64: string, privateB64: string, subject: string): Promise<VapidKeys> {
  if (!VAPID_SUBJECT_RE.test(subject || '')) throw new Error('vapid_subject_invalid');
  const pub = b64urlDecode(publicB64);
  const priv = b64urlDecode(privateB64);
  if (!isUncompressedP256(pub)) throw new Error('vapid_public_invalid');
  if (priv.length !== 32) throw new Error('vapid_private_invalid');
  let privateKey: CryptoKey;
  try {
    // Some runtimes already reject a d that does not match x/y at import.
    privateKey = await crypto.subtle.importKey(
      'jwk', jwkFromRaw(pub, priv), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch {
    throw new Error('vapid_keypair_mismatch');
  }
  const verifyKey = await crypto.subtle.importKey(
    'raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const probe = enc.encode('locked-in-vapid-selfcheck');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, probe);
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, probe);
  if (!good) throw new Error('vapid_keypair_mismatch');
  return { publicKeyB64: b64urlEncode(pub), privateKey, subject };
}

/** ES256 JWT for one push-service origin. exp is capped well under 24 h. */
export async function createVapidJwt(audience: string, vapid: VapidKeys, nowSec: number, ttlSec = 12 * 3600): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: audience, exp: nowSec + Math.min(ttlSec, 23 * 3600), sub: vapid.subject };
  const signingInput =
    b64urlEncode(enc.encode(JSON.stringify(header))) + '.' +
    b64urlEncode(enc.encode(JSON.stringify(claims)));
  // WebCrypto ECDSA emits raw r||s (IEEE P1363), which is exactly what JWS ES256 requires.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(signingInput)));
  return signingInput + '.' + b64urlEncode(sig);
}

// ── aes128gcm payload encryption (RFC 8291 §3.4, RFC 8188 §2) ───────────────
export const RECORD_SIZE = 4096;
export const MAX_PAYLOAD_BYTES = 3000;   // well under rs - 16 (tag) - 1 (delimiter)

export type EncryptOptions = {
  // Test-only injection so the RFC 8291 Appendix A vector can be reproduced.
  // Production always generates a fresh ephemeral keypair and random salt.
  senderPrivateRaw?: Uint8Array;
  senderPublicRaw?: Uint8Array;
  salt?: Uint8Array;
};

export async function encryptPayload(
  plaintext: Uint8Array, uaPublicRaw: Uint8Array, authSecret: Uint8Array, opts: EncryptOptions = {},
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error('payload_too_large');
  if (authSecret.length !== 16) throw new Error('bad_auth_secret');
  const uaKey = await importP256PublicEcdh(uaPublicRaw);

  let asPrivate: CryptoKey;
  let asPublicRaw: Uint8Array;
  if (opts.senderPrivateRaw && opts.senderPublicRaw) {
    asPrivate = await crypto.subtle.importKey('jwk', jwkFromRaw(opts.senderPublicRaw, opts.senderPrivateRaw),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPublicRaw = opts.senderPublicRaw;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('bad_salt');

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  // PRK_key = HMAC(auth_secret, ecdh_secret); IKM = HMAC(PRK_key, key_info || 0x01)
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hmacSha256(prkKey, concat(keyInfo, new Uint8Array([1])));

  // PRK = HMAC(salt, IKM); CEK / NONCE = first 16 / 12 bytes of HMAC(PRK, info || 0x01)
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  // Single record: plaintext || 0x02 (last-record delimiter), no extra padding.
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, concat(plaintext, new Uint8Array([2]))));

  // Header: salt(16) || rs(uint32 BE) || idlen(1) || keyid(as_public, 65)
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublicRaw.length;
  header.set(asPublicRaw, 21);
  return concat(header, ciphertext);
}

// ── send ────────────────────────────────────────────────────────────────────
export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type SendOptions = { ttlSec: number; urgency: 'very-low' | 'low' | 'normal' | 'high'; topic?: string };
export type SendResult = { status: number; error?: string };

const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;

export async function sendWebPush(
  target: PushTarget, payload: string, vapid: VapidKeys, opts: SendOptions,
  fetchImpl: typeof fetch, nowSec: number, timeoutMs = 10_000,
): Promise<SendResult> {
  const endpoint = new URL(target.endpoint);
  const body = await encryptPayload(enc.encode(payload), b64urlDecode(target.p256dh), b64urlDecode(target.auth));
  const jwt = await createVapidJwt(endpoint.origin, vapid, nowSec);
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'TTL': String(Math.max(0, Math.floor(opts.ttlSec))),
    'Urgency': opts.urgency,
    'Authorization': `vapid t=${jwt}, k=${vapid.publicKeyB64}`,
  };
  if (opts.topic && TOPIC_RE.test(opts.topic)) headers['Topic'] = opts.topic;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // redirect:'manual' — a push service never legitimately redirects, and
    // following one would let an endpoint bounce this request to another host.
    const resp = await fetchImpl(endpoint.href, { method: 'POST', headers, body, redirect: 'manual', signal: ac.signal });
    try { await resp.arrayBuffer(); } catch { /* drain only */ }
    return { status: resp.status };
  } catch (e) {
    return { status: 0, error: (e as any)?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
