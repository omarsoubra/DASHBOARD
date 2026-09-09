# LOCKED IN SELF-GUIDED — Milestone 1 (Foundation)

Status: built locally, **not deployed**. Migration not run. EF not deployed.

## What this milestone establishes

A client's access is decided by **what they own**, not by a hardcoded tier, and a
SELF-GUIDED customer is provisioned by **writing rows** — no HTML shell is
generated, committed or deployed per customer.

## Schema (derived from repository evidence, not guessed)

`clients` real columns, from the canonical insert in `clientCreate`:
`id, profile_id, storage_key, display_name, age, height_cm, start_weight,
goal_weight, start_date, program_type, program_url`.

### New tables — `supabase/migrations/20260909000000_self_guided_entitlements.sql`

- **`products`** — sellable things. Seeded with `locked_in_1to1` and
  `locked_in_self_guided_12w` (12 weeks, $39.95/wk in `config`).
- **`client_entitlements`** — authoritative grants.
  `client_id, product_code, status, starts_at, ends_at, source, notes`.
  Status ∈ pending/active/paused/expired/revoked. Source ∈
  manual/billing/migration/admin/promotional. Partial unique index allows only
  one *active* grant per (client, product); historic rows are retained for audit.
- **`clients.current_tier`** — new nullable column, **display only**, never read
  for an access decision.

Additive only: no drop, rename or repurpose. RLS enabled and default-deny on both
new tables (the EF uses the service role and is unaffected). Backfills an active
`locked_in_1to1` entitlement for every existing client. DOWN block included.

## Entitlement model — `supabase/functions/api/index.ts` (+210 lines, −0)

One capability matrix, `PRODUCT_CAPABILITIES`. Handlers never test a tier string;
they call `requireCapability(storageKey, cap)`.

| capability | SELF_GUIDED | PREMIUM |
|---|---|---|
| view_program, log_workout, view_nutrition, log_weight | ✅ | ✅ |
| submit_self_checkin, view_recipes, view_education | ✅ | ✅ |
| receive_automated_progression | ✅ | ✅ |
| receive_automated_adjustment | ✅ | ❌ *(a coach decides, not a rule engine)* |
| direct_coach_messaging | ❌ | ✅ |
| manual_coach_review | ❌ | ✅ |
| coach_program_customisation | ❌ | ✅ |
| coach_nutrition_adjustment | ❌ | ✅ |
| form_review | ❌ | ✅ |

**Resolution fails closed.** There is no global "no entitlement -> premium" rule.

| state | result |
|---|---|
| active entitlement row(s) | those capabilities (`basis: entitlement`) |
| none, `clients.entitlement_legacy = true` | premium (`basis: legacy_marker`) — pre-cutover clients only |
| none, `entitlement_legacy = false` | **DENIED**, `status: provisioning_incomplete`, zero capabilities |
| `client_entitlements` table absent | premium (`basis: pre_migration`) — see below |
| any other DB error | **DENIED** |

`entitlement_legacy` is set to true by the migration for exactly the clients that
existed at cutover, in the same transaction as the backfill. Every client created
afterwards defaults to false, so a failed or missing grant can never promote a new
client to premium.

The `pre_migration` branch is narrow and safe: if the entitlements table does not
exist then no SELF-GUIDED customer can have been provisioned, so everyone present
is a 1:1 client. It is entered only on a definitive undefined-table error; a
transient failure denies.

**Nothing is trusted from the client.** No tier is read from the request body;
capabilities are resolved from the database on every call.

### New actions
- `entitlementsGet` — client or coach; returns tier, products, capabilities.
- `entitlementGrant` — coach only. **This is the billing seam**: a payment
  provider will later call this on payment success. The application contains no
  payment-provider logic.
- `entitlementRevoke` — coach only.
- `coachReviewRequest` — client; premium-only. Returns `forbidden_tier` plus the
  upgrade line for SELF_GUIDED.

