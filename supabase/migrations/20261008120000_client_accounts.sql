-- ============================================================================
-- LOCKED IN — client accounts V1 (email + password, invitation-only)
--
-- Identity: Supabase Auth (auth.users). Each client's existing profile row
-- (profiles.auth_user_id, already present and empty) is linked to exactly one
-- auth user when the client accepts the invite Omar issued FOR THAT CLIENT —
-- so the account-to-data match is never guessed.
--
--   client_invites        single-use, time-limited links Omar copies from his
--                         dashboard and sends himself (no email is sent).
--                         purpose 'invite' = create the account (7 days);
--                         'reset' = set a new password (24 h). Only sha256 of
--                         the token is stored. Issuing a new link of the same
--                         purpose revokes the previous open one.
--   client_device_tokens  per-device access keys minted after a successful
--                         login. They are accepted by verifyClientToken exactly
--                         like the legacy single link token, so existing client
--                         pages work unchanged; each device has its own key,
--                         expiry and revocation. Only sha256 is stored.
--
-- Service-role only (RLS on, no policies, anon/authenticated revoked).
-- ============================================================================
begin;

create table if not exists public.client_invites (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  storage_key   text not null,
  purpose       text not null check (purpose in ('invite', 'reset')),
  token_hash    text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_by    text not null default 'coach' check (created_by in ('coach', 'system')),
  constraint client_invites_token_hash_key unique (token_hash),
  constraint client_invites_single_outcome check (used_at is null or revoked_at is null)
);
create index if not exists client_invites_client_idx on public.client_invites (client_id, created_at desc);

create table if not exists public.client_device_tokens (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  storage_key   text not null,
  auth_user_id  uuid not null,
  token_hash    text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  device_label  text check (device_label is null or char_length(device_label) <= 80),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in ('logout', 'deactivated', 'superseded', 'password_reset', 'coach')),
  constraint client_device_tokens_token_hash_key unique (token_hash)
);
create index if not exists client_device_tokens_active_idx
  on public.client_device_tokens (storage_key) where revoked_at is null;

-- One auth account per client profile, one profile per auth account.
create unique index if not exists profiles_auth_user_id_uniq
  on public.profiles (auth_user_id) where auth_user_id is not null;

alter table public.client_invites       enable row level security;
alter table public.client_device_tokens enable row level security;
revoke all on public.client_invites       from anon, authenticated;
revoke all on public.client_device_tokens from anon, authenticated;

comment on table public.client_invites is
  'LOCKED IN client accounts: single-use invite / password-reset links (sha256 only). Omar copies them from his dashboard; no email is sent. Service-role only.';
comment on table public.client_device_tokens is
  'LOCKED IN client accounts: per-device access keys minted after login (sha256 only); accepted by verifyClientToken; revoked on logout, deactivation or password reset. Service-role only.';

commit;
