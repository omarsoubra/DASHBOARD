# Workout-engine transplant

Brings an already-deployed client shell up to the current workout architecture by
replacing named top-level declarations and two whole IIFEs with the byte-identical
known-good implementations taken from a reference production shell.

It never regenerates a program. Client content is never read, rewritten or moved.

## Why not a template diff

The deployed shells are not reachable from any `client_template` commit by delta
application. Several subsystems (Track A client-persistence, FIND LOAD) were applied
to deployed shells first and upstreamed to the template afterwards, and the shells
also carry deployed-only code the template has never had (the SW2 meal-swap modal,
token relink). A shell is therefore simultaneously ahead of and behind the template,
and line-hunk patching refuses on all of them.

## What it replaces

Located with a real JS parser (acorn). IIFEs are identified by the functions they
define, never by position or size.

| unit | located by | current target |
|---|---|---|
| ENGINE  | defines `createSession`, `writeLocal`, `entryFor`     | `2b43acd02982` · 94,003 B |
| RESTORE | defines `hydrateFromCloud`, `KEY_LAST_RESTORE`       | `cd1e3e1b847c` ·  8,260 B |
| TRACK_A | `cloudWrite` `_markSync` `syncSaving` `syncSaved` `syncFailed` `_mealPending` `retryUnsyncedMeals` | `ba94bbff9d4c` |
| WORKOUT_IO | `_workoutLogId` `loadWorkoutLogs` `saveWorkoutLogsLocal` `postWorkoutLog` `saveWorkoutLog` `cancelWorkoutLog` | `0dc70abb5fa8` |
| FIND_LOAD | `_FL_*` `_fmtKg` `_loadState` `_authoredLoadKind` `_authoredEffortCue` `_fl_esc` `_resolveLoadBadge` | `43240f39ef8a` |
| PERF_REF | `_workoutPending` `_perfRef` `_ensurePerfRef`        | `b15240fe9b88` |
| B5 | the 14 `_wl*` prefill helpers                              | `cebec1f6afe6` |

The reference is a known-good production shell, not the template: 237 of its 248
top-level declarations are byte-identical across all six current shells, and the 11
that differ are exactly the client-content ones, which are excluded from the set.

## Fails closed

Refuses and writes nothing on: an unknown variant, an absent unit with no defined
anchor, overlapping edits, a post-transform parse error, a unit that does not
converge, any content-block drift, or any change to a protected declaration.

## Proof of integrity

`integrity.js` reverses the transplant: putting only the declared spans back must
reproduce the original file byte-for-byte. If any other byte moved, it fails.

## Use

    npm i acorn acorn-walk
    node run_transplant.js          # writes migrated shells to out/
    node integrity.js               # proves nothing outside the units changed