`overridePut` gained a defence-in-depth capability check: even a valid coach
token cannot hand-customise a client whose product excludes coach customisation.

## Generic shell — `app/index.html` (32 KB)

Generalised from `clients/siam/index.html`, the one existing runtime-fetch shell.
Changes: endpoint moved to the Supabase EF (siam still pointed at the retired
Apps Script), identity resolved at runtime from `?c=<key>` + localStorage instead
of a baked-in constant, capabilities fetched after auth and applied to
`[data-cap]` elements, premium-gated coach-review block plus upgrade note.

Access link: `/app/?c=<storageKey>&t=<token>` — both stripped from the URL after
first load. The token is still verified server-side against that key, so editing
`?c=` grants nothing.

Per-client shells average **403 KB each**. This is **32 KB, once**.

## Tests — `tests/` (node, no network)

Both suites extract the **shipped source** from `index.ts` and execute it; no
copy of the rules lives in the tests.

- `entitlements.test.js` — 38 assertions: full capability truth table, union
  semantics on upgrade, unknown/empty products grant nothing, matrix
  completeness, entitlement window logic (not-yet-started, expired, boundary,
  every non-active status).
- `provisioning.test.js` — 42 assertions against an in-memory Supabase
  stand-in, covering the whole journey: legacy premium client → provision
  self-guided → capability resolution → premium feature refused server-side
  (including when the request body claims premium) → upgrade preserving history
  → revoke/expiry → auth precedence → `overridePut` regression.

### Provisioning — `provisionSelfGuidedClient`

One authorised call: create the client, then grant the entitlement. Full
cross-table transactionality is not available through PostgREST, so safety comes
from the fail-closed rule instead: a client created here has
`entitlement_legacy = false` and holds **no capabilities** until the entitlement
row lands. A partially provisioned account is unusable, never over-privileged,
and the error names the exact step to re-run.

`clientProgram` is now capability-gated too, so an unprovisioned client cannot
even fetch a program.

**Acceptance test result: PASS.** Provisioning a new SELF-GUIDED customer took
**2 row writes, 0 files generated, 0 deploys.**

## Regression

- EF diff: **210 insertions, 0 deletions**. 32 actions before, 36 after, none removed, no handler removed.
- No existing client file touched.
- `scripts/rebuild_registry.py` scans `clients/` only, so `app/` is invisible to the registry and the GH Action.
- 38-client nutrition regression re-run: unchanged (`omar`, `mayank` still the only drifters, untouched).

## Client-facing access-control surface (complete audit)

Every action reachable with a client token, and what gates it. This table is
the contract; `tests/write_enforcement.test.js` PART B re-derives it from the
dispatch switch on every run and fails if a new ungated client action appears.

| Action | Kind | Capability required |
|---|---|---|
| `ping` | liveness | — (no auth, no data) |
| `authClient` | bootstrap | **ungated by design** |
| `entitlementsGet` | entitlement resolution | **ungated by design** |
| `intakeSubmit` / `intake` | public pre-client write | **ungated by design** |
| `clientProgram` | read | `view_program` |
| `overrideGet` | read | `view_program` |
| `weightLog` | read | `view_progress` |
| `photosGet` | read | `view_progress` |
| `weight` | write | `log_weight` |
| `checkin` | write | `submit_self_checkin` |
| `meal` | write | `log_meal` |
| `workout` | write | `log_workout` |
| `photoUpload` | write | `upload_photo` |
| `coachReviewRequest` | write/request | `manual_coach_review` |

Every other dispatched action (`dashboard`, `rosterGet`/`rosterPut`,
`registryGetPrivate`, `clientCreate`, `issueClientToken`, `setAccessStatus`,
`setClientProgram`, `entitlementGrant`/`entitlementRevoke`,
`provisionSelfGuidedClient`, `overridePut`, `intakeList`/`intakeLink`/
`intakePromote`, the `legacyQueue*` family, the `progression*` family) requires
a coach token and is not reachable with client credentials.

