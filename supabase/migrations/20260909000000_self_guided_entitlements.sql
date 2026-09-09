-- ============================================================================
-- StrengthByO / LOCKED IN — products + client entitlements (SELF-GUIDED foundation)
-- Migration: 20260909000000_self_guided_entitlements
--
-- Purpose
--   Introduce a first-class product/entitlement model so access is granted by
--   what a client owns, not by a hardcoded tier string.
--
-- ACCESS CONTROL FAILS CLOSED
--   Every client that exists at migration time is marked entitlement_legacy and
--   backfilled with an active locked_in_1to1 grant, in this one transaction.
--   Every client created AFTER this migration defaults to entitlement_legacy =
--   false and therefore has NO capabilities until an entitlement is granted.
--   A missing entitlement can never promote a new client to premium.
--
-- Properties
--   * Purely ADDITIVE. No column dropped, renamed or repurposed.
--   * References only clients.id and clients.start_date — both proven by the
--     canonical insert in clientCreate(). It does NOT use clients.created_at,
--     which repository evidence does not prove exists.
--   * Backfill timestamp: start_date where present, otherwise the cutover time
--     (now()). Historical precision is deliberately traded for deterministic
--     migration success; these rows are compatibility records, not billing data.
--   * The marker and the backfill are set in the SAME transaction, so they
--     cannot diverge.
--   * RLS enabled and default-deny on both new tables. The Edge Function uses
--     the service role and is unaffected; no anon/authenticated policy exists.
--   * Reversible — see the DOWN block at the end (commented).
--
-- Run once, in the Supabase SQL editor, BEFORE deploying the Edge Function.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. products
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  code           text        not null unique,
  name           text        not null,
  active         boolean     not null default true,
  duration_weeks integer,
  config         jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table  public.products      is 'Sellable/access-controlled products. code is the stable identifier used by the Edge Function capability matrix.';
comment on column public.products.code is 'Stable machine identifier, e.g. locked_in_1to1, locked_in_self_guided_12w.';

insert into public.products (code, name, active, duration_weeks, config) values
  ('locked_in_1to1',            'LOCKED IN 1:1',         true, null, '{"coached":true}'::jsonb),
  ('locked_in_self_guided_12w', 'LOCKED IN Self-Guided', true, 12,   '{"coached":false,"price_aud_weekly":39.95,"commitment_weeks":12}'::jsonb)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- B. client_entitlements — authoritative grants.
-- ---------------------------------------------------------------------------
create table if not exists public.client_entitlements (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null references public.clients(id) on delete cascade,
  product_code text        not null references public.products(code),
  status       text        not null default 'pending',
  starts_at    timestamptz,
  ends_at      timestamptz,
  source       text        not null default 'manual',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint client_entitlements_status_check
    check (status in ('pending','active','paused','expired','revoked')),
  constraint client_entitlements_source_check
    check (source in ('manual','billing','migration','admin','promotional')),
  constraint client_entitlements_window_check
    check (ends_at is null or starts_at is null or ends_at > starts_at)
);

comment on table  public.client_entitlements        is 'Authoritative access grants. Only one row may be active per (client, product).';
comment on column public.client_entitlements.source is 'How the grant arrived. billing is reserved for a future provider calling entitlementGrant.';

create index if not exists client_entitlements_client_status_idx
  on public.client_entitlements (client_id, status);
create index if not exists client_entitlements_product_status_idx
  on public.client_entitlements (product_code, status);
create unique index if not exists client_entitlements_one_active_idx
  on public.client_entitlements (client_id, product_code)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- C. clients.entitlement_legacy — the ONLY thing that permits a premium
--    fallback without an entitlement row. Set true here for pre-cutover
--    clients; every client created afterwards defaults to false and is
--    therefore denied until explicitly entitled.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists entitlement_legacy boolean not null default false;

comment on column public.clients.entitlement_legacy is
  'TRUE only for clients that existed at the 20260909 entitlement cutover. Permits premium access without an entitlement row, for backfill-timing safety. Never set this on a new client — doing so grants premium capabilities.';

-- Mark every client that exists right now. New rows default to false.
update public.clients set entitlement_legacy = true;

-- D. clients.current_tier — DENORMALISED, display only. Never gate on it.
alter table public.clients add column if not exists current_tier text;
comment on column public.clients.current_tier is
  'Denormalised label for fast UI display. NOT authoritative — client_entitlements is.';

-- ---------------------------------------------------------------------------
-- E. Backfill: every pre-cutover client is a 1:1 client. Idempotent.
--    Uses start_date (proven) and falls back to the cutover timestamp.
-- ---------------------------------------------------------------------------
insert into public.client_entitlements (client_id, product_code, status, starts_at, source, notes)
select c.id,
       'locked_in_1to1',
       'active',
       coalesce(c.start_date::timestamptz, now()),
       'migration',
       'Backfilled by 20260909000000: pre-cutover 1:1 client.'
from public.clients c
where not exists (
  select 1 from public.client_entitlements e where e.client_id = c.id
);

update public.clients c
   set current_tier = 'locked_in_1to1'
 where c.current_tier is null
   and exists (
     select 1 from public.client_entitlements e
      where e.client_id = c.id and e.product_code = 'locked_in_1to1' and e.status = 'active'
   );

-- ---------------------------------------------------------------------------
-- F. RLS — default deny. Service role (Edge Function) is unaffected.
-- ---------------------------------------------------------------------------
alter table public.products            enable row level security;
alter table public.client_entitlements enable row level security;

commit;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION (run manually; expect zero rows from the first)
-- ---------------------------------------------------------------------------
--   select storage_key from public.clients
--    where entitlement_legacy = false;                  -- expect: 0 rows
--   select count(*) from public.client_entitlements
--    where product_code = 'locked_in_1to1' and status = 'active';  -- expect: client count
-- ============================================================================
-- DOWN (commented — review before running)
--   begin;
--     drop index if exists public.client_entitlements_one_active_idx;
--     drop index if exists public.client_entitlements_product_status_idx;
--     drop index if exists public.client_entitlements_client_status_idx;
--     drop table if exists public.client_entitlements;
--     drop table if exists public.products;
--     alter table public.clients drop column if exists entitlement_legacy;
--     alter table public.clients drop column if exists current_tier;
--   commit;
-- ============================================================================
