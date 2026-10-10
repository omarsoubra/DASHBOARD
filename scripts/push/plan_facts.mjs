#!/usr/bin/env node
// ============================================================================
// LOCKED IN Push — Daily Reminders V1: facts read from a SERVED client shell.
//
//   planFactsFromShell(bytes) → {
//     served_sha256,            sha256 of exactly these bytes
//     meal_facts_status,        'consistent' | 'variable' | 'unreadable' | 'unsupported'
//     meal_slot_count,          N when every day of every week has N feeds, else null
//     meal_plan_sig,            sha256 of the parsed plan (changes whenever the plan does)
//     has_workout_completion,   all four Finish Workout hooks present
//     schedule, schedule_sig,   the approved plan's LI_SCHEDULE literal (or null) + its hash
//     training_days_per_week,   mandatory sessions per week (same in every phase), else null
//     meal_lunch_time,          'HH:MM' the plan's usual midday feed (11:00–15:00), else null
//     meal_dinner_time,         'HH:MM' the plan's usual last feed (17:00–20:59), else null
//   }
//
// The two meal times are the only times read (rounded down to 15 minutes);
// they feed the default lunch / dinner reminders (Omar 2026-10-11). Null → the
// server's 12:30 / 20:30 defaults. Days null → the server's 4-day default.
//
// A FEED is a meal card the shell renders with calories (name set, cal > 0);
// prep-note cards (cal 0) are not feeds. The meal plan is read with a strict
// literal parser — strings, numbers, arrays and the two plan builders mkday()
// and mkm(). Nothing in the shell is ever executed. Anything else → 'unreadable'
// → null → meal reminders unavailable. The result carries no food names,
// calories or macros: counts, a hash, a flag and two usual meal clock times.
//
// CLI (read-only):  node scripts/push/plan_facts.mjs clients/<key>/index.html
// ============================================================================
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_MEAL_SLOTS = 8;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// The four insertions of scripts/workouts/patch_completion_shell.py.
const WC_HOOKS = [
  '// ============================================= WORKOUT-COMPLETION-V1',
  '// =========================================== END WORKOUT-COMPLETION-V1',
  'wcFinishBar() + /* WORKOUT-COMPLETION-V1 */',
  'wcBoot(); } catch (eWc) {}   /* WORKOUT-COMPLETION-V1 */',
];

class ParseError extends Error {}

/** Strict literal parser over src starting at i. Returns [value, nextIndex]. */
function parseValue(src, i) {
  i = skipWs(src, i);
  const ch = src[i];
  if (ch === "'" || ch === '"') return parseString(src, i);
  if (ch === '[') {
    const out = []; i = skipWs(src, i + 1);
    if (src[i] === ']') return [out, i + 1];
    for (;;) {
      const [v, j] = parseValue(src, i); out.push(v); i = skipWs(src, j);
      if (src[i] === ',') { i = skipWs(src, i + 1); if (src[i] === ']') return [out, i + 1]; continue; }
      if (src[i] === ']') return [out, i + 1];
      throw new ParseError('array');
    }
  }
  const num = /^-?\d+(\.\d+)?/.exec(src.slice(i, i + 32));
  if (num) return [Number(num[0]), i + num[0].length];
  const call = /^(mkday|mkm)\s*\(/.exec(src.slice(i, i + 16));
  if (call) {
    i += call[0].length;
    const args = []; i = skipWs(src, i);
    if (src[i] !== ')') {
      for (;;) {
        const [v, j] = parseValue(src, i); args.push(v); i = skipWs(src, j);
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ')') break;
        throw new ParseError('call');
      }
    }
    i++;
    if (call[1] === 'mkday') {
      if (args.length !== 1 || !Array.isArray(args[0])) throw new ParseError('mkday');
      return [{ meals: args[0] }, i];
    }
    if (args.length !== 7) throw new ParseError('mkm');
    const [time, name, desc, cal, p, c, f] = args;
    return [{ time, name, desc, cal, p, c, f }, i];
  }
  throw new ParseError('unexpected token');
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function parseString(src, i) {
  const q = src[i]; let out = ''; i++;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const n = src[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '/': '/' };
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
      if (!(n in map)) throw new ParseError('escape');
      out += map[n]; i += 2; continue;
    }
    if (ch === q) return [out, i + 1];
    if (ch === '\n') throw new ParseError('newline in string');
    out += ch; i++;
  }
  throw new ParseError('unterminated string');
}

/** { week: [day, …7] } from the shell, or throws ParseError. */
export function parseMealPlan(html) {
  const decl = html.indexOf('const mealPlan = {};');
  if (decl < 0) throw new ParseError('no mealPlan');
  const re = /\bmealPlan\[(\d+)\]\s*=\s*/g;
  re.lastIndex = decl;
  const plan = {};
  let m;
  while ((m = re.exec(html))) {
    const [v, j] = parseValue(html, m.index + m[0].length);
    if (!Array.isArray(v)) throw new ParseError('week not an array');
    if (plan[m[1]]) throw new ParseError('week assigned twice');
    plan[m[1]] = v;
    re.lastIndex = j;
  }
  if (!Object.keys(plan).length) throw new ParseError('no weeks');
  return plan;
}

const isFeed = (meal) => !!meal && typeof meal === 'object' && !!meal.name && Number(meal.cal) > 0;