### Why three actions are ungated

- **`authClient`** — bootstrap. Answers only "is this token valid for this key,
  and is the account active?". Returns no program, nutrition, log or photo
  data. Gating it would be circular: the shell could not discover that it is
  unentitled without already being entitled.
- **`entitlementsGet`** — entitlement resolution itself. Gating the action that
  reports your capabilities on holding a capability is the same circularity. It
  is also how a denied client learns it is denied, which is what lets the shell
  show "your setup isn't finished" rather than a hard error. It discloses only
  the caller's own tier and capability flags, and the caller's own token must
  still verify against the key.
- **`intakeSubmit`** — the public intake form. It has no client auth by design:
  the person filling it in is not a client yet. It writes only to the `intakes`
  queue through the `INTAKE_FIELD_MAP` allow-list, cannot reach `clients`,
  `programs`, `client_entitlements` or any canonical client table, and cannot
  link itself to an existing client — linkage is a separate coach-authorised
  promotion step.

### The legacy quarantine path

`clientWrite` has a pre-existing compatibility branch: if the token fails but
the storage key is on the latest active roster snapshot, a `weight` or
`checkin` is captured to `legacy_intake_queue` and mirrored to the canonical
table. The queue row records an *attempt* and is still written unconditionally —
that is the point of a quarantine. **The canonical mirror is now held to the
same capability gate as an authenticated write**, so this branch can no longer
be used to write real client data for an unentitled key.

### Capabilities added in this pass

`log_meal`, `upload_photo`, `view_progress` — all `true` for both products.
Logging and reading your own data is the product, not the tier, so 1:1
behaviour is unchanged and SELF-GUIDED gets them too. Matrix is now 17
capabilities: 1:1 holds 16 (all but `receive_automated_adjustment`),
SELF-GUIDED holds 12.

## Internal test accounts — `supabase/migrations/20260909120000_internal_test_accounts.sql`

`clients.is_internal` (boolean, default false) marks non-paying internal
accounts. `sg_canary` is set true and is the permanent SELF-GUIDED production
regression canary.

The flag is **presentational only**. It does not affect authentication,
entitlements or capability enforcement — an internal account is gated exactly
like a paying one, which is precisely why it can be used to regression-test
that gating. It excludes the account from `dashboard` and
`registryGetPrivate`; both accept `includeInternal: true` to see it
deliberately. `provisionSelfGuidedClient` accepts `internal: true` so future
canaries are marked at creation.

## Known limitations

1. **Not deployed.** Migration must be run in the Supabase SQL editor; the EF must be deployed. Neither has happened.
2. **No live DB introspection.** The schema map came from repository evidence.
   The migration only references `clients.id`, `clients.start_date` and
   `clients.created_at` — the first two are proven by `clientCreate`;
   **`created_at` is the one remaining assumption** and is used inside
   The migration references only `clients.id` and `clients.start_date`, both
   proven by `clientCreate`. **The `clients.created_at` assumption has been
   removed** — the backfill uses `coalesce(start_date, now())`, trading
   historical precision for deterministic migration success. These rows are
   compatibility records, not billing data.
3. Tests use an in-memory stand-in, not a real Postgres. They prove the decision
   logic, not Supabase driver behaviour or RLS.
4. `app/index.html` inherits siam's UI, which was built for a coached client. It
   renders program, meals, training and check-in but has no SELF-GUIDED Today
   screen, onboarding or education library yet — those are Milestone 2+.
5. No billing. Deliberate: entitlement is provisioned manually via `entitlementGrant`.

## Milestone 2

Automated onboarding + program assignment: intake → classify → template
selection → nutrition profile → `programs` row → app ready, with no Omar step.
Requires the template/assignment split (versioned `program_templates` vs assigned
snapshots) so editing a master template cannot mutate someone's Week 7.
Fixtures: male fat-loss 3d/5d, female fat-loss 4d, recomp, muscle gain, novice,
experienced, restricted equipment.
