-- ============================================================================
-- LOCKED IN Push — Daily Reminders V1: PLAN-SYNCED schedule (additive)
--
-- The approved coaching plan owns the training / meal reminder schedule
-- (locked-in.schedule.v1 in prescription.json or the client JSON). The
-- generator compiles it into the served shell as `const LI_SCHEDULE = {...};`;
-- planFactsSync reads it from the VERIFIED-LIVE bytes and stores it here,
-- re-validated server-side. No second schedule exists anywhere.
--
--   schedule                    the plan's LI_SCHEDULE object (null = plan has none)
--   schedule_sig                sha256 of it (changes with every plan change)
--   training_schedule_status    confirmed | unknown | invalid  (only confirmed is usable)
--   meal_schedule_status        confirmed | unknown | invalid
--
-- Times in the schedule are local wall-clock times; the ONLY runtime timezone
-- is push_preferences.timezone (the schema carries no timezone of its own).
--
-- Apply BEFORE deploying the plan-synced push function. The client-owned
-- schedule columns are removed by 20261003130000 AFTER that deploy.
-- ============================================================================
begin;

alter table public.push_plan_facts add column if not exists schedule jsonb;
alter table public.push_plan_facts add column if not exists schedule_sig text;
alter table public.push_plan_facts add column if not exists training_schedule_status text not null default 'unknown';
alter table public.push_plan_facts add column if not exists meal_schedule_status text not null default 'unknown';

alter table public.push_plan_facts drop constraint if exists push_plan_facts_schedule_sig_check;
alter table public.push_plan_facts add constraint push_plan_facts_schedule_sig_check
  check (schedule_sig is null or schedule_sig ~ '^[0-9a-f]{64}$');
alter table public.push_plan_facts drop constraint if exists push_plan_facts_training_schedule_status_check;
alter table public.push_plan_facts add constraint push_plan_facts_training_schedule_status_check
  check (training_schedule_status in ('confirmed', 'unknown', 'invalid'));
alter table public.push_plan_facts drop constraint if exists push_plan_facts_meal_schedule_status_check;
alter table public.push_plan_facts add constraint push_plan_facts_meal_schedule_status_check
  check (meal_schedule_status in ('confirmed', 'unknown', 'invalid'));
alter table public.push_plan_facts drop constraint if exists push_plan_facts_schedule_consistent;
alter table public.push_plan_facts add constraint push_plan_facts_schedule_consistent
  check ((schedule is null) = (schedule_sig is null)
     and (schedule is not null or (training_schedule_status = 'unknown' and meal_schedule_status = 'unknown')));

comment on column public.push_plan_facts.schedule is
  'LOCKED IN daily reminders: the approved plan''s LI_SCHEDULE (locked-in.schedule.v1) read from verified-live shell bytes. Coach-owned; never client-edited.';

-- plan_out_of_sync: an in-app trainer-mode meal edit no longer matches the synced feed count → no meal reminder.
alter table public.notification_events drop constraint if exists notification_events_suppression_reason_check;
alter table public.notification_events add constraint notification_events_suppression_reason_check
  check (suppression_reason is null or suppression_reason in (
    'already_logged', 'already_completed', 'disabled', 'quiet_hours', 'no_active_device',
    'not_allowlisted', 'inactive_client', 'access_not_active', 'duplicate', 'no_timezone',
    'unsupported_workout_completion', 'primary_not_sent', 'no_current_meal_slot', 'daily_cap',
    'plan_out_of_sync'));

commit;
