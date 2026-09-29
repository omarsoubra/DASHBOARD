// ============================================================================
// LOCKED IN Notifications V2 — adherence observation map (pure, no I/O)
//
// Which client behaviours LOCKED IN can actually observe, and how reliably.
// Grounded in the production schema and data inspected 2026-09-29 (see
// docs/PUSH_NOTIFICATIONS_V2.md). A reminder may only be built on a RELIABLE
// signal. This module is deliberately NOT imported by the push handler: no
// workout, nutrition or weigh-in reminder exists, and this file is the gate
// that explains why.
// ============================================================================

export type Reliability = 'reliable' | 'partial' | 'unavailable';

export const SIGNALS: Record<string, { reliability: Reliability; source: string; why: string }> = {
  weekly_checkin: {
    reliability: 'reliable', source: 'check_ins.submitted_at',
    why: 'One row per submitted check-in, written by the api from the verified client token; ' +
         'timestamp is the submitting device clock (0 future-dated rows in production).',
  },
  workout_session: {
    reliability: 'partial', source: 'workout_log_entries (one row per logged exercise)',
    why: 'Logging is optional and per exercise; there is no session-completed marker, no weekday schedule ' +
         '(programmes are sequential "Day 1..N", some days optional). A logged row proves training happened; ' +
         'the absence of rows does NOT prove a missed session.',
  },
  nutrition: {
    reliability: 'partial', source: 'meal_logs; check_ins.diet_adherence_1to10',
    why: 'meal_logs carries no plan link (no week/day/meal index) and "undo" writes a new row; the check-in ' +
         'adherence score is weekly self-report. Neither proves the prescription was or was not followed.',
  },
  daily_weight: {
    reliability: 'unavailable', source: 'weight_logs',
    why: '1:1 shells have no daily weigh-in workflow; weights arrive mainly with the weekly check-in.',
  },
  app_open: {
    reliability: 'unavailable', source: 'none',
    why: 'Not recorded, and never a proxy for adherence.',
  },
};

// ── workout observation ─────────────────────────────────────────────────────
// Input is what a future caller could assemble from the programme + logs.
export type WorkoutProgramme = {
  /** Explicit weekday per session (0=Sun..6), or null for sequential/flexible programmes. */
  sessionWeekdays: Array<number | null>;
  /** Sessions that are optional (e.g. "Day 6 — OPTIONAL"). */
  optional?: boolean[];
};
export type WorkoutLog = { dayIndex: number | null; localDate: string | null; sessionComplete?: boolean };

export type WorkoutObservation =
  | { canInferMissed: false; reason: 'flexible_schedule' | 'no_completion_data' | 'no_session_marker' |
      'expected_session_unknown' | 'session_moved' | 'optional_session' }
  | { canInferMissed: true; expectedDayIndex: number; completed: boolean };

/**
 * Could we PROVE whether the session expected on `localDate` was done?
 * Refuses (canInferMissed=false) whenever the answer would be a guess.
 * With today's production data every path refuses: programmes carry no
 * weekdays and logs carry no session-complete marker.
 */
export function observeWorkout(prog: WorkoutProgramme | null, logs: WorkoutLog[] | null,
                               localDate: string, dow: number): WorkoutObservation {
  if (!prog || !Array.isArray(prog.sessionWeekdays) || !prog.sessionWeekdays.length) return { canInferMissed: false, reason: 'expected_session_unknown' };
  if (prog.sessionWeekdays.some((d) => d === null)) return { canInferMissed: false, reason: 'flexible_schedule' };
  const expected = prog.sessionWeekdays.indexOf(dow);
  if (expected < 0) return { canInferMissed: false, reason: 'expected_session_unknown' };
  if (prog.sessionWeekdays.indexOf(dow, expected + 1) >= 0) return { canInferMissed: false, reason: 'expected_session_unknown' };
  if (prog.optional?.[expected]) return { canInferMissed: false, reason: 'optional_session' };
  if (!logs) return { canInferMissed: false, reason: 'no_completion_data' };
  const valid = logs.filter((l) => l && l.dayIndex !== null && l.localDate);
  if (!valid.length) return { canInferMissed: false, reason: 'no_completion_data' };
  if (valid.some((l) => l.sessionComplete === undefined)) return { canInferMissed: false, reason: 'no_session_marker' };
  const sameSessionElsewhere = valid.some((l) => l.dayIndex === expected && l.localDate !== localDate);
  if (sameSessionElsewhere) return { canInferMissed: false, reason: 'session_moved' };
  const done = valid.some((l) => l.dayIndex === expected && l.localDate === localDate && l.sessionComplete === true);
  return { canInferMissed: true, expectedDayIndex: expected, completed: done };
}