/** '7:30am' · '12:30pm' · '19:30' · '7pm' → minutes (15-min floor), else null. Labels ('Lunch') → null. */
export function clockMinutes(t) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(String(t ?? ''));
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] ?? 0); const ap = (m[3] ?? '').toLowerCase();
  if (h > 23 || mi > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  else if (m[2] === undefined) return null;                    // a bare number is not a time
  const v = h * 60 + mi;
  return v - (v % 15);
}
const hhmm = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;

/** The most common value; ties → the earliest. null when empty. */
function mode(values) {
  const n = new Map();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  let best = null, bc = 0;
  for (const [v, c] of [...n.entries()].sort((a, b) => a[0] - b[0])) if (c > bc) { best = v; bc = c; }
  return best;
}

/** Usual lunch / dinner clock times across every day of the plan. */
export function mealAnchorTimes(plan) {
  const lunch = [], dinner = [];
  for (const days of Object.values(plan)) for (const d of days) {
    const ts = (d?.meals ?? []).filter(isFeed).map((m) => clockMinutes(m.time)).filter((v) => v !== null);
    const l = ts.filter((v) => v >= 11 * 60 && v <= 15 * 60).sort((a, b) => Math.abs(a - 750) - Math.abs(b - 750) || a - b)[0];
    const dn = ts.filter((v) => v >= 17 * 60 && v < 21 * 60).sort((a, b) => b - a)[0];
    if (l !== undefined) lunch.push(l);
    if (dn !== undefined) dinner.push(dn);
  }
  const L = mode(lunch), D = mode(dinner);
  return { meal_lunch_time: L === null ? null : hhmm(L), meal_dinner_time: D === null ? null : hhmm(D) };
}

/**
 * Mandatory training sessions per week from `const phases = {…}`: per phase,
 * days badged MANDATORY (or, with no such badge, every "Day N" minus OPTIONAL).
 * One number only when every phase agrees; anything else → null (server default).
 */
export function trainingDaysPerWeek(html) {
  const i = html.indexOf('const phases = {');
  if (i < 0) return null;
  const end = html.indexOf('\n};', i);
  if (end < 0) return null;
  const blocks = html.slice(i, end).split(/\n {2}\d+: \{/).slice(1);
  const counts = new Set();
  for (const b of blocks) {
    const mand = (b.match(/badge: "MANDATORY"/g) || []).length;
    const days = (b.match(/label: "Day \d+/g) || []).length;
    const opt = (b.match(/badge: "OPTIONAL"/g) || []).length;
    const n = mand || (days - opt);
    if (n < 1 || n > 7) return null;
    counts.add(n);
  }
  return counts.size === 1 ? [...counts][0] : null;
}

/**
 * The approved plan's schedule: `const LI_SCHEDULE = {…};` emitted by the
 * generator as a JSON literal. Read with a bracket matcher + JSON.parse —
 * never executed. Absent → null (schedule unknown → reminders unavailable).
 * Malformed → { error } so the server records it as invalid, never guessed.
 */
export function parseSchedule(html) {
  const m = /\bconst LI_SCHEDULE\s*=\s*/.exec(html);
  if (!m) return { schedule: null, raw: null };
  let i = m.index + m[0].length, d = 0, q = false;
  if (html[i] !== '{') return { error: 'not_an_object' };
  const start = i;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === '"') q = false; continue; }
    if (ch === '"') { q = true; continue; }
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (d === 0) break; }
  }
  const raw = html.slice(start, i + 1);
  if (d !== 0 || raw.length > 4000) return { error: 'unterminated' };
  try { return { schedule: JSON.parse(raw), raw }; } catch { return { error: 'not_json' }; }
}

export function planFactsFromShell(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const html = buf.toString('utf8');
  const facts = {
    served_sha256: sha256(buf),
    meal_facts_status: 'unreadable', meal_slot_count: null, meal_plan_sig: null,
    has_workout_completion: WC_HOOKS.every((h) => html.includes(h)),
    schedule: null, schedule_sig: null,
    training_days_per_week: trainingDaysPerWeek(html),
    meal_lunch_time: null, meal_dinner_time: null,
  };
  const sch = parseSchedule(html);
  if (sch.error) facts.schedule = { schema: 'unparseable' };            // server records 'invalid'
  else if (sch.schedule) facts.schedule = sch.schedule;
  if (facts.schedule) facts.schedule_sig = sha256(JSON.stringify(facts.schedule));
  let plan;
  try { plan = parseMealPlan(html); } catch (e) { if (e instanceof ParseError) return facts; throw e; }
  facts.meal_plan_sig = sha256(JSON.stringify(plan));
  Object.assign(facts, mealAnchorTimes(plan));
  const counts = new Set();
  for (const days of Object.values(plan)) {
    if (days.length !== 7) return facts;                       // a week must have 7 days
    for (const d of days) {
      if (!d || !Array.isArray(d.meals)) return facts;
      counts.add(d.meals.filter(isFeed).length);
    }
  }
  if (counts.size !== 1) { facts.meal_facts_status = 'variable'; return facts; }
  const n = [...counts][0];
  if (n < 1 || n > MAX_MEAL_SLOTS) { facts.meal_facts_status = 'unsupported'; return facts; }
  facts.meal_facts_status = 'consistent';
  facts.meal_slot_count = n;
  return facts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const f = process.argv[2];
  if (!f) { console.error('usage: plan_facts.mjs <index.html>'); process.exit(2); }
  console.log(JSON.stringify(planFactsFromShell(readFileSync(f))));
}
