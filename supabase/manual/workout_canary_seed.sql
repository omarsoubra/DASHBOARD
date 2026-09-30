-- ============================================================================
-- LOCKED IN Workout Completion V1 — create the internal `_workout_canary` client
--
-- MANUAL. Run once in the Supabase SQL editor, AFTER
-- supabase/migrations/20261001120000_workout_completions.sql.
-- This folder is not a migrations folder: `supabase db push` never runs it.
--
-- Creates ONE internal, non-paying row (profile + client) used only by the
-- workout-completion canary shell (clients/_workout_canary/, generated from
-- master_template.html with synthetic data). Touches no existing row.
-- Idempotent. is_internal = true keeps it out of stats, the registry and
-- automatic push eligibility. Its token and its locked_in_1to1 grant are
-- issued afterwards through the existing coach-authenticated api
-- (scripts/workouts/issue_workout_canary.mjs).
-- ============================================================================
begin;
do $$
declare pid uuid;
begin
  if exists (select 1 from public.clients where storage_key = '_workout_canary') then
    raise notice '_workout_canary already exists — nothing to do';
    return;
  end if;
  insert into public.profiles (role, full_name)
  values ('client', 'LOCKED IN Workout Canary (internal)')
  returning id into pid;
  insert into public.clients (profile_id, storage_key, display_name, is_internal)
  values (pid, '_workout_canary', 'LOCKED IN Workout Canary (internal)', true);
end $$;
commit;
select id, storage_key, display_name, is_internal from public.clients where storage_key = '_workout_canary';
