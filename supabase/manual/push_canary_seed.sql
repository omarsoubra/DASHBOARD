-- ============================================================================
-- LOCKED IN Push Notifications — create the internal `_push_canary` client
--
-- MANUAL. Run once in the Supabase SQL editor, AFTER
-- supabase/migrations/20260928120000_push_notifications_proof.sql.
-- This folder is not a migrations folder: `supabase db push` never runs it.
--
-- Creates ONE internal, non-paying row (profile + client) used only by the
-- push canary shell. Touches no existing row. Idempotent: a second run does
-- nothing. No token is created here — issue it with
-- scripts/push/issue_canary_link.mjs (calls the existing issueClientToken).
--
-- is_internal = true keeps it out of the coach dashboard stats, the private
-- registry and client counts (migration 20260909120000). The leading
-- underscore keeps it out of clients_registry.json.
-- ============================================================================

begin;

do $$
declare
  pid uuid;
  has_internal boolean;
begin
  if exists (select 1 from public.clients where storage_key = '_push_canary') then
    raise notice '_push_canary already exists — nothing to do';
    return;
  end if;

  insert into public.profiles (role, full_name)
  values ('client', 'LOCKED IN Push Canary (internal)')
  returning id into pid;

  insert into public.clients (profile_id, storage_key, display_name)
  values (pid, '_push_canary', 'LOCKED IN Push Canary (internal)');

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'clients' and column_name = 'is_internal'
  ) into has_internal;

  if has_internal then
    execute $q$update public.clients set is_internal = true where storage_key = '_push_canary'$q$;
  else
    raise warning 'clients.is_internal is missing — _push_canary will show in dashboard stats until migration 20260909120000 is applied';
  end if;
end $$;

commit;

select id, storage_key, display_name from public.clients where storage_key = '_push_canary';

-- ============================================================================
-- ROLLBACK (manual)
--   Soft (preferred — instant, reversible): stop all canary access and pushes
--     update public.client_sessions set access_status = 'revoked' where storage_key = '_push_canary';
--   Hard (removes the canary entirely; cascades to its push rows + session):
--     delete from public.profiles where id = (select profile_id from public.clients where storage_key = '_push_canary');
-- ============================================================================
