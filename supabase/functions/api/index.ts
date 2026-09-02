// ============================================================================
// StrengthByO / LOCKED IN — Supabase Edge Function
// Mirrors every Apps Script v5-secure endpoint 1:1 so the coach dashboard +
// client shells can point here with a single URL swap. Same request shape
// (POST body { type: '...', ...args }), same response shape.
//
// Deploy:
//   supabase functions deploy api --project-ref YOUR_PROJECT_REF
// Local dev:
//   supabase functions serve api
// ============================================================================
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── env ────────────────────────────────────────────────────────────────────
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const COACH_PASSWORD_HASH  = Deno.env.get('COACH_PASSWORD_HASH') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Auto-progression canary allowlist ─────────────────────────────────────
// Only clients in this set receive automatic prescription updates on workout write.
// All other clients log workouts normally but skip _autoProgressAfterWorkout.
// To graduate to full rollout: replace the Set with a constant `true` check (or remove the gate).
// To add a client: append their storageKey (lowercase) to this set and redeploy.
const AUTO_PROGRESSION_CANARY = new Set<string>([
  'faith_kainuku',
  'nicholas',
]);

// ── CORS + JSON helpers ────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ok  = (extra: Record<string, unknown> = {}) => json({ ok: true, ...extra });
const err = (reason: string, extra: Record<string, unknown> = {}) => json({ ok: false, error: reason, ...extra });

