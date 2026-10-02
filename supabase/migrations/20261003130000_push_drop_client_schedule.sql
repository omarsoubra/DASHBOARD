-- ============================================================================
-- LOCKED IN Push — remove the client-owned reminder schedule
--
-- Ownership change (Omar, 2026-10-02): the approved plan owns WHEN a client
-- trains and eats; push_preferences only answers "does this client want this
-- category?" (training_enabled / meals_enabled stay).
--
-- Apply ONLY AFTER the plan-synced push function is deployed (it no longer
-- reads or writes these columns; the previous function still does).
-- Only the internal canary ever held values here.
-- ============================================================================
begin;

alter table public.push_preferences drop constraint if exists push_preferences_training_complete_check;
alter table public.push_preferences drop constraint if exists push_preferences_training_followup_check;
alter table public.push_preferences drop constraint if exists push_preferences_training_days_check;
alter table public.push_preferences drop constraint if exists push_preferences_meal_times_check;
alter table public.push_preferences drop constraint if exists push_preferences_meals_complete_check;

alter table public.push_preferences drop column if exists training_days;
alter table public.push_preferences drop column if exists training_time;
alter table public.push_preferences drop column if exists training_followup_enabled;
alter table public.push_preferences drop column if exists training_followup_time;
alter table public.push_preferences drop column if exists meal_times;

commit;
