# LOCKED IN NOTIFICATIONS V2 — adherence-aware check-in reminders

**Principle:** never remind a client to do something LOCKED IN can already prove they did.
The default is silence; a notification needs a positive reason.

Builds on V1 (`docs/PUSH_NOTIFICATIONS_V1.md`). Program-update notifications, eligibility,
opt-in, quiet hours, weigh-in (still OFF) and the service worker are unchanged.

## 1. What LOCKED IN can observe (production, inspected 2026-09-29)

| Behaviour | Class | Evidence |
|---|---|---|
| Weekly check-in submitted | **RELIABLE** | `check_ins` row per submission, written by the `api` from the verified client token. `submitted_at` = submitting device clock (0 future-dated rows). 133 check-ins / 25 clients in 56 days; 66 on Sunday, 31 on Monday (Sydney). |
| Programme start / age | **RELIABLE** | `clients.start_date` (already used by V1 for the first check-in). |
| Access / entitlement | **RELIABLE** | V1 eligibility (client_sessions + client_entitlements). |
| Workout session completed | **PARTIAL** | `workout_log_entries` = one row per *logged exercise*; no session-complete marker; logging optional (20 of 39 active clients logged nothing in 28 days; median 1.25 logged days/week among loggers vs 4–6 prescribed). Programmes are sequential "Day 1..N" — 0 of 672 fleet session labels name a weekday; 9 are OPTIONAL. The same day index is logged on >1 date within a week 6 times (repeats/shifts). A row proves training; absence does **not** prove a skip. |
| Nutrition followed | **PARTIAL** | `meal_logs` (799 rows / 20 clients in 28 days) carries no plan link (no week/day/meal index — the shell's own comment says so) and "undo" writes a new row; `check_ins.diet_adherence_1to10` is weekly self-report. |
| Daily weigh-in | **UNAVAILABLE** | No daily weigh-in workflow in 1:1 shells. `weighin_available=false`. |
| App opens | **UNAVAILABLE** | Not recorded; never an adherence proxy. |

Encoded in `supabase/functions/push/adherence.ts` (`SIGNALS`, `observeWorkout`), which the push
handler deliberately does **not** import: no workout, nutrition or weigh-in reminder exists.

## 2. Check-in state machine (per client, per period)

Period = due date **D** (client's check-in weekday, local; fleet = Sunday). There is no canonical
period id in the data (`check_ins.week_number` is typed by the client; 14 client/week-number pairs are
reused more than 8 days apart), so the period is derived: **every instant belongs to exactly one
period — the due date nearest in local calendar days, `[start of D−3, start of D+4)`**. For Sunday:
Thursday 00:00 → Wednesday 24:00. Thu–Sat = early check-in for the coming Sunday; Sun–Wed = on-time
or late check-in for that Sunday. Completion of D = any check-in in `[start of D−3, now]`.
Not due at all while the programme is < 6 days old (V1 rule).

Why not the shells' rolling "within the last 6 days" banner rule: a Monday-late check-in for last week
would complete this week. Replayed read-only over 10 Sundays of production history (828 client ×
Sunday × stage evaluations), the rolling rule wrongly stayed silent 98 times (42 Sunday-morning, 31
evening, 25 Monday), all caused by Mon/Tue/Wed late submissions from the previous week; in 62 of those
the client then submitted a separate check-in for the new week. 0 cases went the other way. The
client banner still uses the rolling rule (shells are out of scope), so after a Monday-late check-in the
push reminds on Sunday while the banner may stay hidden.

```
            ┌─ completed at any point ───────────────────────────► SILENT (rest of period)
 D 09:00  DUE ── incomplete ─► "Your weekly check-in is ready. Take a minute to get it done."
 D 18:00  FOLLOW-UP ── still incomplete ─► "Your check-in is still waiting. Get it done tonight so Omar can review your week."
 D+1 10:00 FINAL ── still incomplete ─► "You missed your weekly check-in. Get it done today so your coaching stays on track."
          STOP — nothing further until the next period.
```

* Each stage re-reads `check_ins` immediately before deciding. Max 3 automated check-in pushes per period.
* Stage times are wall-clock minutes from local midnight of D (DST-safe). Coach-owned per client:
  `checkin_followup_time` (18:00), `checkin_final_time` (10:00), `checkin_final_day_offset` (1).
  Stages must be strictly later than the previous one by ≥ 15 min; otherwise that stage is dropped
  (e.g. a client-chosen 19:00 check-in time drops the 18:00 follow-up) — never reordered.
* Stage window = [stage time, min(+60 min, next stage time)) → at most one stage is ever open.
* Scheduler missed the morning (outage) and still incomplete at 18:00 → the follow-up is sent; the
  morning is never back-filled. Recovery after the last window → nothing. No burst is possible.
* Tap opens the app at its own scope (`./`). No deep link: the shells have no route into the
  check-in form (`?section=` only suppresses the home view), so none was invented.

Decision order (`decideReminder`, schedule.ts) — the one pattern for every adherence reminder:
observation → due → completed → eligible → active → enabled → quiet hours → device → dedupe claim → send.
Unknown observation = silence with nothing recorded (retried next tick).

## 3. Dedupe and quiet hours

* Keys: `checkin_due:<client_id>:<D>`, `checkin_followup:<client_id>:<D>`, `checkin_final:<client_id>:<D>`
  (unique `notification_events.dedupe_key`; any recorded outcome — sent or suppressed — is final).
  All three use kind `checkin_reminder` and tag `li-checkin`, so a later stage replaces an unread
  earlier one on the lock screen.
* Retries / scheduler reruns → duplicate claim, nothing sent. Timezone change mid-period → same D, same key.
* Rollout/rollback safety: a V1 `checkin:<client>:<D>` event counts as the due stage and vice versa.
* Quiet hours: a stage whose time falls inside the client's quiet hours is **suppressed**
  (`quiet_hours`), never deferred — so no stale reminder can arrive after a later stage superseded it.
  Program updates keep their V1 defer-to-quiet-end behaviour.

## 4. Rollout switch

Secret `PUSH_CHECKIN_V2_CLIENTS` on the `push` function: unset → everyone keeps the V1 single Sunday
reminder; `_push_canary` → canary only; `*` → every eligible, opted-in client. Opt-in, eligibility and
per-client toggles are unchanged; nobody is subscribed by this.

## 5. Future (not built)

* **V3 daily weigh-in:** needs a daily weight-log workflow in the shell first; the conditional
  reminder already exists behind `weighin_available`.
* **Workout adherence:** needs a session-complete marker (one row per finished session) — with that,
  a weekly *count* nudge (completed sessions vs prescribed sessions/week, late in the week) becomes
  RELIABLE without inventing a weekday schedule.
* **Nutrition adherence:** needs meal logs linked to the prescribed plan (week/day/meal index +
  followed/swapped/skipped status stored server-side).
