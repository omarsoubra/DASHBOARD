# LOCKED IN PUSH NOTIFICATIONS V1 — Minimal Proof

**Status:** built and locally verified. **Nothing deployed.** Milestone question:
*"Can LOCKED IN send one secure push notification to Omar's iPhone?"*

Separate platform subsystem. It does not touch the V1.4.1 coaching engine, any prescription,
any client config, any live client shell, the swap subsystem, self-guided (`app/index.html`),
or the `api` Edge Function.

## What exists

| piece | file |
|---|---|
| Web Push crypto (RFC 8291 aes128gcm, RFC 8292 VAPID), WebCrypto only | `supabase/functions/push/webpush.ts` |
| Handler: `pushStatus`, `pushSubscribe`, `pushUnsubscribe`, `coachPushSend`, `ping` | `supabase/functions/push/handler.ts` |
| Deno entry (env + supabase-js wiring only) | `supabase/functions/push/index.ts` |
| Schema: `push_devices`, `notification_events` (RLS default-deny) | `supabase/migrations/20260928120000_push_notifications_proof.sql` |
| Canary client row (manual, idempotent) | `supabase/manual/push_canary_seed.sql` |
| Service worker: `push` handler + scope-confined `notificationclick` | `sw.js` (root; cache/fetch logic unchanged) |
| Shared opt-in UI (permission only on tap, iPhone install guidance) | `push-client.js` |
| Canary shell (Omar only; talks only to `push`) | `clients/_push_canary/index.html`, `manifest.json` |
| Tests (0 production invocations) | `tests/push_proof.test.js` |
| Manual deploy (type DEPLOY) | `.github/workflows/deploy-edge-push.yml` |
| Omar-run helpers (never print secrets) | `scripts/push/*.mjs` |

## Security boundaries

- Client identity = `verifyClientToken` (verbatim copy of `api`'s; a test fails on drift). Body `client_id` is ignored.
- `PUSH_ALLOWED_CLIENTS` secret gates every op. Unset → nobody. Proof value: `_push_canary`.
- Endpoints: https, no userinfo/port, host ∈ {`web.push.apple.com`, `fcm.googleapis.com`,
  `updates.push.services.mozilla.com`} or a strict subdomain of `.push.apple.com` / `.notify.windows.com`.
- Push requests use `redirect: 'manual'`. Fan-out ≤ 10 devices/send; ≤ 20 events/client/day; ≤ 5 devices/client.
- Payloads come only from fixed templates (proof: `test`), lock-screen safe: no numbers, no health terms.
- `sw.js` only opens URLs inside its own registration scope, and always shows a notification (iOS rule).
- 404/410 → device `expired`; endpoint + keys wiped. Unsubscribe → `revoked`; endpoint + keys wiped.
- VAPID private key: Supabase secret only (+ Omar's offline recovery copy). Never in the repo, a response or a log.

## Invocation cost

Proof total is a handful: `pushStatus` once per canary app open, one call per subscribe/unsubscribe/send.
No scheduler, no polling.

## Rollback (fastest first)

1. **Kill switch:** set secret `PUSH_ALLOWED_CLIENTS` to empty → every op returns `push_not_enabled`.
2. **Canary access:** `update public.client_sessions set access_status='revoked' where storage_key='_push_canary';`
3. **Function:** Supabase Dashboard → Edge Functions → `push` → Delete. (`api` is unaffected.)
4. **Pages files:** `git revert` the commit (restores `sw.js`, removes canary + `push-client.js`).
5. **Schema:** run the DOWN block in the migration (drops only the two push tables).
6. **Canary row:** hard delete in `supabase/manual/push_canary_seed.sql` (ROLLBACK section).

## Not in the proof (V1 later, each needs approval)

Scheduler/pg_cron, weigh-in and check-in reminders, programme-update notifications, quiet hours,
preferences, coach dashboard panel, `pushsubscriptionchange` re-subscribe, fleet shell patch.
