# DEVELOPMENT RULES FOR THE PRODUCTION EDGE FUNCTION

**Status:** operating rules. They bind development, testing and validation work. They change no
production behaviour: client shell polling, coach dashboard polling and the Edge Function itself are
untouched by this document.

## Why these exist

The billing cycle 30 Aug – 30 Sep 2026 recorded **2,381,825 Edge Function invocations against a
2,000,000 allowance**, of which **99.1% came from a six-day burst, 17–22 September**. The generator
was never identified: Edge Function log retention is about 24 hours and the evidence had expired by
the time the overage surfaced on a billing banner.

What the forensics did establish is that the fleet is not the cause. Steady state is roughly
**625 invocations a day**, and at the burst's peak the Edge Function served **40,500 invocations for
every workout row written**. Whatever was running was automated, read-only, and pointed at
production for six days without anyone noticing.

These rules exist so that the next one is noticed in minutes.

## Rule 1 — a tab opened for validation is closed in the same procedure

Any browser tab opened against a production client shell, the coach dashboard, or a deployed canary
**must be closed in the same procedure that opened it.**

Both pages poll while visible, and neither has a stop condition:

| page | cost while the tab is open and visible |
|---|---|
| client shell (`pullOverrides`, 30 s) | **120 invocations / hour** |
| coach dashboard (`loadAll`, 30 s, two calls per cycle) | **240 invocations / hour** |

A coach dashboard left open over a weekend is roughly **40,000 invocations** and nothing in the
product will complain. This is the only unbounded source in the entire inventory, and it is closed
by habit, not by code.

## Rule 2 — no unbounded loop may issue production requests

Never write a `while`, a recursive `setTimeout`, or a retry-until-success loop that issues Edge
Function requests. The permitted form is a **bounded `for` with a hard iteration cap**, written so
that the worst case is arithmetic you can state before you run it.

This applies to anything driving the browser — a devtools console, an automation tool, a snippet
pasted into a page. A condition you expect to become true in two passes will spin forever the one
time the backend answers differently.

## Rule 3 — prefer static and served-byte validation

If a question can be answered without a backend call, answer it that way. Ranked, cheapest first:

1. **Static source analysis** — read the file and assert on it. `tests/entitlements.test.js`,
   `tests/write_enforcement.test.js`, `tests/provisioning.test.js` and `tests/program_v3.test.js`
   all do this against the shipped Edge Function source. **0 invocations.**
2. **Served-byte verification** — `fetch()` the deployed file from Pages and hash it. Verifying all
   35 active shells this way costs **0 invocations**, because no shell is ever loaded. This is how
   deployment verification should be done.
3. **Local harness against the stub** — load a webhook-rewritten copy from `test/`, `audit/` or
   `audit_pre/` with the local `efstub`. **0 invocations.** This covers the whole capability matrix.
4. **Production canary** — only for what genuinely requires the live backend: write, idempotent
   retry, correction, entitlement, cloud restore. A full canary lifecycle measures at roughly
   **60–120 invocations**, which is a reasonable price for that evidence.

Loading a production shell in a browser to check something a hash would have answered is the
mistake this rule exists to prevent.

## Rule 4 — the isolation the harnesses rely on is a tested invariant

Automated harnesses are isolated from production three times over:

1. test copies of client shells point at the **local stub**, never at production;
2. every browser harness installs a **route allow-list** — `file://` and `127.0.0.1` continue,
   everything else aborts;
3. neither sandbox has network egress to `*.supabase.co`.

Layers 1 and 2 live in source and can regress silently. **`tests/harness_isolation.test.js` is the
regression guard.** Run it before any fleet-wide validation sweep:

```
HARNESS_DIR=/path/to/harnesses node tests/harness_isolation.test.js
```

It reads files only and costs **0 invocations**. It fails closed: if it cannot find the harness
directory it fails rather than reporting success on an empty set, because not being able to check is
not the same as being safe.

## Rule 5 — 1,000 is the ceiling that needs a conversation

Any single validation procedure expected to exceed **1,000 production Edge Function invocations**
needs explicit approval before it runs, with the arithmetic stated up front. For reference, measured
costs:

| procedure | invocations |
|---|---|
| served-byte verification, any number of shells | **0** |
| local harness capability matrix, 35 clients | **0** |
| smoke probe loading N production shells | **~N** (one poll each; +1 each if a token is present) |
| full canary backend lifecycle | **60–120** |
| coach dashboard inspection, 15 minutes | **~60** |

Nothing in normal operation approaches 1,000. A procedure that does is either a fleet-wide sweep
that should have been done statically, or a bug.

## Rule 6 — make a recurrence visible

Two settings do more than any amount of discipline, and neither is code:

- **extend Edge Function log retention** — the single reason the 2.38M burst could be dated but not
  explained;
- **set a usage alert or spend cap** so an anomaly surfaces in hours rather than at month end.

## What these rules explicitly do not change

- client shell polling (30 s `pullOverrides`, on 50 of 52 shells) — **unchanged**;
- coach dashboard polling (30 s `loadAll`) — **unchanged**;
- the `api` Edge Function — **unchanged, not redeployed**;
- any client shell byte, any client data, `fat_topup.py` — **untouched**.

## Background

- `claude/EDGE_FUNCTION_INVOCATION_FORENSICS_2026-09-24.md` — the measurement and the day-by-day series.
- `claude/DEV_INVOCATION_SAFETY_GATE_PROPOSAL_2026-09-24.md` — the full inventory and the options considered.
