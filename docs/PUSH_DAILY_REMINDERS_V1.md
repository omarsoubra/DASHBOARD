# LOCKED IN Push — Daily Reminders V1 (plan-synced training + meals)

Status: built; **rollout switch holds the internal canary only** (`PUSH_DAILY_V1_CLIENTS`).
Same Web Push / VAPID stack, `pushTick` (pg_cron every 15 min), `notification_events`
dedupe claim, quiet hours, `sw.js`, shared `push-client.js`. Weekly check-in and
program-update notifications are unchanged.

## Ownership

| Question | Owner | Where |
|---|---|---|
| WHEN does this client train / eat? | the approved coaching plan | `schedule` (locked-in.schedule.v1) in `prescription.json`, or the client JSON for clients without one — never both |
| Does the client WANT training / meal reminders? | the client | `push_preferences.training_enabled` / `meals_enabled` |
| Quiet hours, timezone | the client | `push_preferences` |

The client never sees or edits a day or a time. There is no client-maintained
schedule (the five client schedule columns were dropped).

## Source-of-truth path

```
approved plan (schedule)  ──client_generator.py + schedule_v1.py (validate)──▶  shell: const LI_SCHEDULE = {...};
   ──git push──▶ GitHub Pages serves it
   ──push-plan-facts workflow: wait until served bytes == committed bytes──▶ plan_facts.mjs (reads literal, never executes)
   ──planFactsSync (deploy secret; server re-validates)──▶ push_plan_facts.schedule / training_schedule_status / meal_schedule_status
   ──pushTick──▶ reminders
```

A plan change (days, times, 4 → 3 feeds) is a new approved plan → new shell →
the same sync. The previous schedule simply stops existing. An older run cannot
overwrite a newer deploy: its bytes are no longer served, so it never matches.

## locked-in.schedule.v1

```json
{ "schema": "locked-in.schedule.v1",
  "training": { "status": "confirmed", "source": "client_confirmed",
                "days": [ { "dow": 1, "time": "18:30", "session": "Push" }, { "dow": 3, "time": "18:30", "session": null } ] },
  "meals":    { "status": "confirmed", "source": "coach_confirmed",
                "feeds": [ { "slot": 1, "time": "08:00" }, { "slot": 2, "time": "12:30" } ] } }
```

* `status` `confirmed | unknown`; unknown (or no schedule) = that category is unavailable and its row is hidden. Never blocks a plan.
* `source` `client_confirmed | coach_confirmed` — an explicit answer, never derived.
* times: local wall-clock `HH:MM`, 15-minute steps. **No timezone in the schedule.**
* training: unique `dow` 0–6 (0 = Sunday); `session` null unless the plan explicitly binds a real Training V2 session to that weekday (validated against the shell's session names; never inferred from Day N order).
* meals: slots 1..N in order, increasing times, N = the plan's real feed count (consistent across every day). Printed recipe times, Breakfast/Lunch/Dinner labels and intake text are never a source.
* build: a CONFIRMED but invalid schedule fails the build; quiet-hours conflicts (default 21:00–07:00) are printed as warnings, never altered.
* server: re-validated on every sync; malformed → `invalid` → unavailable.

## Timezone — one runtime authority

Schedule times are wall-clock times evaluated in `push_preferences.timezone`
(the client's device timezone, captured at opt-in, correctable by the client).
The schema rejects a timezone key, so a plan can never say "Sydney" while the
device says "Bali": 18:30 means 18:30 on the client's phone. No travel logic.

## Training

```
category off / no confirmed schedule / no Finish Workout on the shell → not evaluated (row hidden)
not a plan weekday                                                     → nothing (explain: not_training_day)
primary at the plan time
  explicit Finish Workout during local day D (completed_at ∈ localDayBounds(D, tz), status completed)
                                     → suppressed already_completed (+ completionRef)
  completion unreadable              → silence, nothing claimed, retried only inside the window
  master off / inactive / quiet hours / no device / daily cap → suppressed (reason)
  else → "Push session today 💪" (plan-bound session) or "Training today 💪"
follow-up at plan time + 2 h (product policy; no client setting)
  only after a primary that was sent/partial (else primary_not_sent)
  Finish Workout re-checked → already_completed
  inside quiet hours → suppressed quiet_hours (never moved)
  would cross local midnight → does not exist that day
  → "Still training today? / Your session is still there whenever you're ready."
```

Max 2 per day. A completion revoked before the follow-up makes it eligible again;
the primary is never resent. Workout Completion V1 is unchanged and is the only
completion authority.

## Meals

Each plan feed time fires once per day (`meal:<client>:<D>:<slot>`), copy
"Meal *k* time 🍽️ / Your next planned meal is ready in LOCKED IN.", deep link to
Nutrition. No meal log is ever read.

**Fail-safe (trainer-mode edits):** an in-app meal edit (`client_overrides`
`meal.wN.dN`) changes a day without a deploy. If any active edit's feed count
differs from the synced schedule, or the edits cannot be read, no meal reminder
is sent (`plan_out_of_sync`).

## Client UI

```
Notifications                                   On
Weekly check-in     Sundays, only if it isn't done      [toggle]
Program updates     When Omar updates your program      [toggle]
Training reminders  Synced with your training plan      [toggle]   ← only with a confirmed schedule
Meal reminders      Synced with your meal plan          [toggle]   ← only with a confirmed schedule
Quiet hours         [start] – [end]
Turn off notifications
```

## Safety cap, idempotency, observability

* ≤ 10 automatic training + meal pushes per client per local day (`daily_cap`, recorded).
* Every stage/slot claims one deterministic key before sending; cron re-runs, retries,
  restarts and racing schedulers cannot double-send; a fall-back DST hour collapses on the per-date key.
* `coachPushExplain {coachToken, storageKey, date?}`: plan facts and schedule status,
  the day's plan stages (session, follow-up policy) and meal slots with outcomes,
  `not_training_day`, `completedToday`, daily count. Read-only; no rest-day rows.

## Rollout

1. `20261003120000_push_plan_schedule.sql` (additive) → deploy `push` → `20261003130000_push_drop_client_schedule.sql`.
2. Clients gain reminders only when their approved plan carries a confirmed schedule
   and their shell is redeployed, AND they are in `PUSH_DAILY_V1_CLIENTS` (or `*`).

## Existing clients (2026-10-02)

None carries a confirmed schedule; all start with both rows hidden (by design).
Training: 0 confirmed / 15 partial / 39 unknown. Meals: 0 / 1 / 53.
Capturing training days + times and meal times (intake, Agent #5 questions,
confirmation for existing clients) is a separate, future workflow.

## Known limitations

* Trainer-mode meal edits are not synced (fail-safe silences meals instead).
* An offline Finish Workout syncs on the next app open; a reminder can go out in between.
* A client who trains but never taps Finish Workout still gets the reminder.
* `push-client.js` is cache-first: new UI shows on the second app open.
* Legacy shells without Finish Workout cannot offer training reminders.
