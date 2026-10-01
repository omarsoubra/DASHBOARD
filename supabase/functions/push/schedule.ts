// ============================================================================
// LOCKED IN Push Notifications V1 — scheduling rules (pure, no I/O)
//
// Everything here is a function of (preferences, now). No database, no network,
// so every rule is deterministic and unit-tested in tests/push_v1.test.js,
// including DST boundaries, UTC clients and windows that cross midnight.
//
// Philosophy: a timer firing is never a reason to send. These functions only
// answer "is this reminder's window open right now, and for which period?".
// The handler then checks the client's real state before anything is sent.
// ============================================================================

export const WINDOW_MINUTES = 60;          // a reminder may go out up to 60 min after its time
export const MINUTES_PER_DAY = 1440;

export type LocalParts = { date: string; dow: number; minuteOfDay: number };

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock date, weekday and minute-of-day of an instant in a timezone. */
export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  const hh = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DOW[p.weekday], minuteOfDay: hh * 60 + Number(p.minute) };
}

/** 'YYYY-MM-DD' ± n days (calendar arithmetic, timezone-free). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** UTC instant of a wall-clock time in a timezone (DST-correct; iterates on the offset). */
export function zonedTimeToUtc(date: string, minuteOfDay: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = want;
  for (let i = 0; i < 3; i++) {                     // bounded: offsets converge in ≤ 2 steps
    const p = localParts(guess, tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    const got = Date.UTC(py, pm - 1, pd, Math.floor(p.minuteOfDay / 60), p.minuteOfDay % 60);
    if (got === want) break;
    guess -= got - want;
  }
  return guess;
}

/** [start, end) UTC instants of a local calendar day. 23 h / 25 h on DST change days. */
export function localDayBounds(date: string, tz: string): { start: number; end: number } {
  return { start: zonedTimeToUtc(date, 0, tz), end: zonedTimeToUtc(addDays(date, 1), 0, tz) };
}

/** 'HH:MM' or 'HH:MM:SS' (Postgres time) → minute of day, or null. */
export function parseTime(t: unknown): number | null {
  if (typeof t !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTime(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
}

/** Quiet hours may wrap midnight (21:00–07:00). start === end means "no quiet hours". */
export function inQuietHours(minuteOfDay: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return minuteOfDay >= quietStart && minuteOfDay < quietEnd;
  return minuteOfDay >= quietStart || minuteOfDay < quietEnd;
}

/**
 * Is `now` inside [target, target + WINDOW) for some local day? Returns the
 * local date the window BELONGS to (a 23:30 reminder whose window runs to
 * 00:30 belongs to the day it started on).
 */
export function windowDate(now: LocalParts, target: number): string | null {
  const end = target + WINDOW_MINUTES;
  if (now.minuteOfDay >= target && now.minuteOfDay < Math.min(end, MINUTES_PER_DAY)) return now.date;
  if (end > MINUTES_PER_DAY && now.minuteOfDay < end - MINUTES_PER_DAY) return addDays(now.date, -1);
  return null;
}

/** Next instant (strictly after now) at which the local clock reads `minuteOfDay`. */
export function nextLocalTime(nowMs: number, minuteOfDay: number, tz: string): number {
  const today = localParts(nowMs, tz).date;
  const t = zonedTimeToUtc(today, minuteOfDay, tz);
  return t > nowMs ? t : zonedTimeToUtc(addDays(today, 1), minuteOfDay, tz);
}

function dowOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export type Prefs = {
  notifications_enabled: boolean;
  timezone: string | null;
  weighin_available: boolean;
  weighin_enabled: boolean;
  weighin_time: string;
  checkin_enabled: boolean;
  checkin_dow: number;
  checkin_time: string;
  program_updates_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
};

export type Evaluation =
  | { due: false }
  | { due: true; periodKey: string; eligibleAt: number; suppress?: 'disabled' | 'quiet_hours' | 'no_timezone';
      /** weigh-in: the local day to search for a weight; check-in: the window to search for a completed check-in */
      stateFrom: number; stateTo: number };

/**
 * MORNING WEIGH-IN. Not due unless the client's app supports daily weight
 * logging (coach-owned weighin_available) and `now` is in the reminder window.
 * Inside the window, preference/quiet-hour suppressions are reported so they
 * are recorded once for the day.
 */
export function evaluateWeighin(p: Prefs, nowMs: number): Evaluation {
  if (!p.weighin_available) return { due: false };
  if (!isValidTimezone(p.timezone)) return { due: false };
  const target = parseTime(p.weighin_time);
  if (target === null) return { due: false };
  const now = localParts(nowMs, p.timezone);
  const day = windowDate(now, target);
  if (!day) return { due: false };
  const { start, end } = localDayBounds(day, p.timezone);
  const ev = { due: true as const, periodKey: day, eligibleAt: zonedTimeToUtc(day, target, p.timezone), stateFrom: start, stateTo: end };
  if (!p.notifications_enabled || !p.weighin_enabled) return { ...ev, suppress: 'disabled' };
  if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) return { ...ev, suppress: 'quiet_hours' };
  return ev;
}

/**
 * WEEKLY CHECK-IN. Due only inside the reminder window on the client's
 * check-in weekday. The period is that due date; a check-in submitted from the
 * start of (due date − 6 days) onward counts as completed — the same "≥ 6 days
 * since the last check-in" rule the client shells use for their banner.
 */
export function evaluateCheckin(p: Prefs, nowMs: number, programStartDate?: string | null): Evaluation {
  if (!isValidTimezone(p.timezone)) return { due: false };
  const target = parseTime(p.checkin_time);
  if (target === null) return { due: false };
  const now = localParts(nowMs, p.timezone);
  const day = windowDate(now, target);
  if (!day || dowOf(day) !== p.checkin_dow) return { due: false };
  // First check-in: not due until the programme has run ≥ 6 days (shell rule).
  if (programStartDate && /^\d{4}-\d{2}-\d{2}$/.test(programStartDate) && programStartDate > addDays(day, -6)) return { due: false };
  const ev = {
    due: true as const, periodKey: day, eligibleAt: zonedTimeToUtc(day, target, p.timezone),
    stateFrom: localDayBounds(addDays(day, -6), p.timezone).start, stateTo: nowMs,
  };
  if (!p.notifications_enabled || !p.checkin_enabled) return { ...ev, suppress: 'disabled' };
  if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) return { ...ev, suppress: 'quiet_hours' };
  return ev;
}

// ============================================================================
// V2 — WEEKLY CHECK-IN ADHERENCE SEQUENCE
//
// One check-in period per due date D (the client's check-in weekday, local).
// Up to three stages, each sent ONLY if the check-in is still incomplete when
// that stage is evaluated:
//
//   due       D   at checkin_time            (default Sunday 09:00)
//   followup  D   at checkin_followup_time   (default Sunday 18:00)
//   final     D+1 at checkin_final_time      (default Monday 10:00)
//
// Stage times are wall-clock minutes from local midnight of D, so DST days and
// timezone changes never move a stage into another period. Stages must be
// strictly increasing with >= STAGE_MIN_GAP between them; a stage that is not
// (e.g. a client-chosen 19:00 check-in time after the 18:00 follow-up) is
// dropped — never reordered. Each stage's window closes at the earlier of
// +WINDOW_MINUTES or the next stage's time, so at most ONE stage is open at any
// instant: a scheduler outage can never release a burst of stages at recovery.
//
// PERIODS. Every instant belongs to exactly ONE check-in period: the one whose
// due date D is nearest in local calendar days — [start of D-3, start of D+4).
// For a Sunday due date that is Thursday 00:00 → Wednesday 24:00: a Thu–Sat
// submission is an early check-in for the coming Sunday, a Sun–Wed submission
// is the (on-time or late) check-in for that Sunday. A submission can therefore
// satisfy only one period, and a Monday-late check-in for last week can never
// complete this week. (Deliberately NOT the shells' rolling "within 6 days"
// banner rule, which lets last Monday's late check-in suppress this Sunday.)
// Completion of period D = any check-in in [periodStart(D), now].
// There is no canonical period id in the data: check_ins.week_number is typed
// by the client (placeholder-only autofill, capped at 12), so it is not used.
// ============================================================================

export const PERIOD_DAYS_BEFORE = 3;   // D-3 .. D+3 → 7 local days, disjoint, contiguous

/** [start, end) instants of check-in period D in `tz` (local-day aligned, DST-correct). */
export function checkinPeriodBounds(D: string, tz: string): { start: number; end: number } {
  return {
    start: localDayBounds(addDays(D, -PERIOD_DAYS_BEFORE), tz).start,
    end: localDayBounds(addDays(D, 7 - PERIOD_DAYS_BEFORE), tz).start,
  };
}

/** The check-in period (due date D) a submission instant belongs to, for weekday `dow` in `tz`. */
export function checkinPeriodOf(ms: number, tz: string, dow: number): string {
  const local = localParts(ms, tz).date;
  for (let k = -PERIOD_DAYS_BEFORE; k <= 6 - PERIOD_DAYS_BEFORE; k++) {
    const D = addDays(local, k);          // D is k days after the submission's local date
    if (dowOf(D) === dow) return D;
  }
  throw new Error('unreachable: every 7-day span contains the weekday');
}

export const STAGE_MIN_GAP = 15;
export type CheckinStage = 'due' | 'followup' | 'final';

export type SequencePrefs = Prefs & {
  checkin_followup_time?: string | null;
  checkin_final_time?: string | null;
  checkin_final_day_offset?: number | null;
};

/** Stage schedule for one period, minutes from local midnight of D. Invalid stages dropped. */
export function checkinStages(p: SequencePrefs): Array<{ stage: CheckinStage; at: number }> {
  const due = parseTime(p.checkin_time);
  if (due === null) return [];
  const out: Array<{ stage: CheckinStage; at: number }> = [{ stage: 'due', at: due }];
  const fu = parseTime(p.checkin_followup_time ?? '18:00');
  if (fu !== null && fu >= due + STAGE_MIN_GAP) out.push({ stage: 'followup', at: fu });
  const off = p.checkin_final_day_offset ?? 1;
  const fin = parseTime(p.checkin_final_time ?? '10:00');
  if (fin !== null && (off === 0 || off === 1)) {
    const at = off * MINUTES_PER_DAY + fin;
    if (at >= out[out.length - 1].at + STAGE_MIN_GAP) out.push({ stage: 'final', at });
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export type StageEvaluation =
  | { due: false }
  | { due: true; stage: CheckinStage; periodKey: string; eligibleAt: number;
      suppress?: 'disabled' | 'quiet_hours'; stateFrom: number; stateTo: number };

/**
 * Which check-in stage (if any) is open at `now`. Pure. Reports preference and
 * quiet-hour suppressions so they are recorded once per stage; everything else
 * (eligibility, device, completion) is the handler's job, against live state.
 */
export function evaluateCheckinStage(p: SequencePrefs, nowMs: number, programStartDate?: string | null): StageEvaluation {
  if (!isValidTimezone(p.timezone)) return { due: false };
  const stages = checkinStages(p);
  if (!stages.length) return { due: false };
  const now = localParts(nowMs, p.timezone);
  // D is at most 2 local days back (final stage on D+1, window may cross midnight).
  for (let back = 0; back <= 2; back++) {
    const D = addDays(now.date, -back);
    if (dowOf(D) !== p.checkin_dow) continue;
    const rel = daysBetween(D, now.date) * MINUTES_PER_DAY + now.minuteOfDay;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const end = Math.min(s.at + WINDOW_MINUTES, i + 1 < stages.length ? stages[i + 1].at : Infinity);
      if (rel < s.at || rel >= end) continue;
      if (programStartDate && /^\d{4}-\d{2}-\d{2}$/.test(programStartDate) && programStartDate > addDays(D, -6)) return { due: false };
      const stageDate = addDays(D, Math.floor(s.at / MINUTES_PER_DAY));
      const ev = {
        due: true as const, stage: s.stage, periodKey: D,
        eligibleAt: zonedTimeToUtc(stageDate, s.at % MINUTES_PER_DAY, p.timezone),
        stateFrom: checkinPeriodBounds(D, p.timezone).start,
        stateTo: Math.min(nowMs, checkinPeriodBounds(D, p.timezone).end - 1),
      };
      if (!p.notifications_enabled || !p.checkin_enabled) return { ...ev, suppress: 'disabled' };
      if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) return { ...ev, suppress: 'quiet_hours' };
      return ev;
    }
  }
  return { due: false };
}

// ============================================================================
// V2 — ADHERENCE DECISION (the one pattern every adherence reminder follows)
//
//   observation → due? → already completed? → eligible? → enabled?
//               → quiet hours? → device? → dedupe (the claim) → send
//
// Default is SILENCE: `send` is true only when every question has a positive
// answer. An unknown observation is never treated as "incomplete".
// ============================================================================
export type Observation = 'completed' | 'incomplete' | 'unknown';
export type Decision = { send: true } | { send: false; record: boolean; reason: string | null };

export function decideReminder(i: {
  due: boolean; observation: Observation; eligible: boolean; active: boolean;
  enabled: boolean; quiet: boolean; hasDevice: boolean;
}): Decision {
  if (!i.due) return { send: false, record: false, reason: null };
  if (i.observation === 'unknown') return { send: false, record: false, reason: 'state_unknown' };  // retry next tick
  if (!i.eligible) return { send: false, record: false, reason: 'not_eligible' };                  // never recorded
  if (i.observation === 'completed') return { send: false, record: true, reason: 'already_completed' };
  if (!i.active) return { send: false, record: true, reason: 'inactive_client' };
  if (!i.enabled) return { send: false, record: true, reason: 'disabled' };
  if (i.quiet) return { send: false, record: true, reason: 'quiet_hours' };
  if (!i.hasDevice) return { send: false, record: true, reason: 'no_active_device' };
  return { send: true };
}

// ============================================================================
// DAILY REMINDERS V1 — TRAINING + MEALS (pure)
//
// Everything a client is reminded about here was CHOSEN BY THE CLIENT: their
// training weekdays and time, an optional follow-up time, and one reminder time
// per ordinal meal slot. Nothing is derived from the programme, the meal names,
// the printed meal times or the intake notes.
//
//   training  primary   at training_time on a selected weekday
//             followup  at training_followup_time (optional, >= 60 min later)
//             Both are suppressed by an explicit Finish Workout during that local
//             day (the handler's observation). A training reminder means "you
//             said you train today" — never "you are due session X".
//   meals     slot k    at meal_times[k-1], every day. Schedule only: there is
//             no meal-completion signal, so nothing here observes eating.
//
// Windows are [time, time + WINDOW) clipped to the next stage/slot and to the
// end of the local day, so every event belongs to exactly one local date D and
// at most one training stage and one meal slot are open at any instant.
// A wall-clock time inside a spring-forward gap opens when the clock jumps past
// it; a repeated fall-back hour is collapsed by the per-date dedupe key.
// ============================================================================

export const FOLLOWUP_MIN_GAP = 60;
export const MAX_MEAL_SLOTS = 8;
export const DAILY_CAP = 10;            // automatic training + meal pushes per client per local day

export type DailyPrefs = Prefs & {
  training_enabled?: boolean | null;
  training_days?: number | null;
  training_time?: string | null;
  training_followup_enabled?: boolean | null;
  training_followup_time?: string | null;
  meals_enabled?: boolean | null;
  meal_times?: Array<string | null> | null;
};

export type PlanFacts = {
  meal_facts_status: string;
  meal_slot_count: number | null;
  has_workout_completion: boolean;
} | null;

export type TrainingStage = 'primary' | 'followup';

/** Is weekday `dow` (0 = Sunday) selected in the client's bitmask? */
export function trainingDaySelected(mask: unknown, dow: number): boolean {
  return Number.isInteger(mask) && (mask as number) > 0 && (((mask as number) >> dow) & 1) === 1;
}

/** Window [at, min(at + WINDOW, nextAt, end of day)) on the local clock. */
function inDayWindow(minuteOfDay: number, at: number, nextAt: number | null): boolean {
  const end = Math.min(at + WINDOW_MINUTES, nextAt ?? Infinity, MINUTES_PER_DAY);
  return minuteOfDay >= at && minuteOfDay < end;
}

/** The client's training schedule, or null when it is off or incomplete. An invalid follow-up is dropped. */
export function trainingSchedule(p: DailyPrefs): { primary: number; followup: number | null } | null {
  if (p.training_enabled !== true) return null;
  const primary = parseTime(p.training_time);
  if (primary === null || !Number.isInteger(p.training_days) || (p.training_days as number) <= 0) return null;
  let followup = p.training_followup_enabled === true ? parseTime(p.training_followup_time) : null;
  if (followup !== null && followup < primary + FOLLOWUP_MIN_GAP) followup = null;
  return { primary, followup };
}

export type TrainingEvaluation =
  | { due: false }
  | { due: true; stage: TrainingStage; periodKey: string; eligibleAt: number;
      /** [start, end) of local day D — the only span in which a completion counts */
      dayFrom: number; dayTo: number;
      suppress?: 'disabled' | 'unsupported_workout_completion' | 'quiet_hours' };

/**
 * Which training stage (if any) is open at `now`. Pure. Reports the suppressions
 * that need no live state (master switch, no Finish Workout on the served shell,
 * quiet hours); completion, eligibility and devices are the handler's job.
 */
export function evaluateTrainingStage(p: DailyPrefs, nowMs: number, facts: PlanFacts): TrainingEvaluation {
  if (!isValidTimezone(p.timezone)) return { due: false };
  const s = trainingSchedule(p);
  if (!s) return { due: false };
  const now = localParts(nowMs, p.timezone);
  if (!trainingDaySelected(p.training_days, now.dow)) return { due: false };
  let stage: TrainingStage, at: number;
  if (inDayWindow(now.minuteOfDay, s.primary, s.followup)) { stage = 'primary'; at = s.primary; }
  else if (s.followup !== null && inDayWindow(now.minuteOfDay, s.followup, null)) { stage = 'followup'; at = s.followup; }
  else return { due: false };
  const D = now.date;
  const { start, end } = localDayBounds(D, p.timezone);
  const ev = { due: true as const, stage, periodKey: D, eligibleAt: zonedTimeToUtc(D, at, p.timezone), dayFrom: start, dayTo: end };
  if (!p.notifications_enabled) return { ...ev, suppress: 'disabled' };
  if (facts?.has_workout_completion !== true) return { ...ev, suppress: 'unsupported_workout_completion' };
  if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) return { ...ev, suppress: 'quiet_hours' };
  return ev;
}

