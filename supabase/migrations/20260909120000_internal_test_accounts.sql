-- ============================================================================
-- StrengthByO / LOCKED IN — internal (non-paying) test accounts
-- Migration: 20260909120000_internal_test_accounts
--
-- Purpose
--   Mark sg_canary — and any future internal account — as internal/test so it
--   never appears in the business surfaces Omar reads as real client numbers.
--
-- Properties
--   * Purely ADDITIVE. One nullable-with-default boolean column.
--   * Defaults false, so every existing and future real client is unaffected.
--   * Display/analytics only. This flag grants and revokes NOTHING: access is
--     decided by client_entitlements, and an internal account is entitled and
--     enforced exactly like a paying one. That is the whole point — it must
--     behave identically for the enforcement it is used to regression-test.
--   * Reversible — see the DOWN block at the end (commented).
-- ============================================================================

begin;

alter table public.clients
  add column if not exists is_internal boolean not null default false;

comment on column public.clients.is_internal is
  'TRUE for internal/test accounts (e.g. sg_canary). Excluded from coach dashboard stats, the private registry and active-client counts. Purely presentational — it does not affect authentication, entitlements or capability enforcement.';

create index if not exists clients_is_internal_idx
  on public.clients (is_internal) where is_internal;

-- The permanent SELF-GUIDED production regression canary.
update public.clients
   set is_internal = true,
       coach_notes = coalesce(nullif(coach_notes, ''),
         'INTERNAL TEST ACCOUNT — permanent SELF-GUIDED production canary. Non-paying. Not a real client. Used to regression-test entitlement grant/revoke/expiry, generic-shell releases and future onboarding. Do not delete; do not count in client numbers.')
 where storage_key = 'sg_canary';

commit;

-- ============================================================================
-- DOWN (run only to reverse this migration)
-- ============================================================================
-- begin;
--   drop index if exists public.clients_is_internal_idx;
--   alter table public.clients drop column if exists is_internal;
-- commit;
