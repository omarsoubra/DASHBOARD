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
