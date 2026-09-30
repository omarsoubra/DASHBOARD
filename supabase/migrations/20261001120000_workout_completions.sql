-- ============================================================================
-- LOCKED IN Workout Completion V1
-- Migration: 20261001120000_workout_completions
--
-- ONE new table. No existing table, column, row, constraint, index, policy or
-- function is altered. workout_log_entries (exercise logs) is untouched.
--
-- A row is the client's EXPLICIT statement "I completed this session
-- occurrence" (the Finish Workout action). It is never inferred from exercise
-- logs and never backfilled.
--
-- LIMITATION (by design, V1): the session identity (phase_key, day_index,
-- day_label, rx_fingerprint, session_kind) is a shape-validated snapshot
-- asserted by the client's own shell. The server proves WHO completed it
-- (verified client token) and WHEN it was recorded; it cannot independently
-- prove that the stated session exists in the client's current programme
-- (there is no server-side session registry for 1:1 shells).
--
-- Written only by the `api` Edge Function (service role). RLS on, default-deny.
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

create table if not exists public.workout_completions (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients(id) on delete cascade,
  storage_key           text not null,
  completion_ref        text not null check (completion_ref ~ '^cmp_[A-Za-z0-9_-]{16,64}$'),
  phase_key             text not null check (phase_key ~ '^[0-9]{1,2}$'),
  day_index             smallint not null check (day_index between 0 and 13),
  day_label             text not null check (char_length(day_label) between 1 and 120),
  session_kind          text not null check (session_kind in ('mandatory', 'optional', 'unspecified')),
  rx_fingerprint        text check (rx_fingerprint is null or rx_fingerprint ~ '^[0-9a-f]{64}$'),
  exercises_prescribed  smallint check (exercises_prescribed is null or exercises_prescribed between 0 and 99),
  exercises_logged      smallint check (exercises_logged is null or exercises_logged between 0 and 99),
  sets_logged           smallint check (sets_logged is null or sets_logged between 0 and 999),
  completed_at          timestamptz not null,               -- device time of the tap, clamped server-side to [recorded_at - 72 h, recorded_at]
  recorded_at           timestamptz not null default now(), -- server receipt
  local_date            date not null,                      -- the client's calendar day of the tap (calendar-week grouping)
  timezone              text check (timezone is null or char_length(timezone) <= 64),
  status                text not null default 'completed' check (status in ('completed', 'revoked')),
  revoked_at            timestamptz,
  revoked_by            text check (revoked_by is null or revoked_by in ('client', 'coach')),
  constraint workout_completions_revoked_consistent
    check ((status = 'revoked') = (revoked_at is not null and revoked_by is not null)),
  constraint workout_completions_ref_unique unique (client_id, completion_ref)
);

create index if not exists workout_completions_client_completed_idx
  on public.workout_completions (client_id, completed_at desc);

comment on table public.workout_completions is
  'LOCKED IN Workout Completion V1: one row per explicit Finish Workout. Client identity from the verified token only; session identity is a client-asserted snapshot (no server session registry). Never deleted: undo sets status=revoked. Service-role only.';

alter table public.workout_completions enable row level security;
revoke all on public.workout_completions from anon, authenticated;

commit;

-- ============================================================================
-- DOWN (run only to reverse this migration; deploy an api without the three
-- workout completion operations first)
-- ============================================================================
-- begin;
--   drop table if exists public.workout_completions;
-- commit;
