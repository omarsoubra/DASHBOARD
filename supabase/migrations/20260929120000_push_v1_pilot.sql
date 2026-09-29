-- ============================================================================
-- LOCKED IN Push Notifications V1 — PILOT schema
-- Migration: 20260929120000_push_v1_pilot
--
-- Builds on 20260928120000_push_notifications_proof. Touches ONLY push tables:
--   * push_preferences     NEW  one row per client who has opted in
--   * push_internal_auth   NEW  sha256 of the scheduler / deploy-notifier secrets
--   * notification_events  ALTER  new kinds, eligible_at, period_key,
--                                 suppression_reason vocabulary
-- No existing non-push table, column, row, policy or function is altered.
-- RLS enabled + default-deny on the new tables; only the `push` Edge Function
-- (service role) reads or writes them.
--
-- Apply by hand (Supabase SQL editor). Do NOT `supabase db push`.
-- ============================================================================

begin;

-- ── push_preferences ────────────────────────────────────────────────────────
-- Created ONLY by an explicit client opt-in (pushSubscribe). Absence = silence.
-- Coach-owned columns (never writable by the client API):
--   weighin_available  — daily weigh-in reminders are only meaningful once the
--                        client's app has a daily weight log (see docs). Default off.
--   checkin_dow        — the check-in weekday (fleet shells hard-code Sunday = 0).
create table if not exists public.push_preferences (
  client_id                uuid primary key references public.clients(id) on delete cascade,
  storage_key              text not null,
  notifications_enabled    boolean not null default false,
  consent_at               timestamptz,
  timezone                 text,
  weighin_available        boolean not null default false,
  weighin_enabled          boolean not null default true,
  weighin_time             time not null default '07:30',
  checkin_enabled          boolean not null default true,
  checkin_dow              smallint not null default 0 check (checkin_dow between 0 and 6),
  checkin_time             time not null default '09:00',
  program_updates_enabled  boolean not null default true,
  quiet_start              time not null default '21:00',
  quiet_end                time not null default '07:00',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               text not null default 'client' check (updated_by in ('client', 'coach', 'system')),
  constraint push_preferences_enabled_needs_consent check (not notifications_enabled or consent_at is not null)
);

comment on table public.push_preferences is
  'LOCKED IN push: per-client notification settings. Row exists only after explicit opt-in. weighin_available and checkin_dow are coach-owned. Service-role only (RLS default-deny).';

-- ── push_internal_auth ──────────────────────────────────────────────────────
-- Privileged callers (pg_cron scheduler, GitHub deploy notifier) present a
-- secret; only its sha256 lives here. No row = that caller is refused.
create table if not exists public.push_internal_auth (
  name           text primary key check (name in ('cron', 'deploy')),
  secret_sha256  text not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  rotated_at     timestamptz
);

comment on table public.push_internal_auth is
  'LOCKED IN push: sha256 of internal caller secrets (scheduler, deploy notifier). Never the secret itself. Service-role only.';

-- ── notification_events: V1 kinds + scheduling fields ──────────────────────
alter table public.notification_events drop constraint if exists notification_events_kind_check;
alter table public.notification_events add constraint notification_events_kind_check
  check (kind in ('test', 'weighin_reminder', 'checkin_reminder', 'program_update'));

-- 'deferred': an event-driven notification (program update) that arrived during
-- quiet hours; the scheduler delivers it at eligible_at (end of quiet hours).
alter table public.notification_events drop constraint if exists notification_events_status_check;
alter table public.notification_events add constraint notification_events_status_check
  check (status in ('claimed', 'deferred', 'sent', 'partial', 'failed', 'suppressed'));

alter table public.notification_events add column if not exists eligible_at timestamptz;
alter table public.notification_events add column if not exists period_key  text;

alter table public.notification_events drop constraint if exists notification_events_suppression_reason_check;
alter table public.notification_events add constraint notification_events_suppression_reason_check
  check (suppression_reason is null or suppression_reason in (
    'already_logged', 'already_completed', 'disabled', 'quiet_hours', 'no_active_device',
    'not_allowlisted', 'inactive_client', 'access_not_active', 'duplicate', 'no_timezone'));

create index if not exists notification_events_kind_created_idx
  on public.notification_events (kind, created_at desc);

-- ── lock down ───────────────────────────────────────────────────────────────
alter table public.push_preferences   enable row level security;
alter table public.push_internal_auth enable row level security;

revoke all on public.push_preferences   from anon, authenticated;
revoke all on public.push_internal_auth from anon, authenticated;

commit;

-- ============================================================================
-- DOWN (run only to reverse this migration)
-- ============================================================================
-- begin;
--   delete from public.notification_events where kind <> 'test';
--   drop index if exists public.notification_events_kind_created_idx;
--   alter table public.notification_events drop constraint if exists notification_events_suppression_reason_check;
--   alter table public.notification_events drop column if exists period_key;
--   alter table public.notification_events drop column if exists eligible_at;
--   alter table public.notification_events drop constraint if exists notification_events_status_check;
--   alter table public.notification_events add constraint notification_events_status_check check (status in ('claimed', 'sent', 'partial', 'failed', 'suppressed'));
--   alter table public.notification_events drop constraint if exists notification_events_kind_check;
--   alter table public.notification_events add constraint notification_events_kind_check check (kind in ('test'));
--   drop table if exists public.push_internal_auth;
--   drop table if exists public.push_preferences;
-- commit;
