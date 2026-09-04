-- ============================================================================
-- StrengthByO / LOCKED IN — intake baseline photos
-- Migration: 20260903000000_intake_baseline_photos
--
-- Purpose
--   Make a client's original intake photos their canonical BASELINE inside
--   LOCKED IN, with an explicit coach-approved intake -> client link.
--
-- Properties
--   * Purely ADDITIVE. No column is dropped, renamed, or repurposed.
--   * Every existing row stays valid with no data rewrite (see notes below).
--   * photo_uploads_view_check is NOT touched, weakened, or recreated.
--   * Legacy intakes.photo_*_url (Google Drive) are preserved untouched;
--     new Supabase Storage objects land in the new photo_*_path columns.
--   * Reversible — see the DOWN block at the end of this file (commented).
--
-- Run once, in the Supabase SQL editor, inside the transaction below.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. intakes: Storage paths for NEW intake photos.
--    Legacy Drive URLs keep living in photo_front_url / photo_side_url /
--    photo_back_url. These new columns are Supabase Storage object paths in
--    the PRIVATE client-photos bucket. Never a URL, never public.
-- ---------------------------------------------------------------------------
alter table public.intakes add column if not exists photo_front_path text null;
alter table public.intakes add column if not exists photo_side_path  text null;
alter table public.intakes add column if not exists photo_back_path  text null;

-- ---------------------------------------------------------------------------
-- B. intakes: submission idempotency key.
--    Browser-generated UUID, sent once per submission ATTEMPT and reused on
--    every network retry of that attempt. It is an idempotency token only:
--    it confers no identity, grants no access, and is never used for linkage.
--    The server remains the sole authority over linked_client_id.
--    Partial unique index -> multiple pre-existing NULL rows are fine.
-- ---------------------------------------------------------------------------
alter table public.intakes add column if not exists submission_key uuid null;

create unique index if not exists intakes_submission_key_uniq
  on public.intakes (submission_key)
  where submission_key is not null;

-- ---------------------------------------------------------------------------
-- B2. intakes: photo INGESTION state.
--
--     Deliberately NOT overloaded onto intakes.status. Audit of the whole
--     repo: nothing reads intakes.status; the Edge Function writes 'new' on
--     create and 'linked' on coach link, and every legacy row is 'new'. It is
--     an onboarding/business lifecycle field. Upload transport state is an
--     orthogonal axis -- an intake can legitimately be 'linked' AND have had a
--     photo upload fail -- so mixing them would make one unrepresentable.
--
--     DEFAULT 'complete' is what makes this safe on existing data: every row
--     already in the table finished ingesting (or never had photos), and gets
--     the right value with NO manual backfill.
--
--     ingestion_expected_views records the views the prospect actually
--     selected, so a retry cannot quietly drop one and be called complete.
-- ---------------------------------------------------------------------------
alter table public.intakes
  add column if not exists ingestion_state text not null default 'complete';

alter table public.intakes drop constraint if exists intakes_ingestion_state_check;
alter table public.intakes
  add  constraint intakes_ingestion_state_check
  check (ingestion_state in ('pending', 'complete', 'photo_failed'));

alter table public.intakes
  add column if not exists ingestion_expected_views text[] null;

-- Lets the coach find submissions that never finished ingesting.
create index if not exists intakes_ingestion_state_idx
  on public.intakes (ingestion_state)
  where ingestion_state <> 'complete';

-- ---------------------------------------------------------------------------
-- C. photo_uploads: discriminate intake baselines from weekly check-ins.
--    DEFAULT 'checkin' is what makes this safe on existing data: every row
--    already in the table is a check-in, and gets the correct value with no
--    UPDATE and no table rewrite of semantics.
-- ---------------------------------------------------------------------------
alter table public.photo_uploads
  add column if not exists source text not null default 'checkin';

alter table public.photo_uploads drop constraint if exists photo_uploads_source_check;
alter table public.photo_uploads
  add  constraint photo_uploads_source_check
  check (source in ('checkin', 'intake'));

-- ---------------------------------------------------------------------------
-- D. photo_uploads: canonical link back to the originating intake.
--    ON DELETE RESTRICT — an intake that owns a promoted baseline photo must
--    not be deletable out from under it. There is no competing project
--    convention: the only other FK on this table
--    (photo_uploads_client_id_fkey) declares no action, i.e. NO ACTION, which
--    is also restrictive. RESTRICT is the consistent, stricter choice.
-- ---------------------------------------------------------------------------
alter table public.photo_uploads add column if not exists intake_id uuid null;

