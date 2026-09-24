-- SUBSTITUTION-V1 (2026-09-23)
-- A performance can now be a COACH-APPROVED substitute for the exercise the
-- program prescribed. History must keep BOTH identities: `exercise_name` stays
-- what was actually performed (so progression, Find Load and SET-CORRECTION-V1
-- keep keying on the real movement), and this column records what it stood in
-- for. History is never rewritten to pretend the substitute was the prescription.
--
-- Additive and nullable. NULL means "performed as prescribed", which is every
-- existing row and every write from a shell that does not send the field, so
-- nothing already in the table changes meaning.
alter table public.workout_log_entries
  add column if not exists prescribed_exercise_name text;

comment on column public.workout_log_entries.prescribed_exercise_name is
  'SUBSTITUTION-V1. The exercise the program prescribed, when the client performed a coach-approved substitute instead. NULL = performed as prescribed. exercise_name is always what was actually performed.';

-- Reading "who substituted what, how often" is a coach question about one
-- client over time, so the index matches that shape. Partial: it costs nothing
-- for the overwhelming majority of rows, which are NULL.
create index if not exists workout_log_entries_substituted_idx
  on public.workout_log_entries (client_id, prescribed_exercise_name, logged_at desc)
  where prescribed_exercise_name is not null;
