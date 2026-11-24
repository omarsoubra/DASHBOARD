-- ============================================================================
-- LOCKED IN Coach Platform V1 (Omar 2026-11-24)
-- Migration: 20261124120000_coach_platform
--
-- Lets OTHER coaches use the platform: each coach has a login, sees only their
-- own clients, and builds plans with the in-app plan builder (no AI in the loop).
--
-- FIVE new tables and ONE new nullable column:
--   coaches          one row per outside coach (Omar is NOT a row: his login is
--                    unchanged and his clients keep coach_id = NULL)
--   coach_sessions   login sessions (only the sha256 of the session key is stored)
--   plan_builds      the plan-builder queue: form in, plan preview out, publish
--   coach_templates  a coach's own saved plans, reusable for any client
--   coach_client_state  the coach's private notes on a client + how far they have read the check-ins
--   clients.coach_id NULL = Omar's client (every existing row). Set = that coach's.
--
-- No existing row, constraint, index, policy or function is changed. A coach's
-- client is also marked is_internal = true by the API, so it never appears in
-- Omar's dashboard numbers, registry, account list or automatic pushes.
--
-- Written and read only by the `api` Edge Function (service role).
-- RLS on, default-deny (no policies).
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

create table if not exists public.coaches (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9]{2,16}$'),
  name             text not null check (length(name) between 1 and 60),
  brand            text not null default '' check (length(brand) <= 40),
  accent           text check (accent is null or accent ~ '^#[0-9a-fA-F]{6}$'),   -- the coach's colour for their clients' app
  logo             jsonb,                                                          -- {"512","192","180","32"}: base64 PNG at each size
  email            text not null unique check (email = lower(email) and length(email) <= 200),
  password_hash    text check (password_hash is null or password_hash ~ '^[0-9a-f]{64}$'),
  password_salt    text check (password_salt is null or password_salt ~ '^[0-9a-f]{32}$'),
  setup_token_hash text check (setup_token_hash is null or setup_token_hash ~ '^[0-9a-f]{64}$'),
  setup_expires_at timestamptz,
  status           text not null default 'active' check (status in ('active', 'suspended')),
  client_limit     integer not null default 25 check (client_limit between 0 and 1000),
  failed_logins    integer not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz
);

create table if not exists public.coach_sessions (
  id          bigserial primary key,
  coach_id    uuid not null references public.coaches(id) on delete cascade,
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index if not exists coach_sessions_coach_idx on public.coach_sessions (coach_id);

create table if not exists public.plan_builds (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references public.coaches(id) on delete cascade,
  storage_key   text not null check (storage_key ~ '^c_[a-z0-9_]{2,38}$'),
  is_update     boolean not null default false,
  form          jsonb not null,
  status        text not null default 'queued'
                check (status in ('queued', 'building', 'built', 'failed', 'publishing', 'live', 'discarded')),
  summary       jsonb,
  plan          jsonb,
  error         jsonb,
  page_sha256   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  published_at  timestamptz
);
create index if not exists plan_builds_coach_idx on public.plan_builds (coach_id, created_at desc);
create index if not exists plan_builds_open_idx on public.plan_builds (status, created_at)
  where status in ('queued', 'building', 'publishing');

-- A coach's own saved plans: the structure of a plan (training plan, menu, length, hand edits) with no client in it.
create table if not exists public.coach_templates (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references public.coaches(id) on delete cascade,
  name        text not null check (length(name) between 1 and 60),
  form        jsonb not null,
  created_at  timestamptz not null default now(),
  unique (coach_id, name)
);

-- What a coach keeps about a client that the client never sees: private notes and how far they have read the check-ins.
create table if not exists public.coach_client_state (
  storage_key      text primary key check (storage_key ~ '^c_[a-z0-9_]{2,38}$'),
  coach_id         uuid not null references public.coaches(id) on delete cascade,
  notes            text not null default '' check (length(notes) <= 4000),
  reviewed_through timestamptz,
  updated_at       timestamptz not null default now()
);

alter table public.clients add column if not exists coach_id uuid references public.coaches(id);
create index if not exists clients_coach_id_idx on public.clients (coach_id) where coach_id is not null;

comment on column public.clients.coach_id is
  'Coach Platform V1: NULL = Omar''s own client. Set = the outside coach who owns this client (see public.coaches).';

alter table public.coaches        enable row level security;
alter table public.coach_sessions enable row level security;
alter table public.plan_builds    enable row level security;
alter table public.coach_templates enable row level security;
alter table public.coach_client_state enable row level security;

commit;

-- Rollback (only if no coach has been created):
--   drop index if exists public.clients_coach_id_idx;
--   alter table public.clients drop column if exists coach_id;
--   drop table if exists public.coach_client_state;
--   drop table if exists public.coach_templates;
--   drop table if exists public.plan_builds;
--   drop table if exists public.coach_sessions;
--   drop table if exists public.coaches;
