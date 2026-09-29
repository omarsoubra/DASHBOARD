-- ============================================================================
-- LOCKED IN Push Notifications V1 — enable the reminder scheduler
--
-- MANUAL. Run once in the Supabase SQL editor, AFTER migration
-- 20260929120000_push_v1_pilot.sql and after the V1 `push` function is deployed.
--
-- What it does
--   1. enables pg_cron + pg_net (Supabase-provided extensions);
--   2. mints the scheduler secret INSIDE Postgres (pgcrypto) into Vault — no
--      person, script, repo or transcript ever holds it;
--   3. stores only its sha256 in push_internal_auth('cron');
--   4. schedules `pushTick` every 15 minutes (≈ 2,880 invocations / month).
--
-- Idempotent: re-running keeps the existing secret and replaces the job.
-- The tick itself decides nothing by time alone — see handler.ts pushTick.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Scheduler secret, born in the database.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'push_cron_secret',
                                'LOCKED IN push scheduler → push Edge Function (x-push-cron-secret)');
  end if;
end $$;

-- 3. Only the hash is visible to the push function.
insert into public.push_internal_auth (name, secret_sha256)
select 'cron', encode(extensions.digest(decrypted_secret, 'sha256'), 'hex')
  from vault.decrypted_secrets where name = 'push_cron_secret'
on conflict (name) do update set secret_sha256 = excluded.secret_sha256, rotated_at = now();

-- 4. Every 15 minutes. The URL is the public function URL (the project ref is
--    already public in every client shell).
select cron.unschedule(jobid) from cron.job where jobname = 'locked-in-push-tick';
select cron.schedule(
  'locked-in-push-tick',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url     := 'https://cwrrxieahrcustjvpqsk.supabase.co/functions/v1/push',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-push-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret')),
      body    := '{"type":"pushTick"}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);

-- Check
select jobid, jobname, schedule, active from cron.job where jobname = 'locked-in-push-tick';

-- ============================================================================
-- INSPECT
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'locked-in-push-tick')
--    order by start_time desc limit 10;
--   select status_code, left(content::text, 300), created from net._http_response order by created desc limit 10;
--
-- PAUSE (instant, keeps everything):   select cron.unschedule('locked-in-push-tick');
-- REVOKE the scheduler entirely:       delete from public.push_internal_auth where name = 'cron';
-- ============================================================================
