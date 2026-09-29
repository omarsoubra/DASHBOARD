# LOCKED IN PUSH NOTIFICATIONS V1

**Status:** canary proven on Omar's iPhone (2026-09-29, commits `2d5f9f7`, `be87c4e`).
V1 pilot build (reminders, program-update notice, settings) **built and locally verified — not deployed,
no real client enabled.**

A platform subsystem. It never touches V1.4.1 coaching logic, the agents, prescriptions, meal
quantities, the swap subsystem or the `api` Edge Function, and it never takes part in a programme
deploy — it only observes one after it is live.

## Philosophy

A timer firing is never a reason to send. Every reminder re-reads the client's real state first and
prefers silence when anything is uncertain: already weighed in, check-in done, disabled, quiet hours,
duplicate, no device, inactive client, programme not verifiably live → **silent**.

## Architecture

```
 pilot client shell (clients/<key>/index.html, patched by scripts/push/patch_pilot_shell.py)
   ├─ ../../push-client.js   opt-in (tap only) + compact Notifications settings in the Tracker tab
   └─ ../../sw.js            one shared worker, registered per client folder (scope ./)
            │ client token (POST body)
            ▼
 Supabase Edge Function `push`  (handler.ts + schedule.ts + webpush.ts)
   client:  pushStatus · pushSubscribe · pushUnsubscribe · pushPrefsGet · pushPrefsSet
   coach:   coachPushSend (test only)
   pg_cron: pushTick every 15 min ─────────────── x-push-cron-secret (minted in Vault)
   GitHub:  programUpdated after a verified deploy ─ x-push-deploy-secret (GitHub secret)
            │ service role
            ▼
 push_devices · push_preferences · notification_events · push_internal_auth
 + read-only: clients (is_paused, start_date) · client_sessions · weight_logs · check_ins
```

## Notification types

| kind | trigger | dedupe key | sent only if |
|---|---|---|---|
| weigh-in | pushTick, local window [time, +60 min) | `weighin:<client>:<local date>` | weigh-in available (coach) + enabled, outside quiet hours, active client + device, **no weight_logs row in that local day** |
| check-in | pushTick, check-in weekday, window [time, +60 min) | `checkin:<client>:<due date>` | enabled, outside quiet hours, programme ≥ 6 days old, active client + device, **no check_ins row since due date − 6 days** (the shells' own rule) |
| program update | GitHub notifier after served bytes == committed bytes | `program_update:<client>:<sha256 of live shell>` | commit trailer `LOCKED-IN-Program-Update: <key>`, opted in, active client + device; **quiet hours → deferred to quiet end**, delivered by the next tick |

Copy (lock-screen safe, fixed templates): "Morning bro. Log your weight when you're up." ·
"Your weekly check-in is ready when you are." · "Your program has been updated. Tap to view it."
Taps open the client's own programme (`./`, confined to the worker's scope by `sw.js`).

## Known product gap — morning weigh-in

The 1:1 shells have **no daily weight log**: weight is entered only in the weekly check-in form
(production: 0 clients logged weight on ≥ 4 distinct days in 14 days). A daily "log your weight"
reminder would therefore fire every morning with nowhere to log. The reminder is fully built and
tested but gated by the coach-owned `push_preferences.weighin_available` (default **false**), and the
settings UI hides it while false. Turn it on per client only once that client's app has a daily log.

## Settings (push_preferences — created only by the opt-in tap)

Client-owned: notifications on/off, timezone, weigh-in on/time, check-in on/time, program updates
on/off, quiet start/end (15-minute steps). Coach-owned: `weighin_available`, `checkin_dow` (Sunday).
Defaults (Omar-approved): weigh-in 07:30, check-in Sunday 09:00, quiet hours 21:00–07:00.

## Eligibility (automatic, server-side)

A client may use push only if the `push` function itself decides, from trusted state:

    NOT clients.is_internal
    AND client_sessions.access_status = 'active'
    AND resolved products include locked_in_1to1
        (active client_entitlements rows — same "active" rule as the api — else the
         pre-cutover entitlement_legacy marker)

Self-guided-only, internal, revoked/suspended and unprovisioned clients are refused; any read error
refuses (fail closed). Nothing the caller sends is consulted. `PUSH_ALLOWED_CLIENTS` is now only an
explicit **exception** list (the internal `_push_canary`, and 1:1 clients whose entitlement was never
granted). A normal new 1:1 client is eligible the moment their `locked_in_1to1` entitlement is active.

## Invocation cost

pushTick every 15 min ≈ 2,880 / month; client ops ≈ one per app open when the settings card is shown.
Push-service calls are outbound fetches, not invocations.

## Rollback (fastest first)

1. `select cron.unschedule('locked-in-push-tick');` — stops all reminders instantly.
2. End the client's `locked_in_1to1` grant or revoke their access — every op returns `push_not_enabled`.
3. `delete from push_internal_auth where name = 'deploy';` — program-update notices stop.
4. `git revert` the pilot shell commit — restores the exact previous shell bytes.
5. Migration DOWN blocks (V1, then proof) — drops only push tables/columns.

## 1:1 fleet rollout (2026-09-29)

Capability deployed to **every eligible 1:1 shell (51)**; nobody is subscribed, prompted or notified by the
rollout itself. Each client still opts in with an explicit tap.

* Integration: `scripts/push/patch_pilot_shell.py` — four byte-surgical edits per shell (shared worker
  registration, the two legacy auto-prompt blocks removed, one mount block at the end of the Tracker section),
  reversal-proven; `manifest.json` added where missing.
* Evidence: `docs/push_fleet_manifest.json` — per shell: original/patched sha256, exact regions, reversal proof,
  programme payload fingerprint (CLIENT_CONFIG, phases, phaseTargets, DAY_TYPES, mealPlan) before == after,
  auth-wiring and lint parity, inline-script syntax. Built by `scripts/push/fleet_manifest.py`.
* Excluded: internal `_` canaries, `mayank_block2` (redirect shim), `siam` (legacy Apps Script shell, no
  Supabase auth).
* `master_template.html` (client_template) carries the identical integration, so newly generated 1:1 shells
  include it; regenerated shells are byte-identical to the patched live shells apart from `generatedAt`.
* Server gate: automatic eligibility (see *Eligibility*); no per-client list. **New client:** nothing
  push-specific — the generated shell is integrated and the normal `locked_in_1to1` grant makes them eligible.
  (Optional: `python3 scripts/push/patch_pilot_shell.py <key>` adds a standalone `manifest.json`.)
* The fleet commit carries no `LOCKED-IN-Program-Update` trailer, so it produced no program-update notices.

## Proof-stage history

Canary: `_push_canary`, Omar's iPhone, 201 from web.push.apple.com, click confined to scope, dedupe and
unsubscribe proven 2026-09-29. Proof migration `20260928120000`, seed `supabase/manual/push_canary_seed.sql`.
