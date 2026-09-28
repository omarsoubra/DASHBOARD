// ============================================================================
// LOCKED IN Push Notifications — Supabase Edge Function `push` (minimal proof)
//
// Thin Deno entry point. All logic lives in handler.ts / webpush.ts so the
// exact same source is exercised by tests/push_proof.test.js.
//
// Secrets read here (Supabase project secrets — never in the repo):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (injected by Supabase)
//   COACH_PASSWORD_HASH                        (already set for `api`)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//   PUSH_ALLOWED_CLIENTS                       (proof: "_push_canary")
//
// Deploy: .github/workflows/deploy-edge-push.yml (manual, type DEPLOY).
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { makePushHandler, readPushEnv } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(makePushHandler({ admin, env: readPushEnv((k) => Deno.env.get(k)) }));
