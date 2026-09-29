-- ============================================================================
-- LOCKED IN Notifications V2 — check-in adherence sequence
-- Migration: 20260930120000_push_v2_checkin_sequence
--
-- Touches ONLY public.push_preferences: three coach-owned columns holding the
-- stage schedule of the weekly check-in sequence (due → followup → final).
-- The defaults ARE the production schedule (Sunday 18:00 follow-up, Monday
-- 10:00 final); per-client values exist so the internal canary can run a
-- compressed sequence. The client API can never write them (pushPrefsSet
-- rejects unknown fields). No existing column, row, constraint or policy of any
-- table is altered; existing rows receive the defaults.
--
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

alter table public.push_preferences add column if not exists checkin_followup_time time not null default '18:00';
alter table public.push_preferences add column if not exists checkin_final_time time not null default '10:00';
alter table public.push_preferences add column if not exists checkin_final_day_offset smallint not null default 1;

alter table public.push_preferences drop constraint if exists push_preferences_final_day_offset_check;
alter table public.push_preferences add constraint push_preferences_final_day_offset_check
  check (checkin_final_day_offset in (0, 1));

comment on column public.push_preferences.checkin_followup_time is
  'LOCKED IN push V2 (coach-owned): check-in follow-up stage, local time on the due day. Sent only if still incomplete.';
comment on column public.push_preferences.checkin_final_time is
  'LOCKED IN push V2 (coach-owned): final check-in reminder, local time on due day + checkin_final_day_offset. Sent only if still incomplete.';
comment on column public.push_preferences.checkin_final_day_offset is
  'LOCKED IN push V2 (coach-owned): 1 = the day after the due day (production); 0 = same day (compressed canary only).';

commit;

-- ============================================================================
-- DOWN (run only to reverse this migration; deploy the V1 function first)
-- ============================================================================
-- begin;
--   alter table public.push_preferences drop constraint if exists push_preferences_final_day_offset_check;
--   alter table public.push_preferences drop column if exists checkin_final_day_offset;
--   alter table public.push_preferences drop column if exists checkin_final_time;
--   alter table public.push_preferences drop column if exists checkin_followup_time;
-- commit;
