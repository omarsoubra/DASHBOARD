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
// DAILY REMINDERS V1 — PLAN-SYNCED TRAINING + MEALS (pure)
//
// The APPROVED COACHING PLAN owns the schedule. It is authored as
// `schedule` (locked-in.schedule.v1) in the client's prescription / config,
// compiled into the served shell as `const LI_SCHEDULE = {...};`, read from the
// verified-live bytes by planFactsSync and stored in push_plan_facts. The client
// only chooses ON/OFF per category (push_preferences.training_enabled /
// meals_enabled); it never edits a day or a time.
//
// TIMEZONE — ONE runtime authority. Schedule times are LOCAL WALL-CLOCK times
// with NO timezone of their own (the schema rejects a timezone key). They are
// always evaluated in push_preferences.timezone, the client's current device
// timezone captured at opt-in and correctable by the client. "18:30" therefore
// means 18:30 where the client's phone is set; nothing can pair a Sydney plan
// with a Bali device and fire at a third instant. No travel logic exists.
//
//   training  primary   at days[d].time on each confirmed weekday
//             follow-up at primary + 2 h (product policy). Suppressed when it
//             would fall in quiet hours; never exists when it would cross local
//             midnight; never moved. Both suppressed by an explicit Finish Workout.
//   meals     feed k    at feeds[k].time every day. Schedule only — no meal
//             completion is ever inferred.
//
// Windows are [time, time + WINDOW) clipped to the next stage/slot and to the
// end of the local day, so each event belongs to exactly one local date D.
// ============================================================================

export const FOLLOWUP_OFFSET_MINUTES = 120;
export const MAX_MEAL_SLOTS = 8;
export const DAILY_CAP = 10;            // automatic training + meal pushes per client per local day
export const SCHEDULE_SCHEMA = 'locked-in.schedule.v1';

export type DailyPrefs = Prefs & { training_enabled?: boolean | null; meals_enabled?: boolean | null };

export type ScheduleV1 = {
  schema: string;
  training: { status: 'confirmed' | 'unknown'; source?: string; days?: Array<{ dow: number; time: string; session: string | null }> };
  meals: { status: 'confirmed' | 'unknown'; source?: string; feeds?: Array<{ slot: number; time: string }> };
};

export type PlanFacts = {
  meal_facts_status: string;
  meal_slot_count: number | null;
  has_workout_completion: boolean;
  schedule?: ScheduleV1 | null;
  training_schedule_status?: string | null;
  meal_schedule_status?: string | null;
} | null;

const SESSION_RE = /^[A-Za-z][A-Za-z0-9 &/+-]{0,29}$/;
const SOURCES = ['client_confirmed', 'coach_confirmed'];
const onGrid = (t: unknown) => { const m = parseTime(t); return m !== null && m % 15 === 0 && /^\d{2}:\d{2}$/.test(String(t)) ? m : null; };

/**
 * Validate a locked-in.schedule.v1 object. Pure. Returns per-category status:
 * 'confirmed' (usable), 'unknown' (declared unknown or absent → unavailable,
 * never an error) or 'invalid' (malformed → unavailable) with the reasons.
 * `feedCount` is the served plan's consistent feed count (null = variable/unreadable).
 */
export function validateSchedule(raw: unknown, feedCount: number | null):
    { training: 'confirmed' | 'unknown' | 'invalid'; meals: 'confirmed' | 'unknown' | 'invalid'; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { training: 'unknown', meals: 'unknown', errors };
  const s = raw as any;
  if (typeof s !== 'object' || Array.isArray(s) || s.schema !== SCHEDULE_SCHEMA) return { training: 'invalid', meals: 'invalid', errors: ['schema'] };
  const extra = Object.keys(s).filter((k) => !['schema', 'training', 'meals'].includes(k));
  if (extra.length) return { training: 'invalid', meals: 'invalid', errors: ['unknown_key:' + extra[0]] };   // e.g. a timezone: there is ONE runtime tz
  const cat = (c: any, name: string, check: (c: any) => string | null): 'confirmed' | 'unknown' | 'invalid' => {
    if (!c || c.status === 'unknown') return 'unknown';
    if (c.status !== 'confirmed') { errors.push(name + ':status'); return 'invalid'; }
    if (!SOURCES.includes(c.source)) { errors.push(name + ':source'); return 'invalid'; }
    const e = check(c);
    if (e) { errors.push(name + ':' + e); return 'invalid'; }
    return 'confirmed';
  };
  const training = cat(s.training, 'training', (c) => {
    if (Object.keys(c).some((k) => !['status', 'source', 'days'].includes(k))) return 'unknown_key';
    if (!Array.isArray(c.days) || !c.days.length || c.days.length > 7) return 'days';
    const seen = new Set<number>();
    for (const d of c.days) {
      if (!d || typeof d !== 'object' || Object.keys(d).some((k) => !['dow', 'time', 'session'].includes(k))) return 'day_shape';
      if (!Number.isInteger(d.dow) || d.dow < 0 || d.dow > 6 || seen.has(d.dow)) return 'dow';
      seen.add(d.dow);
      if (onGrid(d.time) === null) return 'time';
      if (d.session !== null && !(typeof d.session === 'string' && SESSION_RE.test(d.session))) return 'session';
    }
    return null;
  });
  const meals = cat(s.meals, 'meals', (c) => {
    if (Object.keys(c).some((k) => !['status', 'source', 'feeds'].includes(k))) return 'unknown_key';
    if (!Array.isArray(c.feeds) || !c.feeds.length || c.feeds.length > MAX_MEAL_SLOTS) return 'feeds';
    let last = -1;
    for (let i = 0; i < c.feeds.length; i++) {
      const f = c.feeds[i];
      if (!f || typeof f !== 'object' || Object.keys(f).some((k) => !['slot', 'time'].includes(k))) return 'feed_shape';
      if (f.slot !== i + 1) return 'slot';                       // unique, sequential 1..N
      const m = onGrid(f.time);
      if (m === null) return 'time';
      if (m <= last) return 'order';                             // Meal k is later than Meal k-1
      last = m;
    }
    if (feedCount === null || c.feeds.length !== feedCount) return 'feed_count_mismatch';
    return null;
  });
  return { training, meals, errors };
}

