-- ============================================================================
-- LOCKED IN Push Notifications — MINIMAL PROOF schema
-- Migration: 20260928120000_push_notifications_proof
--
-- Properties
--   * Purely ADDITIVE. Two new tables. No existing table, column, row, policy or
--     function is altered.
--   * RLS enabled, NO policies → default-deny for anon/authenticated. Only the
--     `push` Edge Function (service role) reads or writes these tables.
--   * No client, prescription or coaching data is stored here.
--   * Endpoint + subscription keys are wiped (set to '') when a device is
--     unsubscribed or reported gone (404/410) — the row stays for audit only.
--   * Reversible — see the DOWN block at the end (commented).
--
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

-- ── push_devices: one row per browser push subscription ────────────────────
create table if not exists public.push_devices (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  storage_key      text not null,
  endpoint         text not null,                -- '' once revoked/expired
  endpoint_hash    text not null,                -- sha256(endpoint) hex, identity of the subscription
  p256dh           text not null,                -- '' once revoked/expired
  auth_secret      text not null,                -- '' once revoked/expired
  push_host        text not null,
  standalone       boolean not null default false,
  timezone         text,
  status           text not null default 'active'
                     check (status in ('active', 'revoked', 'expired', 'disabled')),
  disabled_reason  text,
  failure_count    integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  constraint push_devices_endpoint_hash_key unique (endpoint_hash),
  constraint push_devices_endpoint_hash_hex check (endpoint_hash ~ '^[0-9a-f]{64}$'),
  constraint push_devices_active_has_keys check (
    status <> 'active' or (length(endpoint) > 0 and length(p256dh) > 0 and length(auth_secret) > 0)
  )
);

create index if not exists push_devices_client_active_idx
  on public.push_devices (client_id) where status = 'active';

comment on table public.push_devices is
  'LOCKED IN push: one row per browser Web Push subscription. Service-role only (RLS default-deny). Endpoint/keys wiped on revoke/expire.';

-- ── notification_events: one row per notification intent + its outcome ─────
create table if not exists public.notification_events (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients(id) on delete cascade,
  storage_key         text not null,
  kind                text not null check (kind in ('test')),   -- widened by the V1 migration
  dedupe_key          text not null,
  status              text not null default 'claimed'
                        check (status in ('claimed', 'sent', 'partial', 'failed', 'suppressed')),
  suppression_reason  text,
  title               text not null,
  body                text not null,
  url                 text not null,
  created_by          text not null check (created_by in ('coach', 'system', 'client')),
  request_id          text,
  device_count        integer not null default 0,
  success_count       integer not null default 0,
  results             jsonb not null default '[]'::jsonb,   -- per device: id, host, http status, outcome (never endpoint/keys)
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  constraint notification_events_dedupe_key_key unique (dedupe_key)
);

create index if not exists notification_events_client_created_idx
  on public.notification_events (client_id, created_at desc);

comment on table public.notification_events is
  'LOCKED IN push: notification intents and delivery outcomes. dedupe_key is the send claim. Service-role only (RLS default-deny).';

-- ── lock down ───────────────────────────────────────────────────────────────
alter table public.push_devices        enable row level security;
alter table public.notification_events enable row level security;

revoke all on public.push_devices        from anon, authenticated;
revoke all on public.notification_events from anon, authenticated;

commit;

-- ============================================================================
-- DOWN (run only to reverse this migration; removes all push proof data)
-- ============================================================================
-- begin;
--   drop table if exists public.notification_events;
--   drop table if exists public.push_devices;
-- commit;
