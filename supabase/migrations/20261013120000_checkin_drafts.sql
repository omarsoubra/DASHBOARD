-- ============================================================================
-- LOCKED IN Check-in reply drafts V1 (Omar 2026-10-13)
-- Migration: 20261013120000_checkin_drafts
--
-- ONE new table. No existing table, column, row, constraint, index, policy or
-- function is altered.
--
-- A row is an agent-drafted reply to ONE client check-in (client_template
-- checkin_review.py + the checkin-reviewer agent), shown to the coach inside
-- the Check-ins review panel. Nothing here is ever sent to a client: the coach
-- copies the text and sends it himself; sent_at records that he did.
--
-- Written and read only by the `api` Edge Function (service role) behind the
-- coach token. RLS on, default-deny (no policies).
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

create table if not exists public.checkin_drafts (
  id          bigserial primary key,
  client_key  text not null check (client_key ~ '^[a-z0-9_]{1,64}$'),
  checkin_ts  text not null check (length(checkin_ts) between 10 and 40),   -- the check-in's timestamp exactly as `dashboard` returns it
  action      text not null check (action ~ '^[a-z_]{2,32}$'),
  for_coach   jsonb not null default '[]'::jsonb,
  draft       text not null default '' check (length(draft) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (client_key, checkin_ts)
);

create index if not exists checkin_drafts_created_idx on public.checkin_drafts (created_at desc);

alter table public.checkin_drafts enable row level security;

commit;
