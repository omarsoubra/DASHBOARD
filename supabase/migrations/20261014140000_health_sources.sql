-- ============================================================================
-- LOCKED IN Apple Health V1.1 (Omar 2026-10-14)
-- Migration: 20261014140000_health_sources
--
-- ONE new nullable column on health_daily: which devices the day's totals came
-- from, e.g. {"steps": {"Omar's Garmin": 9120, "Omar's iPhone": 4210}}. It lets
-- the coach see who wears what (Apple Watch / Garmin / iPhone only) and keeps the
-- per-device totals behind the day's number. Nothing else changes.
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================
begin;
alter table public.health_daily add column if not exists sources jsonb;
commit;
