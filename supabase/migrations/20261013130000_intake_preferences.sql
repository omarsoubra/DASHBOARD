-- ============================================================================
-- LOCKED IN intake: lifestyle + food preferences the meal-plan agents need
-- (Omar 2026-10-13). Migration: 20261013130000_intake_preferences
--
-- Six new NULLABLE text columns on public.intakes. Nothing existing is altered;
-- every existing row keeps NULL (= not asked). Values are validated by the `api`
-- Edge Function whitelist (INTAKE_ENUM / work_days pattern) before insert.
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

alter table public.intakes add column if not exists halal_pref   text;   -- halal_only | prefer | no
alter table public.intakes add column if not exists work_days    text;   -- 'mon,tue,...' or 'varies'
alter table public.intakes add column if not exists work_hours   text;   -- free text, optional (e.g. 7am-3pm, rotating shifts)
alter table public.intakes add column if not exists cooking_time text;   -- minimal | some | plenty | batch
alter table public.intakes add column if not exists shakes_ok    text;   -- yes | sometimes | no
alter table public.intakes add column if not exists food_out     text;   -- rarely | weekly | often

commit;