/** Configured meal slots (1-based), in order. A slot that is not strictly later than the previous one is dropped, never reordered. */
export function mealSlotTimes(p: DailyPrefs): Array<{ slot: number; at: number }> {
  if (p.meals_enabled !== true || !Array.isArray(p.meal_times)) return [];
  const out: Array<{ slot: number; at: number }> = [];
  p.meal_times.slice(0, MAX_MEAL_SLOTS).forEach((t, i) => {
    const at = parseTime(t);
    if (at === null) return;
    if (out.length && at <= out[out.length - 1].at) return;
    out.push({ slot: i + 1, at });
  });
  return out;
}

/** Meal reminders exist only for a plan whose served feed count is one consistent N. */
export function mealsAvailable(facts: PlanFacts): boolean {
  return !!facts && facts.meal_facts_status === 'consistent' && Number.isInteger(facts.meal_slot_count) &&
    (facts.meal_slot_count as number) >= 1 && (facts.meal_slot_count as number) <= MAX_MEAL_SLOTS;
}

export type MealSlotEvaluation = {
  slot: number; periodKey: string; eligibleAt: number;
  suppress?: 'no_current_meal_slot' | 'disabled' | 'quiet_hours';
};

/** Meal slots whose window is open at `now` (at most one). Pure; never looks at eating. */
export function evaluateMealSlots(p: DailyPrefs, nowMs: number, facts: PlanFacts): MealSlotEvaluation[] {
  if (!isValidTimezone(p.timezone) || !mealsAvailable(facts)) return [];
  const slots = mealSlotTimes(p);
  const now = localParts(nowMs, p.timezone);
  const out: MealSlotEvaluation[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!inDayWindow(now.minuteOfDay, s.at, i + 1 < slots.length ? slots[i + 1].at : null)) continue;
    const ev = { slot: s.slot, periodKey: now.date, eligibleAt: zonedTimeToUtc(now.date, s.at, p.timezone) };
    if (s.slot > (facts as { meal_slot_count: number }).meal_slot_count) out.push({ ...ev, suppress: 'no_current_meal_slot' });
    else if (!p.notifications_enabled) out.push({ ...ev, suppress: 'disabled' });
    else if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) out.push({ ...ev, suppress: 'quiet_hours' });
    else out.push(ev);
  }
  return out;
}

