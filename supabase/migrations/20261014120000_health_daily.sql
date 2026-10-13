-- ============================================================================
-- LOCKED IN Apple Health V1 (Omar 2026-10-14)
-- Migration: 20261014120000_health_daily
--
-- TWO new tables. No existing table, column, row, constraint, index, policy or
-- function is altered.
--
-- health_keys   one upload key per client (only its sha256 is stored). The coach
--               issues it; it does NOTHING until the client opens the setup page and
--               agrees (consent_at). It can only ever write that client's daily health
--               totals - it reads nothing and opens nothing else. Revoking it (client or
--               coach) stops uploads immediately; a new key replaces the old one.
-- health_daily  one row per client per day: daily totals sent by the client's own
--               iPhone Shortcut from Apple Health (steps, active energy, exercise
--               minutes, resting heart rate, sleep). Health information is sensitive
--               information (Australian Privacy Act): collected only with the client's
--               consent, read only by the coach, deleted when the client switches it off.
--
-- Written and read only by the `api` Edge Function (service role). RLS on,
-- default-deny (no policies).
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================
begin;

create table if not exists public.health_keys (
  id               bigserial primary key,
  client_id        uuid not null references public.clients(id) on delete cascade,
  storage_key      text not null check (storage_key ~ '^[a-z0-9_]{1,64}$'),
  key_hash         text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  consent_at       timestamptz,                       -- the client agreed on the setup page; null = not active yet
  consent_version  text check (consent_version is null or length(consent_version) <= 32),
  revoked_at       timestamptz,
  revoked_by       text check (revoked_by is null or revoked_by in ('client', 'coach', 'replaced')),
  last_used_at     timestamptz,
  uploads_today    integer not null default 0,
  uploads_day      date
);
create index if not exists health_keys_client_idx on public.health_keys (client_id);

create table if not exists public.health_daily (
  id             bigserial primary key,
  client_id      uuid not null references public.clients(id) on delete cascade,
  storage_key    text not null check (storage_key ~ '^[a-z0-9_]{1,64}$'),
  day            date not null,
  steps          integer check (steps is null or steps between 0 and 150000),
  active_kcal    integer check (active_kcal is null or active_kcal between 0 and 10000),
  exercise_min   integer check (exercise_min is null or exercise_min between 0 and 1440),
  resting_hr     integer check (resting_hr is null or resting_hr between 20 and 250),
  sleep_min      integer check (sleep_min is null or sleep_min between 0 and 1440),
  source         text not null default 'apple_health_shortcut' check (length(source) <= 40),
  received_at    timestamptz not null default now(),
  unique (client_id, day)
);
create index if not exists health_daily_key_day_idx on public.health_daily (storage_key, day);

alter table public.health_keys  enable row level security;
alter table public.health_daily enable row level security;

commit;
