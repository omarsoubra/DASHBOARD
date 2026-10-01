# LOCKED IN Push — Daily Reminders V1 (training + meals)

Status: built and tested; **rollout switch OFF** (`PUSH_DAILY_V1_CLIENTS` unset = nobody).
Same Web Push / VAPID stack, same `pushTick` (pg_cron every 15 min), same
`push_preferences`, `notification_events`, dedupe claim, quiet hours, `sw.js` and
shared `push-client.js`. The weekly check-in sequence is unchanged.

## What a reminder means

| Reminder | Means | Never means |
|---|---|---|
| Training | "You told us you train on this weekday." | "You are due session X" / "you skipped" |
| Meal *k* | "It's the time you set for planned meal *k*." | "You haven't eaten" / "you missed a meal" |

Every day and time is **chosen by the client**. Nothing is derived from the
programme, `weeklySchedule`, `trainingTimeNote`, meal names or printed meal times.
Everything defaults **off and blank**.

## Training

Per client local day D (timezone = `push_preferences.timezone`):

```
off / no days / no time / weekday not chosen     → not evaluated (no row)
window [T, min(T+60, follow-up, midnight)) opens → primary
  key training_primary:<client>:<D> already claimed → duplicate (tick counter)
  master off                                   → suppressed disabled
  served shell has no Finish Workout           → suppressed unsupported_workout_completion
  explicit completion in D (completed_at ∈ localDayBounds(D), status completed)
                                               → suppressed already_completed (+ completionRef)
  completion query fails                       → silence, nothing claimed, retried next tick
  inactive / quiet hours / no device / cap     → suppressed (reason)
  else claim key → send "Training today 💪 / Your session is ready when you are."
optional follow-up at F (>= T+60, same day, off by default)
  same, plus: primary not sent/partial         → suppressed primary_not_sent
  → "Still training today? / Your session is still there whenever you're ready."
```

At most 2 training pushes per day. A completion revoked before the follow-up
makes the follow-up eligible again; the primary is never resent.

## Meals

`meal_times[k-1]` is Meal *k* (ordinal; blank = skipped). Every slot fires once
per day at its time (`meal:<client>:<D>:<k>`), unless:

* the served plan's feed count is not one consistent N → meal reminders unavailable (not offered, not evaluated);
* *k* > current feed count → suppressed `no_current_meal_slot` (the 4 → 3 case);
* master off / quiet hours / inactive / no device / cap → suppressed (reason).

No meal log is read. Copy: "Meal *k* time 🍽️ / Your next planned meal is ready in LOCKED IN."

## Served-shell plan facts (`push_plan_facts`)

`scripts/push/plan_facts.mjs` reads a shell's bytes with a strict literal parser
(nothing is executed): feed count (meal cards with calories; prep notes excluded),
whether all four Finish Workout hooks are present, sha256 of the bytes.
`.github/workflows/push-plan-facts.yml` runs on every push that changes a client
shell (and on manual dispatch with `SYNC`): waits until GitHub Pages serves the
committed bytes, then calls `planFactsSync` (deploy secret). A plan change is
therefore picked up the moment the new shell is live; the client's own settings
are never edited.

Fleet at build time (2026-10-01): see the final report / backfill output.

## Safety cap

10 automatic training + meal pushes per client per local day (`daily_cap`,
recorded). Structurally the maximum is already 10 (2 training + 8 meal slots).
The weekly check-in is outside this cap and unchanged.

## Deep links

Training → `./?li=training`, meals → `./?li=nutrition`. `push-client.js` routes
the parameter through the shell's own `showSection()` after the shell boots and
removes it from the URL; for an already-open app `sw.js` focuses the window and
posts `{type:'li-open', section}`. Invalid values, other folders/origins, or a
shell without `showSection` → the app home (previous behaviour). No new routes.

## Observability

* `notification_events`: one row per decided stage/slot (sent / partial / failed /
  suppressed + reason), `context` = `{stage|slot, completionRef?}` only.
* `pushTick` summary: `due`, `sent`, `duplicates` (duplicate_prevented),
  `suppressed{reason}`, `stateErrors`, `training{primary,followup}`, `meals`.
* `coachPushExplain {coachToken, storageKey, date?}` — read-only: rollout,
  eligibility, devices (count), plan facts, the day's schedule with each stage /
  slot outcome (`scheduled`, `window_open`, `not_evaluated`, `sent`, reasons),
  `not_training_day`, `completedToday`, daily count vs cap. No rest-day rows are
  stored.

## Rollout

1. Migration `20261002120000_push_daily_reminders.sql` (additive).
2. Deploy `push` (workflow runs push_proof, push_v1, push_v2, push_daily).
3. Plan facts backfill: Actions → "Push — plan facts sync" → Run → `SYNC`.
4. `PUSH_DAILY_V1_CLIENTS` = canary key(s) → later a pilot list → `*`.
   Unset again = instant off (settings hidden, nothing evaluated).

## Known limitations

* A coach meal edit made in the shell's trainer mode (`client_overrides
  meal.wN.dN`) can change one day's feed count without a deploy; V1 uses the
  deployed plan's count.
* A Finish Workout tapped offline reaches the server on the next app open; a
  reminder can be sent in between (non-accusatory copy).
* A client who trains but never taps Finish Workout still gets the reminder.
* `push-client.js` is cache-first: new settings appear on the second app open.
* 12 legacy shells (no Finish Workout) → training not offered;
  zain_hussein (4/5 feeds) → meals not offered.