// ── auth ────────────────────────────────────────────────────────────────────
function verifyCoachToken(token: string | undefined): boolean {
  // Same shape as Apps Script — a coach session token is a SHA-256 of the
  // password + salt stored in COACH_PASSWORD_HASH. For migration we accept
  // the same hash the Apps Script accepts so coach dashboard keeps working
  // without a re-login. Move to Supabase Auth (magic-link email) post-migration.
  if (!token || !COACH_PASSWORD_HASH) return false;
  return token === COACH_PASSWORD_HASH;
}
async function verifyClientToken(token: string | undefined, storageKey: string | undefined): Promise<{ ok: boolean; storageKey?: string; reason?: string }> {
  if (!token || !storageKey) return { ok: false, reason: 'missing_credentials' };
  const { data, error } = await admin
    .from('client_sessions')
    .select('token_hash, salt, access_status, clients(storage_key)')
    .eq('storage_key', storageKey.toLowerCase())
    .single();
  if (error || !data) return { ok: false, reason: 'unknown_client' };
  if (data.access_status === 'revoked')   return { ok: false, reason: 'access_revoked' };
  if (data.access_status === 'suspended') return { ok: false, reason: 'access_suspended' };
  const hash = await sha256(token + (data.salt ?? ''));
  if (hash !== data.token_hash) return { ok: false, reason: 'bad_token' };
  return { ok: true, storageKey };
}
async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const dig = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(dig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── G4: structured error telemetry ────────────────────────────────────────
// Logs to Supabase function console (viewable in dashboard). Does not log
// raw tokens, passwords, photo payloads, or personal data.
function logEfError(op: string, clientKey: string | null, code: string, detail: string) {
  console.error(JSON.stringify({
    tag: 'EF_ERROR',
    ts:  new Date().toISOString(),
    op,
    client: clientKey,
    code,
    detail: detail.slice(0, 200),
  }));
}

// ── router entry ───────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const t = url.searchParams.get('type');
    if (t === 'ping') return json({ ok: true, v: 'supabase-edge-v1' });

    // G2: Authenticated client cloud-restore endpoint.
    // Client shells call GET ?type=dashboard&client=<key>&token=<token>
    // to rebuild localStorage after iOS purge or fresh install.
    if (t === 'dashboard') {
      const clientKey = (url.searchParams.get('client') ?? '').toLowerCase();
      const token     = url.searchParams.get('token') ?? '';
      if (!clientKey || !token) return json({ ok: false, error: 'unauthorized' }, 401);
      const v = await verifyClientToken(token, clientKey);
      if (!v.ok) return json({ ok: false, error: v.reason ?? 'unauthorized' }, 401);
      return clientRestoreGet(clientKey);
    }

    // G1: Authenticated override pull.
    // Client shells call GET ?client=<key>&token=<token> to receive coach-set overrides.
    // Returns HTTP 401 on auth failure so the client's `if (!resp.ok) throw` guard
    // fires — preventing an error response from being saved as overrides.
    if (url.searchParams.has('client')) {
      const clientKey = (url.searchParams.get('client') ?? '').toLowerCase();
      const token     = url.searchParams.get('token') ?? '';
      if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
      const v = await verifyClientToken(token, clientKey);
      if (!v.ok) return json({ ok: false, error: v.reason ?? 'unauthorized' }, 401);
      const { data: client } = await admin.from('clients').select('id').eq('storage_key', clientKey).single();
      if (!client) return json({ ok: false, error: 'unknown_client' }, 404);
      const { data } = await admin.from('client_overrides')
        .select('key, value_text, value_number')
        .eq('client_id', client.id)
        .is('valid_to', null);
      const keyed: Record<string, any> = {};
      for (const row of (data ?? [])) {
        let v: any = row.value_number ?? row.value_text;
        // JSON.parse arrays/objects so getDayExercises() receives real arrays, not strings
        if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
          try { v = JSON.parse(v); } catch { /* leave as string if malformed */ }
        }
        keyed[row.key] = v;
      }
      return json(keyed); // raw keyed object — no ok wrapper, matches what saveOverridesLocal expects
    }

    return err('post_only');
  }

  if (req.method !== 'POST') return err('method_not_allowed');

  let body: any;
  try { body = await req.json(); } catch { return err('bad_json'); }
  const type: string = body?.type || '';

  try {
    switch (type) {
      case 'ping':               return ok({ v: 'supabase-edge-v1' });
      case 'authCoach':          return authCoach(body);
      case 'authClient':         return authClient(body);
      case 'dashboard':          return dashboard(body);
      case 'rosterGet':          return rosterGet(body);
      case 'rosterPut':          return rosterPut(body);
      case 'registryGetPrivate': return registryGetPrivate(body);
      case 'issueClientToken':   return issueClientToken(body);
      case 'setAccessStatus':    return setAccessStatus(body);
      case 'setClientProgram':   return setClientProgram(body);
      case 'clientProgram':      return clientProgram(body);
      case 'weightLog':          return weightLog(body);
      case 'photosGet':          return photosGet(body);
      case 'overrideGet':        return overrideGet(body);
      case 'overridePut':        return overridePut(body);
      case 'weight':             return clientWrite('weight', body);
      case 'checkin':            return clientWrite('checkin', body);
      case 'meal':               return clientWrite('meal', body);
      case 'workout':            return clientWrite('workout', body);
      case 'photoUpload':        return clientWrite('photoUpload', body);
      case 'intake':             return intake(body);
      case 'legacyQueueGet':     return legacyQueueGet(body);
      case 'legacyQueuePromote': return legacyQueuePromote(body);
      case 'legacyQueueReject':  return legacyQueueReject(body);
      case 'progressionCompute':   return progressionCompute(body);
      case 'progressionApply':     return progressionApply(body);
      case 'progressionHistory':   return progressionHistory(body);
      default: return err('unknown_type');
    }
  } catch (e) {
    const clientKey = body?.storageKey ?? body?.client ?? null;
    logEfError(type, clientKey, 'internal_error', String(e));
    return err('internal_error', { detail: String(e).slice(0, 300) });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Endpoint implementations
// ══════════════════════════════════════════════════════════════════════════

async function authCoach(body: any) {
  const pw = body?.password || '';
  // Same interface as Apps Script — coach POSTs password, backend returns token.
  // Token here IS the hash (coach dashboard already treats it as opaque).
  const hash = await sha256(pw);
  if (hash !== COACH_PASSWORD_HASH) return err('bad_password');
  return ok({ coachToken: hash });
}

async function authClient(body: any) {
  const v = await verifyClientToken(body?.token, body?.storageKey);
  if (!v.ok) return err(v.reason ?? 'unauthorized');
  const { data } = await admin.from('client_sessions').select('access_status').eq('storage_key', body.storageKey).single();
  return ok({ storageKey: body.storageKey, accessStatus: data?.access_status ?? 'active' });
}

async function dashboard(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString();
  const weekAgo   = new Date(Date.now() -  7 * 86400_000).toISOString();
  const todayStr  = new Date().toISOString().slice(0, 10);
  const [{ data: clients }, { data: weights }, { data: checkins }, { data: meals }, { data: workouts }] = await Promise.all([
    admin.from('clients').select('id, storage_key'),
    admin.from('weight_logs').select('client_key, logged_at, weight_kg').gte('logged_at', ninetyAgo),
    admin.from('check_ins').select('client_key, submitted_at, week_number, weight_kg, energy_1to10, sleep_hours, stress_1to10, diet_adherence_1to10, training_adherence_1to10, notes').gte('submitted_at', ninetyAgo),
    admin.from('meal_logs').select('client_id, logged_at, meal_name, kcal, protein_g, carbs_g, fat_g').gte('logged_at', ninetyAgo),
    admin.from('workout_log_entries').select('client_key, logged_at, exercise_name, weight, sets_done, reps_done').gte('logged_at', ninetyAgo),
  ]);
  const per: Record<string, any> = {};
  const ensure = (key: string) => per[key] ??= {
    latestWeight: null, latestWeightTs: null, weightHistory: [],
    latestWorkoutTs: null, workoutsThisWeek: 0,
    latestMealTs: null, mealsToday: 0,
    latestCheckinTs: null, recentMeals: [], recentWorkouts: [], recentCheckIns: [],
  };
  // Build client_id → storage_key map for meal_logs (no client_key column on meal_logs)
  const keyById: Record<string, string> = Object.fromEntries((clients ?? []).map(c => [c.id, c.storage_key]));
  (clients ?? []).forEach(c => ensure(c.storage_key));
  (weights ?? []).forEach(r => {
    const p = ensure(r.client_key);
    p.weightHistory.push({ ts: r.logged_at, kg: r.weight_kg });
    if (!p.latestWeightTs || r.logged_at > p.latestWeightTs) { p.latestWeightTs = r.logged_at; p.latestWeight = r.weight_kg; }
  });
  (checkins ?? []).forEach(r => {
    const p = ensure(r.client_key);
    p.recentCheckIns.push({
      timestamp: r.submitted_at, week: r.week_number, weightKg: r.weight_kg,
      energy1to10: r.energy_1to10, sleepHours: r.sleep_hours, stress1to10: r.stress_1to10,
      dietAdherence1to10: r.diet_adherence_1to10, trainingAdherence1to10: r.training_adherence_1to10,
      notes: r.notes,
    });
    if (!p.latestCheckinTs || r.submitted_at > p.latestCheckinTs) p.latestCheckinTs = r.submitted_at;
  });
  (meals ?? []).forEach(r => {
    const key = keyById[r.client_id] ?? '';
    if (!key) return;
    const p = ensure(key);
    p.recentMeals.push({ timestamp: r.logged_at, name: r.meal_name, cal: r.kcal, p: r.protein_g, c: r.carbs_g, f: r.fat_g });
    if (!p.latestMealTs || r.logged_at > p.latestMealTs) p.latestMealTs = r.logged_at;
    if (r.logged_at.slice(0, 10) === todayStr) p.mealsToday++;
  });
  (workouts ?? []).forEach(r => {
    const p = ensure(r.client_key);
    p.recentWorkouts.push({ timestamp: r.logged_at, exercise: r.exercise_name, weight: r.weight, sets: r.sets_done, reps: r.reps_done });
    if (!p.latestWorkoutTs || r.logged_at > p.latestWorkoutTs) p.latestWorkoutTs = r.logged_at;
    if (r.logged_at >= weekAgo) p.workoutsThisWeek++;
  });
  Object.values(per).forEach((p: any) => {
    p.recentCheckIns  = p.recentCheckIns.slice(-12);
    p.recentMeals     = p.recentMeals.slice(-15);
    p.recentWorkouts  = p.recentWorkouts.slice(-10);
  });
  return ok({ dashboard: per });
}

async function rosterGet(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const { data } = await admin.from('roster_snapshots').select('*').order('snapshot_ts', { ascending: false }).limit(1).single();
  if (!data) return ok({ ts: 0, roster: [] });
  return ok({ ts: new Date(data.snapshot_ts).getTime(), roster: data.roster_json });
}

async function rosterPut(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const roster = body?.roster ?? [];
  await admin.from('roster_snapshots').insert({
    snapshot_ts: new Date(body?.ts ?? Date.now()).toISOString(),
    roster_json: roster,
    client_count: roster.length,
    author: 'coach',
  });
  return ok({ count: roster.length });
}

async function registryGetPrivate(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const { data } = await admin.from('clients')
    .select('id, storage_key, display_name, program_type, start_weight, goal_weight, start_date, program_url, phone');
  return ok({ clients: data ?? [] });
}

async function issueClientToken(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const storageKey = String(body?.storageKey ?? '').toLowerCase();
  if (!storageKey) return err('bad_storageKey');
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const salt  = crypto.randomUUID().replace(/-/g, '');
  const hash  = await sha256(token + salt);
  const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
  if (!client) return err('unknown_client');
  const { error: sessErr } = await admin.from('client_sessions').upsert({
    client_id: client.id, storage_key: storageKey,
    token_hash: hash, salt: salt,
    access_status: 'active', rotation_count: 0,
    last_access_at: null,
  }, { onConflict: 'storage_key' });
  if (sessErr) {
    logEfError('issueClientToken', storageKey, 'session_write_failed', sessErr.message);
    return err('session_write_failed', { detail: sessErr.message });
  }
  await admin.from('access_log').insert({
    client_id: client.id, client_key: storageKey, event: 'issued', source: 'coach',
    reason: body?.reason ?? 'coach_issue', token_hash: hash,
  });
  return ok({ token, storageKey });
}

async function setAccessStatus(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const storageKey = String(body?.storageKey ?? '').toLowerCase();
  const status = String(body?.status ?? body?.accessStatus ?? '').toLowerCase();
  if (!['active','suspended','revoked'].includes(status)) return err('bad_status');
  const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
  if (!client) return err('unknown_client');
  await admin.from('client_sessions').update({
    access_status: status,
    revoked_at: status === 'revoked' ? new Date().toISOString() : null,
    restored_at: status === 'active' ? new Date().toISOString() : null,
  }).eq('storage_key', storageKey);
  await admin.from('access_log').insert({
    client_id: client.id, client_key: storageKey,
    event: status === 'revoked' ? 'revoked' : status === 'suspended' ? 'suspended' : 'restored',
    source: 'coach', reason: body?.reason ?? '',
  });
  return ok({ storageKey, accessStatus: status });
}

async function setClientProgram(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  // Program payload written verbatim into programs table. Coach dashboard
  // handles the multi-table breakdown; this endpoint just persists the JSON.
  const storageKey = String(body?.storageKey ?? '').toLowerCase();
  const program = body?.program ?? {};
  const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
  if (!client) return err('unknown_client');
  // Derive duration_weeks from program payload (coach JSON) or default 0
  const durationWeeks = Number(
    program?.durationWeeks ?? program?.duration_weeks ??
    (Array.isArray(program?.phases) ? Math.max(0, ...program.phases.map((p: any) => Number(p.weeksTo ?? p.weeks_to ?? 0))) : 0)
  ) || 0;
  await admin.from('programs').upsert({
    client_id: client.id, storage_key: storageKey,
    payload: program, duration_weeks: durationWeeks,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'storage_key' });
  return ok({ storageKey });
}

async function clientProgram(body: any) {
  const v = await verifyClientToken(body?.token, body?.storageKey);
  const isCoach = verifyCoachToken(body?.coachToken);
  if (!v.ok && !isCoach) return err(v.reason ?? 'unauthorized');
  const key = String(body?.storageKey ?? body?.client ?? '').toLowerCase();
  const { data } = await admin.from('programs').select('payload').eq('storage_key', key).single();
  if (!data) return err('program_missing');
  return ok({ program: data.payload });
}

async function weightLog(body: any) {
  const v = await verifyClientToken(body?.token, body?.storageKey);
  const isCoach = verifyCoachToken(body?.coachToken);
  if (!v.ok && !isCoach) return err(v.reason ?? 'unauthorized');
  const key = String(body?.client ?? body?.storageKey ?? '').toLowerCase();
  const { data } = await admin.from('weight_logs').select('logged_at, weight_kg, notes').eq('client_key', key).order('logged_at', { ascending: true });
  return json((data ?? []).map(r => ({ timestamp: r.logged_at, weightKg: r.weight_kg, notes: r.notes })));
}

async function photosGet(body: any) {
  const v = await verifyClientToken(body?.token, body?.storageKey);
  const isCoach = verifyCoachToken(body?.coachToken);
  if (!v.ok && !isCoach) return err(v.reason ?? 'unauthorized');
  const key = String(body?.client ?? body?.storageKey ?? '').toLowerCase();
  const { data } = await admin.from('photo_uploads').select('storage_url, view, week, uploaded_at').eq('client_key', key).order('uploaded_at', { ascending: true });
  return ok({ photos: (data ?? []).map(p => ({ url: p.storage_url, view: p.view, week: p.week, ts: p.uploaded_at })) });
}

// G1: Override GET — fixed to use correct client_overrides schema
// (columns: client_id uuid, key text, value_text text, value_number numeric, valid_to timestamptz)
async function overrideGet(body: any) {
  const v = await verifyClientToken(body?.token, body?.storageKey);
  const isCoach = verifyCoachToken(body?.coachToken);
  if (!v.ok && !isCoach) return err(v.reason ?? 'unauthorized');
  const key = String(body?.client ?? body?.storageKey ?? '').toLowerCase();
  const { data: client } = await admin.from('clients').select('id').eq('storage_key', key).single();
  if (!client) return err('unknown_client');
  const { data } = await admin.from('client_overrides')
    .select('key, value_text, value_number')
    .eq('client_id', client.id)
    .is('valid_to', null);
  const keyed: Record<string, any> = {};
  for (const row of (data ?? [])) { keyed[row.key] = row.value_number ?? row.value_text; }
  return ok(keyed);
}

// G1: Override PUT — fixed to use correct client_overrides schema with temporal versioning
async function overridePut(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const storageKey = String(body?.client ?? body?.storageKey ?? '').toLowerCase();
  const overrideKey = String(body?.key ?? '');
  const value = body?.value;
  if (!storageKey || !overrideKey) return err('bad_params');
  const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
  if (!client) return err('unknown_client');
  // Expire any existing active override for this key before inserting the new one
  await admin.from('client_overrides')
    .update({ valid_to: new Date().toISOString() })
    .eq('client_id', client.id)
    .eq('key', overrideKey)
    .is('valid_to', null);
  const isNum = (typeof value === 'number') ||
    (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)));
  const isObj = value !== null && typeof value === 'object';
  const { error: insErr } = await admin.from('client_overrides').insert({
    client_id: client.id,
    key: overrideKey,
    value_text:   isNum ? null : isObj ? JSON.stringify(value) : String(value ?? ''),
    value_number: isNum ? Number(value) : null,
  });
  if (insErr) {
    logEfError('overridePut', storageKey, 'override_write_failed', insErr.message);
    return err('override_write_failed', { detail: insErr.message });
  }
  return ok({ key: overrideKey, storageKey });
}

