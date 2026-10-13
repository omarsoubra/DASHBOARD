// ============================================================================
// COACH MORNING REPORT (Omar 2026-10-13) — the dashboard's "This morning" card,
// as one push notification to the coach's own phone at 07:00 Sydney. Pure: the
// handler loads the data, this decides the words. Same rules as the card
// (coach_dashboard.html renderMorning) and client_template morning_report.py:
//   unlock codes due this week (week 5 -> phase 2, week 9 -> phase 3) and next week (4 / 8), from roster startDate
//   drafted check-in replies not yet sent
//   active clients quiet 3-13 days (worth a nudge); 14+ days counted as inactive
//   client pages that fail to load
//   client journey (2026-10-13): block ending (weeks 10-12), finished 12 weeks with no next block (13+), journey messages drafted
// Accounts whose key starts with '_' (canaries, the coach account) and 'omar' (the coach's own client page) are skipped.
// ============================================================================

export const COACH_KEY = '_coach';
export const COACH_MORNING_MINUTE = 7 * 60;          // 07:00 local; the 15-minute tick sends it in [07:00, 07:15)
export const COACH_TZ = 'Australia/Sydney';

export type RosterEntry = { storageKey?: string; displayName?: string; startDate?: string | null; programStatus?: string; durationWeeks?: number | string;
                            accessStatus?: string; isPaused?: boolean };
export type MorningInput = { roster: RosterEntry[]; lastActivityMs: Record<string, number>; repliesReady: number;
                             pagesDown: string[]; today: string; nowMs: number; journeyReady?: number };

export function isActiveRosterClient(c: RosterEntry): boolean {
  const k = String(c?.storageKey ?? '');
  if (!k || k.startsWith('_') || k === 'omar') return false;
  const st = String(c.programStatus ?? 'active').toLowerCase(), acc = String(c.accessStatus ?? 'active').toLowerCase();
  return !['archived', 'paused', 'onboarding', 'completed'].includes(st) && !['revoked', 'suspended'].includes(acc) && !c.isPaused;
}

/** Programme week for 'YYYY-MM-DD' start on local date `today` (week 1 = days 0-6); null when unknown or not started. */
export function programWeek(start: string | null | undefined, today: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(start ?? ''));
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m || !t) return null;
  const days = Math.round((Date.UTC(+t[1], +t[2] - 1, +t[3]) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
  return days < 0 ? null : Math.floor(days / 7) + 1;
}

export function blockWeeks(c: RosterEntry): number {
  const n = parseInt(String(c?.durationWeeks ?? ''), 10);
  return n >= 4 && n <= 52 ? n : 12;
}

export function coachMorningHeadline(inp: MorningInput): { body: string; items: Record<string, unknown> } {
  const first = (c: RosterEntry) => String(c.displayName || c.storageKey).split(' ')[0];
  const now: string[] = [], next: string[] = [], quiet: string[] = [], inactive: string[] = [], ending: string[] = [], past: string[] = [];
  const active = inp.roster.filter(isActiveRosterClient);
  for (const c of active) {
    const w = programWeek(c.startDate, inp.today);
    // 4-week phases (12 weeks = 3, 16 = 4 since 2026-10-13): unlocks at 5, 9, 13; the block ends at its own length.
    const L = blockWeeks(c), nph = Math.max(1, Math.floor(L / 4));
    if (w !== null && w > 1 && w % 4 === 1 && (w - 1) / 4 < nph) now.push(`${first(c)} (P${(w - 1) / 4 + 1})`);
    else if (w !== null && w % 4 === 0 && w / 4 < nph) next.push(`${first(c)} (P${w / 4 + 1})`);
    if (w !== null && w >= L - 2 && w <= L) ending.push(first(c)); else if (w !== null && w > L) past.push(first(c));
    const la = inp.lastActivityMs[String(c.storageKey)];
    if (typeof la === 'number') {
      const d = Math.floor((inp.nowMs - la) / 86400000);
      if (d >= 3 && d < 14) quiet.push(first(c)); else if (d >= 14) inactive.push(first(c));
    }
  }
  const down = active.filter((c) => inp.pagesDown.includes(String(c.storageKey))).map(first);
  const parts: string[] = [];
  if (down.length) parts.push(`PAGE DOWN: ${down.slice(0, 3).join(', ')}`);
  if (now.length) parts.push(`unlock: ${now.slice(0, 4).join(', ')}${now.length > 4 ? '…' : ''}`);
  if (inp.repliesReady) parts.push(`${inp.repliesReady} repl${inp.repliesReady === 1 ? 'y' : 'ies'} ready`);
  if (past.length) parts.push(`${past.length} finished, no next block`);
  if (ending.length) parts.push(`${ending.length} ending soon`);
  if (inp.journeyReady) parts.push(`${inp.journeyReady} journey msg${inp.journeyReady === 1 ? '' : 's'} ready`);
  if (quiet.length) parts.push(`${quiet.length} quiet (${quiet.slice(0, 3).join(', ')}${quiet.length > 3 ? '…' : ''})`);
  if (next.length) parts.push(`next wk unlock: ${next.length}`);
  if (inactive.length) parts.push(`${inactive.length} inactive 14d+`);
  const body = parts.length ? parts.join(' · ') : 'All clear - nothing extra today';
  return { body: body.slice(0, 220), items: { pageDown: down, unlockNow: now, unlockNext: next, repliesReady: inp.repliesReady, quiet, inactive, ending, pastBlock: past, journeyReady: inp.journeyReady ?? 0 } };
}

/** Last activity per client (latest weight, check-in, workout set, meal since `sinceIso`) — one row per table per client.
 *  Coach report only: client reminders never read these logs (tests/push_daily ME1, push_v2 WO7). */
export async function loadLastActivity(admin: any, roster: RosterEntry[], idByKey: Record<string, string>, sinceIso: string):
    Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const latest = async (table: string, tsCol: string, col: string, val: string): Promise<number | null> => {
    const { data, error } = await admin.from(table).select(tsCol).eq(col, val).gte(tsCol, sinceIso)
      .order(tsCol, { ascending: false }).limit(1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const t = Date.parse((data ?? [])[0]?.[tsCol] ?? '');
    return Number.isFinite(t) ? t : null;
  };
  await Promise.all(roster.map(async (c) => {
    const k = String(c.storageKey);
    const ts = await Promise.all([
      latest('weight_logs', 'logged_at', 'client_key', k),
      latest('check_ins', 'submitted_at', 'client_key', k),
      latest('workout_log_entries', 'logged_at', 'client_key', k),
      idByKey[k] ? latest('meal_logs', 'logged_at', 'client_id', idByKey[k]) : Promise.resolve(null),
    ]);
    const got = ts.filter((t): t is number => t !== null);
    if (got.length) out[k] = Math.max(...got);
  }));
  return out;
}