alter table public.photo_uploads drop constraint if exists photo_uploads_intake_id_fkey;
alter table public.photo_uploads
  add  constraint photo_uploads_intake_id_fkey
  foreign key (intake_id) references public.intakes(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- E. photo_uploads: source/intake_id consistency.
--    A check-in row must carry no intake; an intake row must carry one.
--    Existing rows satisfy this automatically (source='checkin', intake_id NULL).
-- ---------------------------------------------------------------------------
alter table public.photo_uploads drop constraint if exists photo_uploads_source_intake_check;
alter table public.photo_uploads
  add  constraint photo_uploads_source_intake_check
  check (
    (source = 'checkin' and intake_id is null)
    or
    (source = 'intake'  and intake_id is not null)
  );

-- ---------------------------------------------------------------------------
-- E2. photo_uploads: an intake baseline MUST name its view.
--
--     photo_uploads.view is nullable, and in PostgreSQL two NULLs are never
--     equal -- so a partial unique index on (intake_id, view) would happily
--     admit any number of source='intake' rows with view IS NULL. That NULL
--     hole would defeat the whole idempotency guarantee in F below.
--
--     Scoped deliberately to source='intake'. The column stays globally
--     nullable and check-in rows keep their existing semantics untouched;
--     photo_uploads_view_check remains the sole authority on which view
--     VALUES are legal, and is not touched here.
-- ---------------------------------------------------------------------------
alter table public.photo_uploads drop constraint if exists photo_uploads_intake_view_required_check;
alter table public.photo_uploads
  add  constraint photo_uploads_intake_view_required_check
  check (source <> 'intake' or view is not null);

-- ---------------------------------------------------------------------------
-- F. photo_uploads: promotion idempotency.
--    One row per (intake, view). Re-running promotion can never create a
--    second BASELINE card for the same intake and view.
--    Partial (source='intake') so weekly check-in rows are never constrained
--    -- they legitimately repeat (client, week, view) today.
--    E2 above closes the NULL hole, so this index is a real guard rather than
--    one that silently lets NULL-view duplicates through.
-- ---------------------------------------------------------------------------
create unique index if not exists photo_uploads_intake_view_uniq
  on public.photo_uploads (intake_id, view)
  where source = 'intake';

-- ---------------------------------------------------------------------------
-- G. Read-path index. photosGet filters by client_key and orders by
--    uploaded_at; baseline selection additionally reads source.
-- ---------------------------------------------------------------------------
create index if not exists photo_uploads_client_key_uploaded_idx
  on public.photo_uploads (client_key, uploaded_at);

commit;

-- ============================================================================
-- DOWN (rollback) — run only if the migration must be reversed.
-- Dropping the columns discards any promoted baseline rows' linkage, so
-- delete promoted rows first if you want a clean revert.
-- ============================================================================
-- begin;
--   delete from public.photo_uploads where source = 'intake';
--   drop index  if exists public.photo_uploads_intake_view_uniq;
--   drop index  if exists public.photo_uploads_client_key_uploaded_idx;
--   alter table public.photo_uploads drop constraint if exists photo_uploads_intake_view_required_check;
--   alter table public.photo_uploads drop constraint if exists photo_uploads_source_intake_check;
--   alter table public.photo_uploads drop constraint if exists photo_uploads_intake_id_fkey;
--   alter table public.photo_uploads drop constraint if exists photo_uploads_source_check;
--   alter table public.photo_uploads drop column if exists intake_id;
--   alter table public.photo_uploads drop column if exists source;
--   drop index  if exists public.intakes_ingestion_state_idx;
--   alter table public.intakes drop constraint if exists intakes_ingestion_state_check;
--   alter table public.intakes drop column if exists ingestion_expected_views;
--   alter table public.intakes drop column if exists ingestion_state;
--   drop index  if exists public.intakes_submission_key_uniq;
--   alter table public.intakes drop column if exists submission_key;
--   alter table public.intakes drop column if exists photo_back_path;
--   alter table public.intakes drop column if exists photo_side_path;
--   alter table public.intakes drop column if exists photo_front_path;
-- commit;