// G2: Client-authenticated restore endpoint for GET ?type=dashboard.
// Returns a 90-day slice of the client's data in the format the client shell
// expects: { [storageKey]: { recentMeals, recentCheckIns, recentWorkouts, weightHistory } }.
// Meal entries lack week/dayIdx/mealIdx (not stored in DB) — client code skips
// those entries gracefully. Workout entries include phase/dayIdx/exerciseName
// and CAN be used to rebuild the workout log.
async function clientRestoreGet(clientKey: string) {
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString();
  const { data: client } = await admin.from('clients').select('id').eq('storage_key', clientKey).single();
  if (!client) return json({ ok: false, error: 'unknown_client' }, 404);
  const [
    { data: weights },
    { data: checkins },
    { data: meals },
    { data: workouts },
  ] = await Promise.all([
    admin.from('weight_logs')
      .select('logged_at, weight_kg, notes')
      .eq('client_key', clientKey)
      .gte('logged_at', ninetyAgo)
      .order('logged_at', { ascending: false })
      .limit(30),
    admin.from('check_ins')
      .select('submitted_at, week_number, weight_kg, energy_1to10, sleep_hours, stress_1to10, diet_adherence_1to10, training_adherence_1to10, notes')
      .eq('client_key', clientKey)
      .gte('submitted_at', ninetyAgo)
      .order('submitted_at', { ascending: false })
      .limit(20),
    admin.from('meal_logs')
      .select('logged_at, meal_name, notes, kcal, protein_g, carbs_g, fat_g')
      .eq('client_id', client.id)
      .gte('logged_at', ninetyAgo)
      .order('logged_at', { ascending: false })
      .limit(30),
    admin.from('workout_log_entries')
      .select('logged_at, exercise_name, weight, sets_done, reps_done, rpe, notes, phase_key, day_index')
      .eq('client_key', clientKey)
      .gte('logged_at', ninetyAgo)
      .order('logged_at', { ascending: false })
      .limit(30),
  ]);
  return json({
    [clientKey]: {
      recentMeals: (meals ?? []).map(m => ({
        timestamp: m.logged_at,
        mealName: m.meal_name,
        swapDesc: m.notes ?? '',
        cal: m.kcal,     calActual: m.kcal,
        p:   m.protein_g, pActual: m.protein_g,
        c:   m.carbs_g,   cActual: m.carbs_g,
        f:   m.fat_g,     fActual: m.fat_g,
        // week/dayIdx/mealIdx intentionally absent — client restore code skips
        // entries missing these fields (graceful no-op)
      })),
      recentCheckIns: (checkins ?? []).map(r => ({
        timestamp: r.submitted_at, week: r.week_number, weightKg: r.weight_kg,
        energy1to10: r.energy_1to10, sleepHours: r.sleep_hours, stress1to10: r.stress_1to10,
        dietAdherence1to10: r.diet_adherence_1to10,
        trainingAdherence1to10: r.training_adherence_1to10,
        notes: r.notes,
      })),
      recentWorkouts: (workouts ?? []).map(r => ({
        timestamp: r.logged_at,
        exerciseName: r.exercise_name,
        phase: r.phase_key,
        dayIdx: r.day_index,
        weightActual: r.weight,
        setsActual:   r.sets_done,
        repsActual:   r.reps_done,
        rpeActual:    r.rpe,
        notes:        r.notes ?? '',
      })),
      weightHistory: (weights ?? []).map(r => ({ ts: r.logged_at, kg: r.weight_kg })),
    },
  });
}

