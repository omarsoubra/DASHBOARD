-- ============================================================================
-- LOCKED IN Testimonials V1 (Omar 2026-10-16)
-- Migration: 20261016120000_testimonials
--
-- ONE new table. No existing table, column, row, constraint, index, policy or
-- function is altered.
--
-- A row is one testimonial request: the coach creates a private link for a
-- client (testimonialLinkCreate); the client answers on testimonial.html
-- (testimonialFormGet / testimonialSubmit, by link token only); the coach reads
-- answers + sharing consent in the dashboard (testimonialsGet).
-- Only the sha256 of the link token is stored. Links expire after 30 days.
--
-- Written and read only by the `api` Edge Function (service role).
-- RLS on, default-deny (no policies).
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

create table if not exists public.testimonials (
  id            bigserial primary key,
  client_key    text not null check (client_key ~ '^[a-z0-9_]{1,64}$'),
  first_name    text not null default '' check (length(first_name) <= 40),
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  submitted_at  timestamptz,
  updated_at    timestamptz,
  answers       jsonb not null default '{}'::jsonb,
  consent       jsonb not null default '{}'::jsonb
);

create index if not exists testimonials_client_idx on public.testimonials (client_key, created_at desc);

alter table public.testimonials enable row level security;

commit;