/** decideReminder for a pure schedule reminder: there is no observation, so "completed" can never be claimed. */
export function decideScheduled(i: { due: boolean; eligible: boolean; active: boolean; enabled: boolean; quiet: boolean; hasDevice: boolean }): Decision {
  return decideReminder({ ...i, observation: 'incomplete' });
}

// ── diagnostics (coachPushExplain): what local day D looks like, no live state ─
export type DailyPlanView = {
  training: { status: 'disabled' | 'no_configured_day_time' | 'not_training_day' | 'unsupported_workout_completion' | 'scheduled';
              stages: Array<{ stage: TrainingStage; time: string; at: number }> };
  meals: { status: 'disabled' | 'no_plan_facts' | 'variable_feed_count' | 'no_configured_time' | 'scheduled';
           slotCount: number | null; slots: Array<{ slot: number; time: string; at: number; stale: boolean }> };
};

export function dailyPlan(p: DailyPrefs, facts: PlanFacts, D: string, factsKnown: boolean): DailyPlanView {
  const tz = isValidTimezone(p.timezone) ? p.timezone : null;
  const inst = (m: number) => (tz ? zonedTimeToUtc(D, m, tz) : NaN);
  const training: DailyPlanView['training'] = { status: 'scheduled', stages: [] };
  const s = trainingSchedule(p);
  if (p.training_enabled !== true) training.status = 'disabled';
  else if (!s) training.status = 'no_configured_day_time';
  else if (!trainingDaySelected(p.training_days, dowOf(D))) training.status = 'not_training_day';
  else {
    if (facts?.has_workout_completion !== true) training.status = 'unsupported_workout_completion';
    training.stages.push({ stage: 'primary', time: formatTime(s.primary), at: inst(s.primary) });
    if (s.followup !== null) training.stages.push({ stage: 'followup', time: formatTime(s.followup), at: inst(s.followup) });
  }
  const meals: DailyPlanView['meals'] = { status: 'scheduled', slotCount: facts?.meal_slot_count ?? null, slots: [] };
  if (!factsKnown || !facts) meals.status = 'no_plan_facts';
  else if (!mealsAvailable(facts)) meals.status = 'variable_feed_count';
  else if (p.meals_enabled !== true) meals.status = 'disabled';
  if (meals.status === 'scheduled') {
    const slots = mealSlotTimes(p);
    if (!slots.length) meals.status = 'no_configured_time';
    for (const x of slots) meals.slots.push({ slot: x.slot, time: formatTime(x.at), at: inst(x.at), stale: x.slot > (facts!.meal_slot_count as number) });
  }
  return { training, meals };
}