// Client writes (weight/checkin/meal/workout/photoUpload) with FULL Sprint 6.3
// legacy allow-list parity. If token is valid → write direct. If token missing
// but client is a known active roster entry → capture to legacy_intake_queue
// AND auto-promote (same behavior as v5-secure Sprint 6.3).
async function clientWrite(kind: string, body: any) {
  const v = await verifyClientToken(body?.token, body?.storageKey);
  const storageKey = String((v.ok ? body.storageKey : body?.client) ?? '').toLowerCase();

  if (v.ok) {
    return doWrite(kind, { ...body, client: v.storageKey! });
  }
  // Legacy quarantine path — write to queue AND (if known-active) mirror to canonical table.
  const active = await isKnownActiveRosterKey(storageKey);
  if (['checkin','weight'].includes(kind) && active) {
    const queueRow = await queueInsert(kind, body, v.reason ?? 'unauthorized');
    const canonical = await doWrite(kind, { ...body, client: storageKey }, /*silent=*/true);
    // Mark queue row as promoted
    await admin.from('legacy_intake_queue').update({
      status: 'promoted', promoted_at: new Date().toISOString(),
      promoted_by: 'canary:auto',
      promoted_to_checkin_id: canonical.checkin_id ?? null,
      promoted_to_weight_id:  canonical.weight_id  ?? null,
    }).eq('id', queueRow.id);
  }
  return err(v.reason ?? 'unauthorized'); // same opaque response as Apps Script (mode:no-cors clients don't read it)
}

async function doWrite(kind: string, body: any, silent = false): Promise<any> {
  const key = String(body.client ?? '').toLowerCase();
  const { data: client, error: clientErr } = await admin.from('clients').select('id').eq('storage_key', key).single();
  const clientId = client?.id ?? null;
  if (!clientId) {
    logEfError(kind, key, 'unknown_client_key', clientErr?.message ?? 'no row');
    return err('unknown_client_key', { key, dbError: clientErr?.message });
  }
  if (kind === 'weight' || kind === 'checkin') {
    let weight_id: string | undefined;
    if (body.weightKg) {
      const { data, error: wErr } = await admin.from('weight_logs').insert({
        client_id: clientId, client_key: key, weight_kg: body.weightKg,
        notes: body.notes ?? (kind === 'checkin' ? `check-in wk ${body.week ?? '?'}` : ''),
        logged_at: body.timestamp ?? new Date().toISOString(),
      }).select('id').single();
      if (wErr) {
        logEfError(kind, key, 'weight_log_insert_failed', wErr.message);
        if (!silent) return err('write_failed', { table: 'weight_logs', detail: wErr.message });
      }
      weight_id = data?.id;
    }
    if (kind === 'checkin') {
      const { data, error: cErr } = await admin.from('check_ins').insert({
        client_id: clientId, client_key: key,
        week_number: body.week, weight_kg: body.weightKg,
        energy_1to10: body.energy1to10, sleep_hours: body.sleepHours, stress_1to10: body.stress1to10,
        diet_adherence_1to10: body.dietAdherence1to10,
        training_adherence_1to10: body.trainingAdherence1to10,
        notes: body.notes,
        submitted_at: body.timestamp ?? new Date().toISOString(),
      }).select('id').single();
      if (cErr) {
        logEfError(kind, key, 'check_in_insert_failed', cErr.message);
        if (!silent) return err('write_failed', { table: 'check_ins', detail: cErr.message });
      }
      if (silent) return { checkin_id: data?.id, weight_id };
      return ok({ tab: 'check_ins', id: data?.id, weight_id });
    }
    if (silent) return { weight_id };
    return ok({ tab: 'weight_logs', id: weight_id });
  }
  if (kind === 'meal') {
    const { data, error: mErr } = await admin.from('meal_logs').insert({
      client_id: clientId,
      meal_name: body.mealName ?? body.name ?? '',
      notes:     body.swapDesc ?? body.desc ?? '',
      kcal:      body.calActual ?? body.cal ?? 0,
      protein_g: body.pActual   ?? body.p   ?? 0,
      carbs_g:   body.cActual   ?? body.c   ?? 0,
      fat_g:     body.fActual   ?? body.f   ?? 0,
      logged_at: body.timestamp ?? new Date().toISOString(),
    }).select('id').single();
    if (mErr) logEfError(kind, key, 'meal_log_insert_failed', mErr.message);
    return ok({ tab: 'meal_logs', id: data?.id });
  }
  if (kind === 'workout') {
    const { data, error: wkErr } = await admin.from('workout_log_entries').insert({
      client_id: clientId, client_key: key,
      exercise_name: body.exerciseName ?? body.exercise ?? '',
      phase_key:  body.phase  != null ? String(body.phase)  : null,
      day_index:  body.dayIdx != null ? Number(body.dayIdx) : null,
      weight:     String(body.weightActual ?? body.weight ?? ''),
      reps_done:  String(body.repsActual   ?? body.reps   ?? ''),
      sets_done:  String(body.setsActual   ?? body.sets   ?? ''),
      rpe:        String(body.rpeActual    ?? body.rpe    ?? ''),
      notes:      body.notes ?? '',
      logged_at:  body.timestamp ?? new Date().toISOString(),
    }).select('id').single();
    if (wkErr) logEfError(kind, key, 'workout_insert_failed', wkErr.message);
    if (!wkErr && data?.id && clientId) {
      if (AUTO_PROGRESSION_CANARY.has(key)) {
        // Canary client — run full auto-progression. Errors must not fail the write.
        try { await _autoProgressAfterWorkout(key, clientId, body); }
        catch (autoErr) { logEfError('autoProgress', key, 'auto_progression_failed', String(autoErr)); }
      } else {
        // Non-canary — workout logged, auto-progression intentionally skipped.
        console.info(JSON.stringify({
          tag: 'AUTO_PROG_CANARY_SKIP',
          ts:  new Date().toISOString(),
          client: key,
          exercise: body.exerciseName ?? body.exercise ?? '',
        }));
      }
    }
    return ok({ tab: 'workout_log_entries', id: data?.id });
  }
  if (kind === 'photoUpload') {
    // Upload to storage first, then record the URL.
    const base64 = String(body.base64 ?? '');
    const blob = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const view = String(body.view ?? 'other');
    const ts   = (body.timestamp ?? new Date().toISOString()).replace(/[:.]/g, '-');
    const path = `${key}/wk${body.week ?? 0}/${view}-${ts}.jpg`;
    const { error: upErr } = await admin.storage.from('client-photos').upload(path, blob, { contentType: body.mimeType ?? 'image/jpeg', upsert: true });
    if (upErr) {
      logEfError('photoUpload', key, 'storage_upload_failed', upErr.message);
      return err('storage_upload_failed', { detail: upErr.message });
    }
    const { data: pub } = admin.storage.from('client-photos').getPublicUrl(path);
    const { data } = await admin.from('photo_uploads').insert({
      client_id: clientId, client_key: key, week: body.week, view,
      mime_type: body.mimeType ?? 'image/jpeg', bytes_size: blob.byteLength,
      storage_url: pub.publicUrl, storage_path: path,
      uploaded_at: body.timestamp ?? new Date().toISOString(),
    }).select('id').single();
    return ok({ tab: 'photo_uploads', id: data?.id, url: pub.publicUrl });
  }
  return err('unknown_write_kind');
}

async function queueInsert(kind: string, body: any, reason: string): Promise<any> {
  const { data } = await admin.from('legacy_intake_queue').insert({
    client_key: String(body.client ?? '').toLowerCase(),
    type: kind,
    week: body.week, weight_kg: body.weightKg,
    energy_1to10: body.energy1to10, sleep_hours: body.sleepHours, stress_1to10: body.stress1to10,
    diet_adh_1to10: body.dietAdherence1to10, train_adh_1to10: body.trainingAdherence1to10,
    notes: body.notes, reason,
    received_at: body.timestamp ?? new Date().toISOString(),
    raw_body_json: body,
  }).select('id').single();
  return data ?? { id: null };
}

async function isKnownActiveRosterKey(key: string): Promise<boolean> {
  const { data } = await admin.from('roster_snapshots').select('roster_json').order('snapshot_ts', { ascending: false }).limit(1).single();
  const roster = (data?.roster_json ?? []) as any[];
  return roster.some((c) => String(c.storageKey).toLowerCase() === key && String(c.accessStatus ?? '').toLowerCase() === 'active');
}

