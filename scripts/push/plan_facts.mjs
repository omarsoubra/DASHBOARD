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
//   }
//
// A FEED is a meal card the shell renders with calories (name set, cal > 0);
// prep-note cards (cal 0) are not feeds. The meal plan is read with a strict
// literal parser — strings, numbers, arrays and the two plan builders mkday()
// and mkm(). Nothing in the shell is ever executed. Anything else → 'unreadable'
// → null → meal reminders unavailable. The result carries no food names,
// times, calories or macros: only a count, a hash and a flag.
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

export function planFactsFromShell(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const html = buf.toString('utf8');
  const facts = {
    served_sha256: sha256(buf),
    meal_facts_status: 'unreadable', meal_slot_count: null, meal_plan_sig: null,
    has_workout_completion: WC_HOOKS.every((h) => html.includes(h)),
  };
  let plan;
  try { plan = parseMealPlan(html); } catch (e) { if (e instanceof ParseError) return facts; throw e; }
  facts.meal_plan_sig = sha256(JSON.stringify(plan));
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
