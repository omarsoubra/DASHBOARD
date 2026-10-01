-- ============================================================================
-- LOCKED IN Push — Daily Reminders V1 (training + meal reminders)
--
-- Additive only. Reuses push_preferences / notification_events; adds one
-- system-owned table of facts read from the SERVED client shell.
--
--   push_preferences   client-owned training + meal reminder settings.
--                      Everything defaults OFF and every time defaults NULL:
--                      no training day, training time or meal time is ever
--                      invented. Enabling requires the client's own choices.
--   push_plan_facts    one row per client, written only by the push function
--                      (planFactsSync, deploy secret) from the bytes GitHub
--                      Pages serves: current feed count (NULL = variable or
--                      unreadable → meal reminders unavailable), whether the
--                      shell carries Finish Workout, served shell hash.
--   notification_events  + kinds training_reminder / meal_reminder,
--                      + suppression reasons, + context (stage / slot /
--                      completion ref — never food, kcal or prescription data).
--
-- The weekly check-in columns, kinds and reasons are unchanged.
-- ============================================================================
begin;

-- ── 1. client-owned settings (all OFF) ──────────────────────────────────────
alter table public.push_preferences add column if not exists training_enabled boolean not null default false;
alter table public.push_preferences add column if not exists training_days smallint not null default 0;
alter table public.push_preferences add column if not exists training_time time;
alter table public.push_preferences add column if not exists training_followup_enabled boolean not null default false;
alter table public.push_preferences add column if not exists training_followup_time time;
alter table public.push_preferences add column if not exists meals_enabled boolean not null default false;
alter table public.push_preferences add column if not exists meal_times time[] not null default '{}';

-- training_days: bit d set ⇔ the client trains on weekday d (0 = Sunday … 6 = Saturday, like checkin_dow).
alter table public.push_preferences drop constraint if exists push_preferences_training_days_check;
alter table public.push_preferences add constraint push_preferences_training_days_check
  check (training_days between 0 and 127);
-- Enabled training needs the client's own days AND time.
alter table public.push_preferences drop constraint if exists push_preferences_training_complete_check;
alter table public.push_preferences add constraint push_preferences_training_complete_check
  check (not training_enabled or (training_time is not null and training_days > 0));
-- Follow-up: only with training on, its own time, >= 60 min after the primary,
-- same local day (time - time is negative when the follow-up is earlier).
alter table public.push_preferences drop constraint if exists push_preferences_training_followup_check;
alter table public.push_preferences add constraint push_preferences_training_followup_check
  check (not training_followup_enabled or (
    training_enabled and training_time is not null and training_followup_time is not null
    and training_followup_time - training_time >= interval '60 minutes'));
-- Meal slots are ordinal: meal_times[k] is "Meal k". NULL element = slot not set.
alter table public.push_preferences drop constraint if exists push_preferences_meal_times_check;
alter table public.push_preferences add constraint push_preferences_meal_times_check
  check (cardinality(meal_times) <= 8);
alter table public.push_preferences drop constraint if exists push_preferences_meals_complete_check;
alter table public.push_preferences add constraint push_preferences_meals_complete_check
  check (not meals_enabled or cardinality(array_remove(meal_times, null)) > 0);

comment on column public.push_preferences.training_days is
  'LOCKED IN daily reminders (client-owned): weekdays the CLIENT said they train, bit d = weekday d (0=Sun). Never derived from the programme.';
comment on column public.push_preferences.meal_times is
  'LOCKED IN daily reminders (client-owned): reminder time per ordinal meal slot (index 1 = Meal 1). Blank by default; never pre-filled.';

-- ── 2. facts from the served shell (system-owned) ───────────────────────────
create table if not exists public.push_plan_facts (
  client_id               uuid primary key references public.clients(id) on delete cascade,
  storage_key             text not null,
  meal_facts_status       text not null check (meal_facts_status in ('consistent', 'variable', 'unreadable', 'unsupported')),
  meal_slot_count         smallint check (meal_slot_count is null or meal_slot_count between 1 and 8),
  meal_plan_sig           text check (meal_plan_sig is null or meal_plan_sig ~ '^[0-9a-f]{64}$'),
  has_workout_completion  boolean not null default false,
  served_sha256           text not null check (served_sha256 ~ '^[0-9a-f]{64}$'),
  commit_sha              text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,40}$'),
  updated_at              timestamptz not null default now(),
  constraint push_plan_facts_slot_iff_consistent
    check ((meal_facts_status = 'consistent') = (meal_slot_count is not null))
);

comment on table public.push_plan_facts is
  'LOCKED IN daily reminders: facts read from the client shell GitHub Pages SERVES (verified bytes). meal_slot_count NULL = variable/unreadable plan → meal reminders unavailable. Written only by the push function. Service-role only.';

alter table public.push_plan_facts enable row level security;
revoke all on public.push_plan_facts from anon, authenticated;

-- ── 3. notification_events: new kinds, reasons, context ─────────────────────
alter table public.notification_events add column if not exists context jsonb;

alter table public.notification_events drop constraint if exists notification_events_kind_check;
alter table public.notification_events add constraint notification_events_kind_check
  check (kind in ('test', 'weighin_reminder', 'checkin_reminder', 'program_update', 'training_reminder', 'meal_reminder'));

alter table public.notification_events drop constraint if exists notification_events_suppression_reason_check;
alter table public.notification_events add constraint notification_events_suppression_reason_check
  check (suppression_reason is null or suppression_reason in (
    'already_logged', 'already_completed', 'disabled', 'quiet_hours', 'no_active_device',
    'not_allowlisted', 'inactive_client', 'access_not_active', 'duplicate', 'no_timezone',
    'unsupported_workout_completion', 'primary_not_sent', 'no_current_meal_slot', 'daily_cap'));

comment on column public.notification_events.context is
  'LOCKED IN daily reminders: {stage, slot, completionRef} only. Never food, kcal, prescription details, endpoints or secrets.';

commit;

-- ── DOWN (manual, only if this migration must be reverted) ──────────────────
-- begin;
-- delete from public.notification_events where kind in ('training_reminder', 'meal_reminder');
-- (re-add the V1 kind / suppression_reason checks from 20260929120000_push_v1_pilot.sql)
-- alter table public.notification_events drop column if exists context;
-- drop table if exists public.push_plan_facts;
-- alter table public.push_preferences drop constraint if exists push_preferences_meals_complete_check;
-- alter table public.push_preferences drop constraint if exists push_preferences_meal_times_check;
-- alter table public.push_preferences drop constraint if exists push_preferences_training_followup_check;
-- alter table public.push_preferences drop constraint if exists push_preferences_training_complete_check;
-- alter table public.push_preferences drop constraint if exists push_preferences_training_days_check;
-- alter table public.push_preferences drop column if exists meal_times, drop column if exists meals_enabled,
--   drop column if exists training_followup_time, drop column if exists training_followup_enabled,
--   drop column if exists training_time, drop column if exists training_days, drop column if exists training_enabled;
-- commit;