async function intake(body: any) {
  const { data } = await admin.from('intakes').insert({
    ...body, submitted_at: new Date().toISOString(),
  }).select('id, storage_key').single();
  return ok({ tab: 'intakes', storageKey: data?.storage_key ?? '' });
}

async function legacyQueueGet(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const { data } = await admin.from('legacy_intake_queue').select('*').order('received_at', { ascending: false });
  const counts = { pending: 0, promoted: 0, rejected: 0 };
  (data ?? []).forEach((r: any) => { counts[r.status as keyof typeof counts] = (counts[r.status as keyof typeof counts] ?? 0) + 1; });
  return ok({ rows: data ?? [], counts });
}

async function legacyQueuePromote(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const { data: row } = await admin.from('legacy_intake_queue').select('*').eq('id', body.id).single();
  if (!row) return err('not_found');
  if (row.status !== 'pending') return err('already_processed');
  const overrideClient = String(body?.overrideClient ?? row.client_key).toLowerCase();
  const canonical = await doWrite(row.type, { ...row, client: overrideClient, timestamp: row.received_at }, true);
  await admin.from('legacy_intake_queue').update({
    status: 'promoted', promoted_at: new Date().toISOString(),
    promoted_by: body?.promotedBy ?? 'coach', resolved_client_id: null,
    promoted_to_checkin_id: canonical.checkin_id ?? null,
    promoted_to_weight_id:  canonical.weight_id  ?? null,
  }).eq('id', body.id);
  return ok({ promotedTo: row.type === 'checkin' ? 'check_ins' : 'weight_logs', client: overrideClient });
}

async function legacyQueueReject(body: any) {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  await admin.from('legacy_intake_queue').update({
    status: 'rejected', promoted_at: new Date().toISOString(), promoted_by: body?.rejectedBy ?? 'coach',
  }).eq('id', body.id);
  return ok();
}

// ============================================================================
// WORKOUT PROGRESSION ENGINE
// Double-progression model: accumulate reps within range, then increase load.
// All decisions are deterministic and explainable. Coach override always wins.
// ============================================================================

type WeightParsed = { value: number | null; qualifier: 'absolute' | 'per_hand' | 'bodyweight' | 'bw_plus' | 'unparseable' | 'empty' };
type RepRange     = { min: number; max: number };
type Decision     = 'PROGRESS_LOAD' | 'HOLD_LOAD' | 'INSUFFICIENT_DATA' | 'FLAG_FOR_REVIEW' | 'NO_DATA';

interface ProgressionResult {
  decision:    Decision;
  anchor:      number | null;
  nextLoad:    number | null;
  nextLoadStr: string | null;
  nextSets:    number | null;
  nextReps:    string | null;
  reason:      string;
}

function _parseWeightNum(s: string): WeightParsed {
  if (!s || !s.trim()) return { value: null, qualifier: 'empty' };
  const lower = s.toLowerCase().trim();
  if (lower === 'bw' || lower === 'bodyweight' || lower === 'body weight') return { value: null, qualifier: 'bodyweight' };
  // BW+Xkg (added load)
  const bwPlus = lower.match(/^bw\s*\+\s*([\d.]+)/);
  if (bwPlus) return { value: parseFloat(bwPlus[1]), qualifier: 'bw_plus' };
  // Per-hand: "36kg ea", "36 each", "36 per hand"
  const ea = lower.match(/^([\d.]+)\s*(?:kg|lb)?\s*(?:ea|each|per\s*hand)$/);
  if (ea) return { value: parseFloat(ea[1]), qualifier: 'per_hand' };
  // Standard: "90kg", "90.5 kg", "90"
  const num = lower.match(/^([\d.]+)/);
  if (num) return { value: parseFloat(num[1]), qualifier: 'absolute' };
  return { value: null, qualifier: 'unparseable' };
}

function _parseRepRange(s: string): RepRange | null {
  if (!s) return null;
  const clean = s.replace(/[–—]/g, '-').trim();
  const range = clean.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return { min: parseInt(range[1]), max: parseInt(range[2]) };
  const single = clean.match(/^(\d+)$/);
  if (single) { const n = parseInt(single[1]); return { min: n, max: n }; }
  return null;
}

function _parseActualReps(s: string): number[] {
  if (!s) return [];
  const clean = s.trim();
  // Slash-separated: "10/9/8"
  if (clean.includes('/')) {
    const nums = clean.split('/').map(x => parseInt(x.trim())).filter(n => !isNaN(n));
    if (nums.length > 0) return nums;
  }
  // Space-separated: "10 9 8"
  const parts = clean.split(/\s+/);
  if (parts.length > 1) {
    const nums = parts.map(x => parseInt(x)).filter(n => !isNaN(n));
    if (nums.length > 1) return nums;
  }
  // Single value
  const n = parseInt(clean);
  return isNaN(n) ? [] : [n];
}

function _parseSets(s: string): number {
  if (!s) return 0;
  // Handle "3-4" range — use min (conservative)
  const range = s.trim().match(/^(\d+)\s*-\s*\d+$/);
  if (range) return parseInt(range[1]);
  const n = parseInt(s.trim());
  return isNaN(n) ? 0 : n;
}

// Conservative load increment: ~2-5%, rounded to nearest practical gym increment.
function _nextLoadValue(load: number, qualifier: WeightParsed['qualifier']): number {
  if (qualifier === 'per_hand') {
    // Dumbbell: smallest standard increment is 2 kg per dumbbell
    return Math.round((load + 2) * 10) / 10;
  }
  // Barbell / machine: aim for 2-5% increase, minimum 2.5 kg
  const pct3 = load * 0.03;
  const increment = Math.max(2.5, Math.round(pct3 / 2.5) * 2.5);
  const capped    = Math.min(increment, Math.max(2.5, Math.round(load * 0.05 / 2.5) * 2.5));
  return Math.round((load + capped) * 10) / 10;
}

function _fmtLoad(value: number, qualifier: WeightParsed['qualifier']): string {
  const str = value % 1 === 0 ? String(value) : String(value);
  return qualifier === 'per_hand' ? `${str}kg ea` : `${str}kg`;
}

