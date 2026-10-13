-- ============================================================================
-- LOCKED IN Coach morning report push (Omar 2026-10-13)
-- Migration: 20261013140000_coach_morning
--
-- Adds ONE allowed value to notification_events.kind: 'coach_morning' — the
-- 07:00 Sydney morning report sent by pushTick to the coach's own phone (the
-- device registered under the internal `_coach` account). Nothing else changes.
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================
begin;

alter table public.notification_events drop constraint if exists notification_events_kind_check;
alter table public.notification_events add constraint notification_events_kind_check
  check (kind in ('test','weighin_reminder','checkin_reminder','program_update','training_reminder','meal_reminder','coach_morning'));

commit;