/** Is the client's local weekday a confirmed training day? Returns that day's entry. */
export function trainingDayOf(schedule: ScheduleV1 | null | undefined, dow: number) {
  const days = schedule?.training?.status === 'confirmed' ? schedule.training.days ?? [] : [];
  return days.find((d) => d.dow === dow) ?? null;
}

/** Plan-owned stage times for one training day. Follow-up absent when it would cross midnight. */
export function trainingStages(day: { time: string } | null): { primary: number; followup: number | null } | null {
  const primary = day ? parseTime(day.time) : null;
  if (primary === null) return null;
  const fu = primary + FOLLOWUP_OFFSET_MINUTES;
  return { primary, followup: fu < MINUTES_PER_DAY ? fu : null };
}

export const trainingAvailable = (facts: PlanFacts) =>
  !!facts && facts.has_workout_completion === true && facts.training_schedule_status === 'confirmed' && facts.schedule?.training?.status === 'confirmed';
export const mealsAvailable = (facts: PlanFacts) =>
  !!facts && facts.meal_schedule_status === 'confirmed' && facts.meal_facts_status === 'consistent' &&
  facts.schedule?.meals?.status === 'confirmed' && (facts.schedule.meals.feeds ?? []).length === facts.meal_slot_count;

/** Window [at, min(at + WINDOW, nextAt, end of day)) on the local clock. */
function inDayWindow(minuteOfDay: number, at: number, nextAt: number | null): boolean {
  const end = Math.min(at + WINDOW_MINUTES, nextAt ?? Infinity, MINUTES_PER_DAY);
  return minuteOfDay >= at && minuteOfDay < end;
}

export type TrainingStage = 'primary' | 'followup';
export type TrainingEvaluation =
  | { due: false }
  | { due: true; stage: TrainingStage; periodKey: string; eligibleAt: number; session: string | null;
      /** [start, end) of local day D — the only span in which a completion counts */
      dayFrom: number; dayTo: number;
      suppress?: 'disabled' | 'quiet_hours' };

/**
 * Which plan training stage (if any) is open at `now`. Pure. The client's only
 * input is training_enabled; days, times and the follow-up come from the plan.
 */
export function evaluateTrainingStage(p: DailyPrefs, nowMs: number, facts: PlanFacts): TrainingEvaluation {
  if (p.training_enabled !== true || !isValidTimezone(p.timezone) || !trainingAvailable(facts)) return { due: false };
  const now = localParts(nowMs, p.timezone);
  const day = trainingDayOf(facts!.schedule, now.dow);
  const st = trainingStages(day);
  if (!st) return { due: false };
  let stage: TrainingStage, at: number;
  if (inDayWindow(now.minuteOfDay, st.primary, st.followup)) { stage = 'primary'; at = st.primary; }
  else if (st.followup !== null && inDayWindow(now.minuteOfDay, st.followup, null)) { stage = 'followup'; at = st.followup; }
  else return { due: false };
  const D = now.date;
  const { start, end } = localDayBounds(D, p.timezone);
  const ev = { due: true as const, stage, periodKey: D, eligibleAt: zonedTimeToUtc(D, at, p.timezone),
               session: day!.session ?? null, dayFrom: start, dayTo: end };
  if (!p.notifications_enabled) return { ...ev, suppress: 'disabled' };
  if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) return { ...ev, suppress: 'quiet_hours' };
  return ev;
}

/** Plan feed times (1-based slots). */
export function mealSlotTimes(facts: PlanFacts): Array<{ slot: number; at: number }> {
  if (!mealsAvailable(facts)) return [];
  return (facts!.schedule!.meals.feeds ?? []).map((f) => ({ slot: f.slot, at: parseTime(f.time) as number }));
}