function _decideProgression(params: {
  exerciseName:   string;
  prescribedSets?: number;
  repRange?:       RepRange;
  prescribedLoad?: number;
  actualWeight:    WeightParsed;
  actualSets:      number;
  actualReps:      number[];
  actualRpe?:      number | null;
}): ProgressionResult {
  const { prescribedSets, repRange, prescribedLoad, actualWeight, actualSets, actualReps, actualRpe } = params;

  // No data at all
  if (actualReps.length === 0 || actualSets === 0) {
    return { decision: 'NO_DATA', anchor: null, nextLoad: null, nextLoadStr: null, nextSets: null, nextReps: null,
      reason: 'No workout log found for this exercise.' };
  }

  // Bodyweight-based — can't auto-increment load
  if (actualWeight.qualifier === 'bodyweight') {
    return { decision: 'FLAG_FOR_REVIEW', anchor: null, nextLoad: null, nextLoadStr: null,
      nextSets: prescribedSets ?? actualSets, nextReps: repRange ? `${repRange.min}–${repRange.max}` : null,
      reason: 'Bodyweight exercise — coach sets progression manually.' };
  }
  if (actualWeight.qualifier === 'bw_plus') {
    const v = actualWeight.value!;
    return { decision: 'FLAG_FOR_REVIEW', anchor: v, nextLoad: null, nextLoadStr: null,
      nextSets: prescribedSets ?? actualSets, nextReps: repRange ? `${repRange.min}–${repRange.max}` : null,
      reason: 'BW+load exercise — coach sets added-load increment manually.' };
  }
  if (actualWeight.qualifier === 'unparseable' || actualWeight.value === null) {
    return { decision: 'FLAG_FOR_REVIEW', anchor: null, nextLoad: null, nextLoadStr: null, nextSets: null, nextReps: null,
      reason: `Could not parse weight value — coach review required.` };
  }

  const load     = actualWeight.value;
  const setsDone = actualSets;
  const reqSets  = prescribedSets ?? setsDone; // if no prescription, use what was logged

  // Downgrade protection: if actual load is materially below the effective prescription,
  // flag for coach review and retain the prescription. Threshold: < 97% of prescribed.
  // Prevents auto-progressing from a self-selected lighter weight that the coach never approved.
  if (prescribedLoad !== undefined && load < prescribedLoad * 0.97) {
    return { decision: 'FLAG_FOR_REVIEW',
      anchor: prescribedLoad, nextLoad: prescribedLoad,
      nextLoadStr: _fmtLoad(prescribedLoad, actualWeight.qualifier),
      nextSets: reqSets, nextReps: repRange ? `${repRange.min}–${repRange.max}` : null,
      reason: `Actual load ${_fmtLoad(load, actualWeight.qualifier)} is materially below the ` +
              `${_fmtLoad(prescribedLoad, actualWeight.qualifier)} prescription. ` +
              `Retaining ${_fmtLoad(prescribedLoad, actualWeight.qualifier)} — coach must approve a reset to run progression from actual.`,
    };
  }

  // Insufficient sets gate (section 15/Case E)
  if (reqSets > 0 && setsDone < reqSets) {
    return { decision: 'INSUFFICIENT_DATA', anchor: load, nextLoad: load,
      nextLoadStr: _fmtLoad(load, actualWeight.qualifier),
      nextSets: reqSets, nextReps: repRange ? `${repRange.min}–${repRange.max}` : null,
      reason: `Only ${setsDone}/${reqSets} required sets logged. No progression — carry forward.` };
  }

  // Without a rep range we can hold but not auto-progress
  if (!repRange) {
    return { decision: 'HOLD_LOAD', anchor: load, nextLoad: load,
      nextLoadStr: _fmtLoad(load, actualWeight.qualifier),
      nextSets: reqSets, nextReps: null,
      reason: 'No rep range specified. Holding load. Provide rep range to enable auto-progression.' };
  }

  // Normalise per-set reps: single logged value → apply to all sets
  const repsPerSet = actualReps.length === 1
    ? new Array<number>(setsDone).fill(actualReps[0])
    : actualReps;
  const minReps = Math.min(...repsPerSet);
  const allSetsAtTop  = repsPerSet.every(r => r >= repRange.max);
  const allSetsInRange = repsPerSet.every(r => r >= repRange.min);

  // RPE failure gate (section 6): top-of-range at RPE ≥ 9.5 → hold
  const atFailure = actualRpe != null && !isNaN(actualRpe) && actualRpe >= 9.5;

  // Reps below minimum → failed or bad overshoot (sections 4D, 15, 16)
  if (minReps < repRange.min) {
    const wasOvershoot = prescribedLoad !== undefined && load > prescribedLoad * 1.02;
    if (wasOvershoot) {
      return { decision: 'FLAG_FOR_REVIEW', anchor: prescribedLoad!, nextLoad: prescribedLoad!,
        nextLoadStr: _fmtLoad(prescribedLoad!, actualWeight.qualifier),
        nextSets: reqSets, nextReps: `${repRange.min}–${repRange.max}`,
        reason: `Overshoot not earned: logged ${load}kg (prescribed ${prescribedLoad}kg) but reps fell to ${minReps} ` +
                `(minimum: ${repRange.min}). Reverting anchor to last valid prescription ${prescribedLoad}kg.` };
    }
    return { decision: 'FLAG_FOR_REVIEW', anchor: load, nextLoad: load,
      nextLoadStr: _fmtLoad(load, actualWeight.qualifier),
      nextSets: reqSets, nextReps: `${repRange.min}–${repRange.max}`,
      reason: `Reps fell to ${minReps} (minimum: ${repRange.min}). Do not progress. Coach review recommended.` };
  }

  // Case A / section 5: all sets at top of range, no failure → PROGRESS (section 2 overshoot anchor)
  if (allSetsAtTop && !atFailure) {
    const anchor      = load; // validated actual IS the new anchor (section 2)
    const next        = _nextLoadValue(anchor, actualWeight.qualifier);
    const nextStr     = _fmtLoad(next, actualWeight.qualifier);
    const overshootNote = (prescribedLoad !== undefined && load > prescribedLoad * 1.02)
      ? ` Overshoot validated: client performed ${load}kg vs prescribed ${prescribedLoad}kg — new anchor is ${anchor}kg.`
      : '';
    return { decision: 'PROGRESS_LOAD', anchor, nextLoad: next, nextLoadStr: nextStr,
      nextSets: reqSets, nextReps: `${repRange.min}–${repRange.max}`,
      reason: `All ${setsDone} sets at top of rep range (${repRange.max}).${overshootNote} ` +
              `Load increases: ${anchor}kg → ${next}kg. Sets (${reqSets}) and rep range (${repRange.min}–${repRange.max}) unchanged.` };
  }

  // Top reached but near failure → hold conservatively (section 6)
  if (allSetsAtTop && atFailure) {
    return { decision: 'HOLD_LOAD', anchor: load, nextLoad: load,
      nextLoadStr: _fmtLoad(load, actualWeight.qualifier),
      nextSets: reqSets, nextReps: `${repRange.min}–${repRange.max}`,
      reason: `All sets reached top of rep range but RPE ${actualRpe} indicates near-failure. ` +
              `Holding ${load}kg — avoid routine failure accumulation (section 6).` };
  }

  // Cases B/C: all sets in range, some below top → hold, accumulate reps
  if (allSetsInRange) {
    return { decision: 'HOLD_LOAD', anchor: load, nextLoad: load,
      nextLoadStr: _fmtLoad(load, actualWeight.qualifier),
      nextSets: reqSets, nextReps: `${repRange.min}–${repRange.max}`,
      reason: `Sets complete (${repsPerSet.join('/')} reps) — all within range but not all at top (${repRange.max}). ` +
              `Holding ${load}kg. Build reps within ${repRange.min}–${repRange.max} before progressing.` };
  }

  // Shouldn't reach here given the minReps < repRange.min check above
  return { decision: 'FLAG_FOR_REVIEW', anchor: load, nextLoad: load,
    nextLoadStr: _fmtLoad(load, actualWeight.qualifier),
    nextSets: reqSets, nextReps: `${repRange.min}–${repRange.max}`,
    reason: 'Unexpected performance pattern — coach review recommended.' };
}

