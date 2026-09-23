-- SET-CORRECTION-V1 (2026-09-23)
-- A stable, client-minted identity for ONE performance (one exercise in one
-- session occurrence). Additive and nullable: every existing row keeps working,
-- every existing reader is untouched, and a shell that does not send one
-- behaves exactly as before.
alter table public.workout_log_entries
  add column if not exists client_ref text;

-- One reference per client. This is what makes a retried write resolve to the
-- row it already created instead of inserting a second history entry, and what
-- lets a correction name the exact row. Partial, so the NULLs of every existing
-- row (and of shells that send no reference) are unconstrained.
create unique index if not exists workout_log_entries_client_ref_uidx
  on public.workout_log_entries (client_id, client_ref)
  where client_ref is not null;