export type MealSlotEvaluation = { slot: number; periodKey: string; eligibleAt: number; suppress?: 'disabled' | 'quiet_hours' };

/** Plan meal slots whose window is open at `now` (at most one). Pure; never looks at eating. */
export function evaluateMealSlots(p: DailyPrefs, nowMs: number, facts: PlanFacts): MealSlotEvaluation[] {
  if (p.meals_enabled !== true || !isValidTimezone(p.timezone)) return [];
  const slots = mealSlotTimes(facts);
  const now = localParts(nowMs, p.timezone);
  const out: MealSlotEvaluation[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!inDayWindow(now.minuteOfDay, s.at, i + 1 < slots.length ? slots[i + 1].at : null)) continue;
    const ev = { slot: s.slot, periodKey: now.date, eligibleAt: zonedTimeToUtc(now.date, s.at, p.timezone) };
    if (!p.notifications_enabled) out.push({ ...ev, suppress: 'disabled' });
    else if (inQuietHours(now.minuteOfDay, parseTime(p.quiet_start) ?? 0, parseTime(p.quiet_end) ?? 0)) out.push({ ...ev, suppress: 'quiet_hours' });
    else out.push(ev);
  }
  return out;
}

/**
 * Fail-safe for in-app trainer-mode meal edits (client_overrides meal.wN.dN),
 * which change a day's meals without a deploy. If ANY active edit's feed count
 * differs from the synced schedule — or cannot be read — the server can no
 * longer prove the schedule matches what the client sees: no meal reminder.
 */
export function mealOverridesConsistent(rows: Array<{ key: string; value_text: string | null }>, feedCount: number): boolean {
  for (const r of rows) {
    if (!/^meal\.w\d+\.d\d+$/.test(r.key)) continue;
    if (r.value_text === null || r.value_text === '' || r.value_text === 'null') continue;     // a reset, not an edit
    let v: unknown;
    try { v = JSON.parse(r.value_text); } catch { return false; }
    if (!Array.isArray(v)) return false;
    const n = v.filter((m: any) => m && typeof m === 'object' && m.name && Number(m.cal) > 0).length;
    if (n !== feedCount) return false;
  }
  return true;
}

/** decideReminder for a pure schedule reminder: there is no observation, so "completed" can never be claimed. */
export function decideScheduled(i: { due: boolean; eligible: boolean; active: boolean; enabled: boolean; quiet: boolean; hasDevice: boolean }): Decision {
  return decideReminder({ ...i, observation: 'incomplete' });
}

// ── diagnostics (coachPushExplain): what local day D looks like, no live state ─
export type DailyPlanView = {
  training: { status: 'disabled' | 'no_confirmed_schedule' | 'unsupported_workout_completion' | 'not_training_day' | 'scheduled';
              session: string | null; followupPolicy: string | null;
              stages: Array<{ stage: TrainingStage; time: string; at: number }> };
  meals: { status: 'disabled' | 'no_plan_facts' | 'no_confirmed_schedule' | 'scheduled';
           slots: Array<{ slot: number; time: string; at: number }> };
};

export function dailyPlan(p: DailyPrefs, facts: PlanFacts, D: string): DailyPlanView {
  const tz = isValidTimezone(p.timezone) ? p.timezone : null;
  const inst = (m: number) => (tz ? zonedTimeToUtc(D, m, tz) : NaN);
  const training: DailyPlanView['training'] = { status: 'scheduled', session: null, followupPolicy: null, stages: [] };
  if (!facts || facts.training_schedule_status !== 'confirmed') training.status = 'no_confirmed_schedule';
  else if (facts.has_workout_completion !== true) training.status = 'unsupported_workout_completion';
  else if (p.training_enabled !== true) training.status = 'disabled';
  else {
    const day = trainingDayOf(facts.schedule, dowOf(D));
    const st = trainingStages(day);
    if (!st) training.status = 'not_training_day';
    else {
      training.session = day!.session ?? null;
      training.stages.push({ stage: 'primary', time: formatTime(st.primary), at: inst(st.primary) });
      if (st.followup !== null) training.stages.push({ stage: 'followup', time: formatTime(st.followup), at: inst(st.followup) });
      training.followupPolicy = st.followup === null ? 'suppressed_crosses_midnight' : 'primary_plus_2h';
    }
  }
  const meals: DailyPlanView['meals'] = { status: 'scheduled', slots: [] };
  if (!facts) meals.status = 'no_plan_facts';
  else if (!mealsAvailable(facts)) meals.status = 'no_confirmed_schedule';
  else if (p.meals_enabled !== true) meals.status = 'disabled';
  else for (const x of mealSlotTimes(facts)) meals.slots.push({ slot: x.slot, time: formatTime(x.at), at: inst(x.at) });
  return { training, meals };
}