async function progressionCompute(body: any): Promise<Response> {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const storageKey = String(body?.storageKey ?? '').toLowerCase();
  if (!storageKey) return err('bad_params', { detail: 'storageKey required' });

  // Fetch recent workout logs (last 90 days, up to 300 rows to cover all exercises)
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString();
  const [{ data: logs, error: logsErr }, { data: progData }] = await Promise.all([
    admin.from('workout_log_entries')
      .select('logged_at, exercise_name, weight, sets_done, reps_done, rpe, phase_key, day_index')
      .eq('client_key', storageKey)
      .gte('logged_at', ninetyAgo)
      .order('logged_at', { ascending: false })
      .limit(300),
    admin.from('programs').select('payload').eq('storage_key', storageKey).single(),
  ]);

  if (logsErr) { logEfError('progressionCompute', storageKey, 'db_error', logsErr.message); return err('db_error'); }
  if (!logs || logs.length === 0) return ok({ decisions: [], note: 'No workout logs in the last 90 days.' });

  // Most recent log entry per exercise (already in desc order)
  const latestByEx: Record<string, typeof logs[0]> = {};
  for (const log of logs) {
    const k = (log.exercise_name ?? '').trim();
    if (k && !latestByEx[k]) latestByEx[k] = log;
  }

  // Auto-build prescription map from authored program (phases[phase_key].days[day_index])
  const programPhases: any = progData?.payload?.phases ?? {};
  const programRxMap: Record<string, { sets?: string; repRange?: string; load?: string }> = {};
  for (const [exName, log] of Object.entries(latestByEx)) {
    const phKey = String(log.phase_key ?? '');
    const dayIdx = Number(log.day_index ?? -1);
    if (!phKey || dayIdx < 0) continue;
    const phase = programPhases[phKey];
    if (!phase || !Array.isArray(phase.days)) continue;
    const day = phase.days[dayIdx];
    if (!day || !Array.isArray(day.exercises)) continue;
    const progEx = day.exercises.find((ex: any) =>
      String(ex.name ?? '').toLowerCase() === exName.toLowerCase()
    );
    if (!progEx) continue;
    programRxMap[exName] = {
      sets:     progEx.sets  ? String(progEx.sets)   : undefined,
      repRange: progEx.reps  ? String(progEx.reps)   : undefined,
      load:     progEx.weight ? String(progEx.weight) : undefined,
    };
  }

  // Coach-supplied exercises overlay takes priority over auto-sourced program values
  const coachRxMap: Record<string, { sets?: string; repRange?: string; load?: string }> = {};
  if (Array.isArray(body.exercises)) {
    for (const ex of body.exercises) {
      if (ex.name) coachRxMap[String(ex.name)] = ex;
    }
  }

  const decisions = Object.entries(latestByEx).map(([exName, log]) => {
    const rx = { ...(programRxMap[exName] ?? {}), ...(coachRxMap[exName] ?? {}) };
    const actualWeight = _parseWeightNum(log.weight ?? '');
    const actualSets   = _parseSets(log.sets_done ?? '');
    const actualReps   = _parseActualReps(log.reps_done ?? '');
    const actualRpe    = log.rpe ? parseFloat(log.rpe) : null;
    const repRange     = rx.repRange ? _parseRepRange(rx.repRange) ?? undefined : undefined;
    const prescribedSets = rx.sets ? _parseSets(rx.sets) : undefined;
    const prescribedLoad = rx.load ? parseFloat(rx.load) : undefined;

    const result = _decideProgression({
      exerciseName: exName,
      prescribedSets,
      repRange,
      prescribedLoad: (prescribedLoad != null && !isNaN(prescribedLoad)) ? prescribedLoad : undefined,
      actualWeight,
      actualSets,
      actualReps,
      actualRpe: (actualRpe != null && !isNaN(actualRpe)) ? actualRpe : null,
    });

    return {
      exerciseName: exName,
      phase:        log.phase_key,
      dayIdx:       log.day_index,
      lastLogged:   log.logged_at,
      actual:       { weight: log.weight, sets: log.sets_done, reps: log.reps_done, rpe: log.rpe },
      prescribed:   Object.keys(rx).length ? rx : null,
      rxSource:     coachRxMap[exName] ? 'coach' : programRxMap[exName] ? 'program' : 'none',
      ...result,
    };
  });

  return ok({ decisions, storageKey, computedAt: new Date().toISOString() });
}

// ── Shared day-level apply logic ──────────────────────────────────────────
// Used by both progressionApply (coach-triggered) and _autoProgressAfterWorkout.
// Returns { applied: true } on success, { applied: false, skipped: reason } otherwise.
// Throws on DB write failure — callers must catch.
async function _applyDayDecisions(
  clientId: string,
  dayKey: string,
  dayDecisions: any[],
  programPhases: any,
  externalExercises?: any[] | null,
): Promise<{ applied: boolean; skipped?: string }> {
  const pgMarkerKey = `${dayKey}._pg`;
  const now = new Date().toISOString();

  const [{ data: existingOverride }, { data: pgMarker }] = await Promise.all([
    admin.from('client_overrides').select('value_text').eq('client_id', clientId)
      .eq('key', dayKey).is('valid_to', null).maybeSingle(),
    admin.from('client_overrides').select('key').eq('client_id', clientId)
      .eq('key', pgMarkerKey).is('valid_to', null).maybeSingle(),
  ]);

  // Coach-override protection: active override with no _pg marker → coach-written → skip
  if (existingOverride && !pgMarker) {
    return { applied: false, skipped: `${dayKey}: coach-authored override protected — clear it manually to enable auto-progression` };
  }

  // Resolve exercise array: caller-supplied → existing progression override → authored program
  let exercises: any[] | null = externalExercises ?? null;
  if (!exercises && existingOverride?.value_text) {
    try { exercises = JSON.parse(existingOverride.value_text); } catch { /* leave null */ }
  }
  if (!exercises) {
    const m = dayKey.match(/^p(\d+(?:\.\d+)?)\.d(\d+)$/);
    if (m) {
      const phase = programPhases[m[1]];
      if (phase && Array.isArray(phase.days) && phase.days[parseInt(m[2])]) {
        exercises = phase.days[parseInt(m[2])].exercises ?? null;
        if (exercises) exercises = exercises.map((e: any) => ({ ...e }));
      }
    }
  }
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return { applied: false, skipped: `${dayKey}: no exercise array — not in program, no override, not in request` };
  }

  let changed = false;
  const misses: string[] = [];
  for (const d of dayDecisions) {
    const idx = exercises.findIndex((ex: any) =>
      String(ex.name ?? '').toLowerCase() === String(d.exerciseName ?? '').toLowerCase()
    );
    if (idx === -1) { misses.push(`${d.exerciseName}: not found`); continue; }

    if (d.decision === 'HOLD_LOAD') {
      if (!d.nextLoadStr || d.nextLoad == null) continue;
      const cur = _parseWeightNum(String(exercises[idx].weight ?? ''));
      if (cur.value !== null && d.nextLoad <= cur.value) continue; // no carry-forward needed
      exercises[idx] = { ...exercises[idx], weight: d.nextLoadStr };
      changed = true;
    } else {
      // PROGRESS_LOAD
      if (d.nextLoadStr) { exercises[idx] = { ...exercises[idx], weight: d.nextLoadStr }; changed = true; }
      if (d.nextSets != null) { exercises[idx] = { ...exercises[idx], sets: String(d.nextSets) }; changed = true; }
      if (d.nextReps) { exercises[idx] = { ...exercises[idx], reps: d.nextReps }; changed = true; }
    }
  }

  if (!changed) return { applied: false, skipped: misses.join('; ') || undefined };

  // Expire old override + _pg marker, then write new pair
  await Promise.all([
    admin.from('client_overrides').update({ valid_to: now }).eq('client_id', clientId).eq('key', dayKey).is('valid_to', null),
    admin.from('client_overrides').update({ valid_to: now }).eq('client_id', clientId).eq('key', pgMarkerKey).is('valid_to', null),
  ]);
  const [{ error: insErr }] = await Promise.all([
    admin.from('client_overrides').insert({ client_id: clientId, key: dayKey, value_text: JSON.stringify(exercises), value_number: null }),
    admin.from('client_overrides').insert({ client_id: clientId, key: pgMarkerKey, value_text: '1', value_number: null }),
  ]);
  if (insErr) throw new Error(`override_write_failed: ${insErr.message}`);
  return { applied: true };
}

