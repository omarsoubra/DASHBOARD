-- ============================================================================
-- LOCKED IN Push — default reminder schedule + client-chosen training time/days
--
-- Omar, 2026-10-11: every client gets training and meal reminders without a
-- hand-entered schedule.
--   training  5pm on a default weekday pattern from the plan's sessions per week
--             (3 = Mon/Wed/Fri, 4 = Mon/Tue/Thu/Fri, 5 = Mon–Fri, 6 = Mon–Sat),
--             +2 h follow-up when Finish Workout exists. The CLIENT may change
--             the time and the days (training_time_custom / training_days_custom).
--   meals     at most two a day: lunch and dinner, at the plan's own times when
--             the served plan states them, else 12:30 and 20:30. Not client-edited.
-- A confirmed LI_SCHEDULE (locked-in.schedule.v1) still wins over the defaults;
-- the client's own training choice wins over both.
--
-- Additive only. Safe to apply before or after the push function deploy (the
-- previous function never reads these columns).
-- ============================================================================
begin;

-- Facts read from the verified-live served shell (scripts/push/plan_facts.mjs).
alter table public.push_plan_facts add column if not exists training_days_per_week smallint;
alter table public.push_plan_facts add column if not exists meal_lunch_time time;
alter table public.push_plan_facts add column if not exists meal_dinner_time time;
alter table public.push_plan_facts drop constraint if exists push_plan_facts_training_days_per_week_check;
alter table public.push_plan_facts add constraint push_plan_facts_training_days_per_week_check
  check (training_days_per_week is null or training_days_per_week between 1 and 7);

-- The client's own training reminder choice (null = follow the plan / default).
alter table public.push_preferences add column if not exists training_time_custom time;
alter table public.push_preferences add column if not exists training_days_custom smallint[];
alter table public.push_preferences drop constraint if exists push_preferences_training_custom_check;
alter table public.push_preferences add constraint push_preferences_training_custom_check
  check ((training_time_custom is null or extract(minute from training_time_custom)::int % 15 = 0)
     and (training_days_custom is null or (cardinality(training_days_custom) between 1 and 7
          and training_days_custom <@ array[0,1,2,3,4,5,6]::smallint[])));

comment on column public.push_preferences.training_time_custom is
  'LOCKED IN push: the client''s own training reminder time (15-min steps). Null = plan time or the 17:00 default.';
comment on column public.push_preferences.training_days_custom is
  'LOCKED IN push: the client''s own training reminder weekdays (0 = Sunday). Null = plan days or the default pattern.';

commit;
