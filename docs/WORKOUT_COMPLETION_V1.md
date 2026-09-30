# LOCKED IN — Workout Completion V1

**What it is:** an authoritative record that a client *explicitly* completed a prescribed
session occurrence — the **Finish Workout** action. It is the signal future workout nudges
need; it is **not** a nudge, not a schedule and not an inference.

**What it is not:** it is never derived from exercise logs (`workout_log_entries`), never
backfilled, and never assumes weekdays. Exercise logging is unchanged.

## The limitation (by design, V1)

The server proves **who** completed a session (verified client token) and **when** it was
recorded. The session identity — `phase_key`, `day_index`, `day_label`, `rx_fingerprint`,
`session_kind` — is a shape-validated snapshot asserted by the client's own shell. There is
no server-side session registry for 1:1 shells (their programme lives in the shell), so the
server **cannot independently prove that the stated session exists in the client's current
programme**. `day_label` + `rx_fingerprint` make any later mismatch detectable.

## Data — `public.workout_completions` (migration `20261001120000`)

One row per Finish Workout. Additive; RLS on; `anon`/`authenticated` revoked; written only by
the `api` Edge Function. Never deleted — undo sets `status='revoked'` (+ `revoked_at`,
`revoked_by`). Unique `(client_id, completion_ref)`.

| column | meaning |
|---|---|
| `client_id`, `storage_key` | from the verified token — never from the request body |
| `completion_ref` | `cmp_…`, minted on the device once per occurrence, persisted before any network write |
| `phase_key`, `day_index`, `day_label` | the stated session (programme days are sequential, not weekdays) |
| `session_kind` | `optional` if the day's badge/label says optional, `mandatory` only if the badge says exactly MANDATORY, else `unspecified` |
| `rx_fingerprint` | sha256 of the occurrence's prescribed exercise names (audit only) |
| `exercises_prescribed/logged`, `sets_logged` | informational counts at the tap |
| `completed_at` | device time of the tap, clamped to `[recorded_at − 72 h, recorded_at]` |
| `recorded_at` | server receipt |
| `local_date`, `timezone` | the client's calendar day of the tap (calendar-week grouping) |

Programme-week grouping is done at read time from `clients.start_date` (27 of 39 active
clients have one on 2026-09-30); calendar-week grouping from `local_date`. No week model is
chosen in V1.

## API (`supabase/functions/api/index.ts`, WORKOUT-COMPLETION-V1)

All three: `verifyClientToken` → `requireCapability(key, 'log_workout')` (same gate as the
`workout` write) → database. Errors are the api's usual `{ ok:false, error }`.

| op | body | result |
|---|---|---|
| `workoutComplete` | `completion: { ref, phase, dayIdx, dayLabel, sessionKind, rxFingerprint?, exercisesPrescribed?, exercisesLogged?, setsLogged?, completedAt, localDate, timezone? }` | `{ completion, duplicate }` — a known ref returns the existing row unchanged |
| `workoutCompleteUndo` | `ref` | revokes the client's **own latest** completed row within **24 h** of `recorded_at`; `not_latest` / `undo_window_closed` / `not_found` otherwise; idempotent |
| `workoutCompletionsGet` | — | the client's own completions (120 days, newest first, revoked included) |

After the 24-hour client window, correction is coach-side only (SQL: set
`status='revoked', revoked_at=now(), revoked_by='coach'`; never delete).

## Shell (`scripts/workouts/patch_completion_shell.py`)

Four insertions inside `<script id="tv2-js">`, anchors must be unique or the shell is
refused; reversal-proven; idempotent (`WORKOUT-COMPLETION-V1` marker):

* **Finish workout** button on the workout screen (fresh sheet or open occurrence) and on
  the summary of the latest native occurrence that finished itself or whose completion was
  undone.
* Confirmation when exercises are unlogged: "Finish workout with 3 of 5 exercises logged?" /
  "No exercises have been logged. Mark this workout as completed?"
* States on the summary: **✓ Workout completed · date** (+ *Undo completion* when allowed),
  *Finished · saved on this phone* (pending, *Send now*), error, *Completion undone*.
* Pending completions re-send at boot, on `online` and on visibility; same ref every time.
* The automatic TV2 "complete" status is untouched and creates nothing on the server.

Compatible with the 39 live shells that use `cloudWrite()`; the 12 older shells without it
are refused by the patcher (they need their own adapter before any fleet step).

## Verification

* `tests/workout_completion.test.js` — real api source, strict stand-in (schema parsed from
  the migration): idempotency, race, cross-client, capability, malformed input, clamping,
  undo rules, fail-closed reads, exercise logs untouched, migration posture.
* `scripts/workouts/browser_e2e.js` — headless Chrome on a throwaway patched shell, every
  Supabase call answered by the real handlers: zero/partial confirmations, double tap,
  reload, offline → restart → online (one row), undo + audit, wrong token, exercise-log
  writes byte-identical to the unpatched shell.
* Isolated real stack (Postgres + PostgREST + edge-runtime) with the real migration and api.

## Rollback

1. Shell: `patch_completion_shell.py` is reversal-proven — restore the pre-patch bytes (git).
2. API: redeploy the previous api commit (the three ops are additive; nothing else changed).
3. Data: the table can stay (inert) or be dropped with the DOWN block of the migration.