async function progressionApply(body: any): Promise<Response> {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const storageKey = String(body?.storageKey ?? '').toLowerCase();
  const decisions: any[] = Array.isArray(body.decisions) ? body.decisions : [];
  const currentExercises: Record<string, any[]> = body.currentExercises ?? {};

  if (!storageKey || decisions.length === 0) return err('bad_params');

  const [{ data: client }, { data: progData }] = await Promise.all([
    admin.from('clients').select('id').eq('storage_key', storageKey).single(),
    admin.from('programs').select('payload').eq('storage_key', storageKey).single(),
  ]);
  if (!client) return err('unknown_client');

  const programPhases: any = progData?.payload?.phases ?? {};

  const byDay: Record<string, any[]> = {};
  for (const d of decisions) {
    if (d.decision !== 'PROGRESS_LOAD' && d.decision !== 'HOLD_LOAD') continue;
    const dayKey = `p${d.phase}.d${d.dayIdx}`;
    (byDay[dayKey] = byDay[dayKey] ?? []).push(d);
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [dayKey, dayDecisions] of Object.entries(byDay)) {
    try {
      const r = await _applyDayDecisions(client.id, dayKey, dayDecisions, programPhases, currentExercises[dayKey] ?? null);
      if (r.applied) applied.push(dayKey);
      else if (r.skipped) skipped.push(r.skipped);
    } catch (e) {
      logEfError('progressionApply', storageKey, 'override_write_failed', String(e));
      skipped.push(`${dayKey}: ${String(e).slice(0, 100)}`);
    }
  }

  return ok({ applied, skipped, storageKey });
}

// ── Auto-progression helpers ───────────────────────────────────────────────

// Normalize exercise name to a key safe for use in client_overrides key field.
function _normExKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Called after every successful workout_log_entries insert.
// Evaluates the single exercise that was just logged and, when the decision is
// PROGRESS_LOAD or HOLD_LOAD (carry-forward), writes the override immediately.
// All errors are bubbled to the caller which catches and logs — never fails the write.
async function _autoProgressAfterWorkout(key: string, clientId: string, body: any): Promise<void> {
  const exName  = String(body.exerciseName ?? body.exercise ?? '').trim();
  const phase   = body.phase  != null ? String(body.phase)  : null;
  const dayIdx  = body.dayIdx != null ? Number(body.dayIdx) : null;
  if (!exName || phase == null || dayIdx == null || isNaN(dayIdx)) return;

  const normEx   = _normExKey(exName);
  const dateStr  = (body.timestamp ?? new Date().toISOString()).slice(0, 10);
  const weight   = String(body.weightActual ?? body.weight ?? '');
  const repsDone = String(body.repsActual   ?? body.reps   ?? '');
  const setsDone = String(body.setsActual   ?? body.sets   ?? '');
  const rpe      = String(body.rpeActual    ?? body.rpe    ?? '');

  // Content fingerprint — same data on the same day → already handled, skip.
  const fingerprint = `${weight}:${repsDone}:${setsDone}:${phase}:${dayIdx}:${dateStr}`;
  const doneKey = `_pg_done.${normEx}`;
  const histKey = `_pg_hist.${normEx}`;

  const { data: existingDone } = await admin.from('client_overrides')
    .select('value_text').eq('client_id', clientId).eq('key', doneKey).is('valid_to', null).maybeSingle();
  if (existingDone?.value_text === fingerprint) return; // idempotent — already applied

  // Look up prescription from authored program
  const { data: progData } = await admin.from('programs').select('payload').eq('storage_key', key).single();
  const programPhases: any = progData?.payload?.phases ?? {};
  let rx: { sets?: string; repRange?: string; load?: string } = {};
  const phaseData = programPhases[phase];
  if (phaseData && Array.isArray(phaseData.days)) {
    const day = phaseData.days[dayIdx];
    if (day && Array.isArray(day.exercises)) {
      const progEx = day.exercises.find((ex: any) => String(ex.name ?? '').toLowerCase() === exName.toLowerCase());
      if (progEx) rx = {
        sets:     progEx.sets   ? String(progEx.sets)   : undefined,
        repRange: progEx.reps   ? String(progEx.reps)   : undefined,
        load:     progEx.weight ? String(progEx.weight) : undefined,
      };
    }
  }

  // Run the decision engine
  const actualWeight      = _parseWeightNum(weight);
  const actualSets        = _parseSets(setsDone);
  const actualReps        = _parseActualReps(repsDone);
  const rpeNum            = rpe ? parseFloat(rpe) : null;
  const repRange          = rx.repRange ? _parseRepRange(rx.repRange) ?? undefined : undefined;
  const prescribedSets    = rx.sets  ? _parseSets(rx.sets)  : undefined;
  const prescribedLoadRaw = rx.load  ? parseFloat(rx.load)  : undefined;
  const prescribedLoad    = (prescribedLoadRaw != null && !isNaN(prescribedLoadRaw)) ? prescribedLoadRaw : undefined;

  const result = _decideProgression({
    exerciseName: exName, prescribedSets, repRange, prescribedLoad,
    actualWeight, actualSets, actualReps,
    actualRpe: (rpeNum != null && !isNaN(rpeNum)) ? rpeNum : null,
  });

  const dayKey = `p${phase}.d${dayIdx}`;
  const now    = new Date().toISOString();

  // Only PROGRESS_LOAD and HOLD_LOAD are auto-applied.
  // FLAG_FOR_REVIEW / INSUFFICIENT_DATA / NO_DATA are recorded in history but not applied.
  let applyResult: { applied: boolean; skipped?: string } = { applied: false };
  if (result.decision === 'PROGRESS_LOAD' || result.decision === 'HOLD_LOAD') {
    try {
      applyResult = await _applyDayDecisions(clientId, dayKey, [{ exerciseName: exName, ...result }], programPhases);
    } catch (applyErr) {
      logEfError('autoProgress', key, 'apply_failed', String(applyErr));
      applyResult = { applied: false, skipped: String(applyErr).slice(0, 120) };
    }
  }

  // Write idempotency record (expire old, insert current fingerprint)
  await admin.from('client_overrides').update({ valid_to: now })
    .eq('client_id', clientId).eq('key', doneKey).is('valid_to', null);
  await admin.from('client_overrides').insert({
    client_id: clientId, key: doneKey, value_text: fingerprint, value_number: null,
  });

  // Append event to rolling audit history (last 20 per exercise)
  const histEvent = {
    ts: now, exerciseName: exName,
    decision: result.decision, reason: result.reason,
    prevLoad: rx.load ?? null,
    nextLoad: result.nextLoadStr, nextReps: result.nextReps, nextSets: result.nextSets,
    applied: applyResult.applied, skippedReason: applyResult.skipped ?? null,
    fingerprint,
  };
  const { data: histRow } = await admin.from('client_overrides')
    .select('value_text').eq('client_id', clientId).eq('key', histKey).is('valid_to', null).maybeSingle();
  let histArr: any[] = [];
  if (histRow?.value_text) { try { histArr = JSON.parse(histRow.value_text); } catch { histArr = []; } }
  histArr = [histEvent, ...histArr].slice(0, 20);
  await admin.from('client_overrides').update({ valid_to: now })
    .eq('client_id', clientId).eq('key', histKey).is('valid_to', null);
  await admin.from('client_overrides').insert({
    client_id: clientId, key: histKey, value_text: JSON.stringify(histArr), value_number: null,
  });
}

// Coach-auth endpoint: returns the auto-progression audit log for a client.
// Reads _pg_hist.{normEx} keys from client_overrides (valid_to IS NULL only).
async function progressionHistory(body: any): Promise<Response> {
  if (!verifyCoachToken(body?.coachToken)) return err('unauthorized');
  const storageKey = String(body?.storageKey ?? '').toLowerCase();
  if (!storageKey) return err('bad_params', { detail: 'storageKey required' });

  const { data: client } = await admin.from('clients').select('id').eq('storage_key', storageKey).single();
  if (!client) return err('unknown_client');

  const { data: rows } = await admin.from('client_overrides')
    .select('key, value_text')
    .eq('client_id', client.id)
    .like('key', '_pg_hist.%')
    .is('valid_to', null);

  const history: Record<string, any[]> = {};
  for (const row of (rows ?? [])) {
    const exKey = row.key.slice('_pg_hist.'.length);
    try { history[exKey] = JSON.parse(row.value_text ?? '[]'); } catch { history[exKey] = []; }
  }

  return ok({ history, storageKey });
}
