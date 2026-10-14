// Fake coach-dashboard backend data for tests/coach_ui.test.js. Every name, phone and email here is MADE UP.
// Shapes mirror supabase/functions/api/index.ts exactly (dashboard(), rosterGet(), checkinDraftsGet(), healthGet(),
// accountList(), intakeList(), coachWorkoutCompletions(), clientProgram(), weightLog(), photosGet(), progressionHistory())
// and supabase/functions/push/handler.ts coachPushStatus(). All dates are relative to `now`, so the fixture never ages.
//
// Each client is built to land on ONE specific Today-queue source (see EXPECT below):
//   marcus  red attention (quiet 10 d, +2 kg on a cut)        -> attn      -> Review  (review modal)
//   priya   new check-in + unsent reply draft + PR today       -> checkin   -> Review  (check-in review)
//   tomasz  reviewed check-in + unsent reply draft             -> reply     -> Send reply (check-in review)
//   isla    new check-in, poor sleep / high stress, no draft   -> checkin
//   nadia   reply sent 30 h ago, nothing from her since        -> noreply   -> Nudge   (client page)
//   ravi    reply sent 5 h ago, nothing since                  -> "Waiting on client" row; Apple Health sync stopped
//   jonah   16-wk block, week 15, unsent journey draft         -> journey   -> Message (journey side panel)
//   sofia   16-wk block, week 18 (finished, no next block)     -> finished  -> Offer   (drafted Block 2 call message)
//   kwame   16-wk block, week 5, Apple Health live, PR 3 d ago -> unlock    -> Send code
//   felix   coach task due today                               -> task      -> Do it
//   elena   client page 404 + pre-rollout check-in             -> broken    -> Open
//   leila   week 8 of 12, check-in overdue 16 d               -> attention / unlocknext
//   amara   gone quiet 5 days                                  -> quiet (Coming up)
//   ben     week 2, daily logs, reviewed yesterday             -> on track
//   owen    inactive 20 days                                   -> inactive footer
//   hana    onboarding (starts in 3 days, Apple Health link pending, linked intake)
//   diego   paused         grace   archived
'use strict';

const DAY = 86400000, HOUR = 3600000;

function build(now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const hAgo = (h) => iso(now - h * HOUR);
  const dAgo = (d, hourOfDay) => {          // a time d days ago (optionally at a fixed Sydney-ish hour offset)
    const t = now - d * DAY;
    if (hourOfDay == null) return iso(t);
    const x = new Date(t); x.setUTCHours(hourOfDay, 0, 0, 0);
    return iso(Math.min(x.getTime(), t));                                  // never later than d days ago
  };
  const sydDay = (d) => new Date(now - d * DAY).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const startForWeek = (w) => sydDay(7 * (w - 1) + 3);   // the page's weekOf(): floor(days/7)+1 == w

  // ── roster (coach_clients_v1 / rosterGet) ──
  const R = [];
  const reviewed = (d) => ({ lastMeaningfulCoachReview: dAgo(d), coachReviewHistory: [{ ts: dAgo(d), type: 'review_marked_complete', note: 'Weekly review', source: 'coach', outcome: 'no_change' }] });
  const client = (o) => {
    const c = Object.assign({
      programStatus: 'active', isPaused: false, accessStatus: 'active', durationWeeks: 12, phaseCount: 3, checkInDay: 'Sunday',
      programUrl: 'clients/' + o.storageKey + '/', email: o.storageKey + '@example.test', kcal: 2200, p: 160, c: 220, f: 70, steps: 9000,
    }, reviewed(2), o);
    R.push(c); return c;
  };
  client({ storageKey: 'marcus_vell', displayName: 'Marcus Vell', programType: 'Fat Loss', programGoal: 'fat_loss', startWeight: 92, goalWeight: 84, startDate: startForWeek(7), phone: '+61400000101' });
  client({ storageKey: 'priya_n', displayName: 'Priya Nandakumar', programType: 'Glute Recomp', startWeight: 64, goalWeight: 61, startDate: startForWeek(6), phone: '+61400000102' });
  client({ storageKey: 'tomasz_b', displayName: 'Tomasz Bielak', programType: 'Lean Bulk', startWeight: 70, goalWeight: 75, startDate: startForWeek(3), phone: '' });
  client({ storageKey: 'isla_b', displayName: 'Isla Brennan', programType: 'Strength Cut', startWeight: 71, goalWeight: 66, startDate: startForWeek(7), phone: '+61400000104' });
  client({ storageKey: 'nadia_k', displayName: 'Nadia Karimi', programType: 'Recomp', startWeight: 60, goalWeight: 58, startDate: startForWeek(3), phone: '+61400000105' });
  client({ storageKey: 'ravi_m', displayName: 'Ravi Menon', programType: 'Cut', startWeight: 88, goalWeight: 80, startDate: startForWeek(6), phone: '+61400000106' });
  client({ storageKey: 'jonah_r', displayName: 'Jonah Reyes', programType: 'Block 2 Hypertrophy', startWeight: 80, goalWeight: 84, startDate: startForWeek(15), durationWeeks: 16, phaseCount: 4, phone: '+61400000107' });
  client({ storageKey: 'sofia_m', displayName: 'Sofia Marchetti', programType: 'Glute Lean Bulk', startWeight: 55, goalWeight: 58, startDate: startForWeek(18), durationWeeks: 16, phaseCount: 4, phone: '+61400000108' });
  client({ storageKey: 'kwame_a', displayName: 'Kwame Asante', programType: 'Strength', startWeight: 84, goalWeight: 86, startDate: startForWeek(5), durationWeeks: 16, phaseCount: 4, phone: '+61400000109' });
  client({ storageKey: 'felix_w', displayName: 'Felix Wong', programType: 'Recomp', startWeight: 77, goalWeight: 75, startDate: startForWeek(2), phone: '+61400000110',
    nextCoachAction: 'Swap leg press for hack squat', nextCoachActionDue: sydDay(0) });
  client({ storageKey: 'elena_p', displayName: 'Elena Petrova', programType: 'Cut', startWeight: 69, goalWeight: 63, startDate: startForWeek(10), durationWeeks: 16, phaseCount: 4, phone: '+61400000111' });
  client({ storageKey: 'leila_h', displayName: 'Leila Haddad', programType: 'Fat Loss', startWeight: 81, goalWeight: 72, startDate: startForWeek(8), phone: '+61400000112' });
  client({ storageKey: 'amara_d', displayName: 'Amara Diallo', programType: 'Lean Bulk', programGoal: 'lean_bulk', startWeight: 58, goalWeight: 62, startDate: startForWeek(3), phone: '+61400000113' });
  client({ storageKey: 'ben_t', displayName: 'Ben Thornton', programType: 'Recomp', startWeight: 79, goalWeight: 77, startDate: startForWeek(2), phone: '+61400000114', lastMeaningfulCoachReview: dAgo(1) });
  client({ storageKey: 'owen_c', displayName: 'Owen Clarke', programType: 'Cut', startWeight: 101, goalWeight: 92, startDate: startForWeek(10), phone: '+61400000115' });
  client({ storageKey: 'hana_s', displayName: 'Hana Sato', programType: 'Fat Loss', startWeight: 74, goalWeight: 68, startDate: sydDay(-3), programStatus: 'onboarding', phone: '+61400000116' });
  client({ storageKey: 'diego_f', displayName: 'Diego Fuentes', programType: 'Lean Bulk', startWeight: 72, goalWeight: 76, startDate: startForWeek(5), programStatus: 'paused', isPaused: true, pausedAt: dAgo(6), phone: '+61400000117' });
  client({ storageKey: 'grace_o', displayName: 'Grace Okafor', programType: 'Cut', startWeight: 70, goalWeight: 64, startDate: '2026-05-20', programStatus: 'archived', archivedAt: dAgo(30), archiveReason: 'Completed block', phone: '' });

  // ── activity (dashboard()) ──
  const D = {};
  const sum = (key) => D[key] || (D[key] = { latestWeight: null, latestWeightTs: null, weightHistory: [], latestWorkoutTs: null, workoutsThisWeek: 0,
    latestMealTs: null, mealsToday: 0, latestCheckinTs: null, recentMeals: [], recentWorkouts: [], recentCheckIns: [] });
  const weights = (key, list) => list.forEach(([d, kg]) => sum(key).weightHistory.push({ ts: typeof d === 'string' ? d : dAgo(d, 21), kg }));
  const dailyWeights = (key, fromDay, toDay, startKg, perDay) => { const out = []; for (let d = fromDay; d >= toDay; d--) out.push([d, Math.round((startKg + (fromDay - d) * perDay) * 10) / 10]); weights(key, out); };
  const MEALS = [['Overnight oats', 520, 32, 70, 12], ['Chicken rice bowl', 680, 52, 78, 16], ['Salmon + potatoes', 640, 45, 55, 24]];
  const meals = (key, days, lastHourAgo) => days.forEach((d, i) => MEALS.forEach((m, j) => {
    const t = lastHourAgo != null && i === 0 ? now - (lastHourAgo + (2 - j) * 5) * HOUR : now - d * DAY - (2 - j) * 5 * HOUR;
    sum(key).recentMeals.push({ timestamp: iso(t), name: m[0], cal: m[1], p: m[2], c: m[3], f: m[4] });
  }));
  const lift = (key, tsIso, ex, kg, reps, extra) => sum(key).recentWorkouts.push(Object.assign({ timestamp: tsIso, exerciseName: ex, prescribedExerciseName: null,
    weightActual: String(kg), setsActual: '3', repsActual: String(reps), rpeActual: '8', phase: '2', dayIdx: 0 }, extra || {}));
  const checkin = (key, ts, week, kg, o) => sum(key).recentCheckIns.push(Object.assign({ timestamp: ts, week, weightKg: kg, energy1to10: 7, sleepHours: 7.5, stress1to10: 4,
    dietAdherence1to10: 8, trainingAdherence1to10: 8, notes: 'Good week overall.' }, o || {}));

  // marcus: quiet 10 d, gained on a cut
  dailyWeights('marcus_vell', 24, 10, 90.4, 0.3); meals('marcus_vell', [10, 11, 12]);
  lift('marcus_vell', dAgo(10, 8), 'Back Squat', 100, 6); lift('marcus_vell', dAgo(12, 8), 'Bench Press', 80, 6);
  checkin('marcus_vell', dAgo(12, 9), 5, 93.2, { notes: 'Work trip, struggled with food.' });
  // priya: new check-in yesterday, PR today, logging everything
  dailyWeights('priya_n', 13, 0, 63.4, -0.05); meals('priya_n', [0, 1, 2, 3, 4], 2);
  lift('priya_n', dAgo(5, 8), 'Hip Thrust', 100, 8); lift('priya_n', dAgo(3, 8), 'Romanian Deadlift', 70, 8);
  lift('priya_n', hAgo(3), 'Hip Thrust', 105, 8); lift('priya_n', hAgo(3), 'Bulgarian Split Squat', 22, 10, { prescribedExerciseName: 'Walking Lunge' });
  checkin('priya_n', dAgo(8, 9), 5, 63.1); checkin('priya_n', dAgo(1, 9), 6, 62.8, { notes: 'Hip thrust felt strong, a bit hungry at night.' });
  // tomasz: reviewed check-in 2 d ago, reply drafted but not sent
  dailyWeights('tomasz_b', 12, 0, 70.2, 0.06); meals('tomasz_b', [0, 1, 2, 3, 4]); lift('tomasz_b', dAgo(1, 8), 'Deadlift', 140, 5);
  checkin('tomasz_b', dAgo(2, 9), 3, 70.9, { notes: 'Appetite is hard.' });
  // isla: new check-in, bad sleep / stress
  dailyWeights('isla_b', 12, 0, 70.4, -0.08); meals('isla_b', [0, 1, 2, 4]); lift('isla_b', dAgo(1, 8), 'Bench Press', 47.5, 6);
  checkin('isla_b', dAgo(9, 9), 6, 69.8); checkin('isla_b', dAgo(2, 9), 7, 69.5, { sleepHours: 5, stress1to10: 9, dietAdherence1to10: 4, notes: 'Exams. Sleeping badly.' });
  // nadia: reply sent 30 h ago, nothing since (last log 34 h ago)
  dailyWeights('nadia_k', 10, 2, 60.1, -0.04); meals('nadia_k', [2, 3, 4]); lift('nadia_k', iso(now - 34 * HOUR), 'Leg Press', 120, 10);
  sum('nadia_k').weightHistory.push({ ts: iso(now - 34 * HOUR), kg: 59.7 });
  checkin('nadia_k', dAgo(3, 9), 2, 59.8);
  // ravi: reply sent 5 h ago, last log 7 h ago
  dailyWeights('ravi_m', 13, 1, 86.9, -0.1); meals('ravi_m', [1, 2, 3, 4, 5]);
  sum('ravi_m').weightHistory.push({ ts: iso(now - 7 * HOUR), kg: 85.6 }); lift('ravi_m', dAgo(1, 8), 'Pull Up', 10, 8);
  checkin('ravi_m', dAgo(3, 9), 5, 85.9);
  // jonah, sofia, kwame, felix, ben: engaged
  for (const [k, kg, dk] of [['jonah_r', 83.2, 0.02], ['sofia_m', 57.4, 0.02], ['kwame_a', 85.1, 0.01], ['felix_w', 76.4, -0.03], ['ben_t', 78.6, -0.05], ['elena_p', 65.2, -0.05]]) {
    dailyWeights(k, 12, 0, kg, dk); meals(k, [0, 1, 2, 3, 4, 5]); lift(k, dAgo(1, 8), 'Bench Press', 70, 8); lift(k, dAgo(3, 8), 'Back Squat', 90, 6);
    checkin(k, dAgo(4, 9), 1, kg);
  }
  lift('kwame_a', dAgo(6, 8), 'Deadlift', 170, 3); lift('kwame_a', dAgo(3, 7), 'Deadlift', 177.5, 3);
  checkin('elena_p', '2026-08-20T09:00:00.000Z', 2, 67.9, { notes: 'Pre-rollout check-in.' });
  // leila: logging meals, no check-in for 16 d
  dailyWeights('leila_h', 20, 0, 80.1, -0.06); meals('leila_h', [0, 1, 2, 3, 4]); lift('leila_h', dAgo(2, 8), 'Hip Thrust', 80, 10);
  checkin('leila_h', dAgo(16, 9), 5, 79.9);
  // amara: quiet 5 days
  dailyWeights('amara_d', 14, 5, 58.2, 0.06); meals('amara_d', [5, 6, 7]); lift('amara_d', dAgo(5, 8), 'Overhead Press', 30, 8);
  checkin('amara_d', dAgo(6, 9), 2, 58.5);
  // owen: inactive 20 d
  dailyWeights('owen_c', 30, 20, 99.4, -0.1); meals('owen_c', [20, 21]); lift('owen_c', dAgo(20, 8), 'Back Squat', 110, 5);
  checkin('owen_c', dAgo(22, 9), 7, 97.9);
  // hana (onboarding): ONE weigh-in only, so the page never auto-promotes her (that would trigger a roster write)
  weights('hana_s', [[1, 74.3]]);
  // diego (paused) / grace (archived): old data only
  dailyWeights('diego_f', 30, 8, 72.5, 0.02); checkin('diego_f', dAgo(9, 9), 4, 72.8);
  dailyWeights('grace_o', 60, 40, 66.1, -0.02);

  // derive the server summary fields (same rules as dashboard() in api/index.ts)
  const weekAgo = iso(now - 7 * DAY), todayStr = iso(now).slice(0, 10);
  for (const p of Object.values(D)) {
    const by = (a, b) => (a.ts || a.timestamp) < (b.ts || b.timestamp) ? -1 : 1;
    p.weightHistory.sort(by); p.recentMeals.sort(by); p.recentWorkouts.sort(by); p.recentCheckIns.sort(by);
    for (const w of p.weightHistory) if (!p.latestWeightTs || w.ts > p.latestWeightTs) { p.latestWeightTs = w.ts; p.latestWeight = w.kg; }
    for (const c of p.recentCheckIns) if (!p.latestCheckinTs || c.timestamp > p.latestCheckinTs) p.latestCheckinTs = c.timestamp;
    for (const m of p.recentMeals) { if (!p.latestMealTs || m.timestamp > p.latestMealTs) p.latestMealTs = m.timestamp; if (m.timestamp.slice(0, 10) === todayStr) p.mealsToday++; }
    for (const w of p.recentWorkouts) { if (!p.latestWorkoutTs || w.timestamp > p.latestWorkoutTs) p.latestWorkoutTs = w.timestamp; if (w.timestamp >= weekAgo) p.workoutsThisWeek++; }
    p.recentCheckIns = p.recentCheckIns.slice(-12); p.recentMeals = p.recentMeals.slice(-15); p.recentWorkouts = p.recentWorkouts.slice(-10);
  }
  const ciTs = (key, i) => { const a = D[key].recentCheckIns; return a[a.length - 1 - (i || 0)].timestamp; };   // newest first

  // coach review state on the roster: reviewed check-ins
  const markReviewed = (key, ts, outcome, note) => {
    const c = R.find((x) => x.storageKey === key);
    c.checkInReviews = c.checkInReviews || {};
    c.checkInReviews[key + '::' + ts] = { reviewedTs: dAgo(1), outcome, note };
  };
  markReviewed('tomasz_b', ciTs('tomasz_b'), 'checkin_feedback', 'Push calories via shakes.');
  markReviewed('nadia_k', ciTs('nadia_k'), 'no_change', '');
  markReviewed('ravi_m', ciTs('ravi_m'), 'nutrition_adjusted', 'Dropped 100 kcal.');
  for (const k of ['jonah_r', 'sofia_m', 'kwame_a', 'felix_w', 'ben_t', 'elena_p', 'amara_d']) markReviewed(k, ciTs(k), 'no_change', '');
  markReviewed('priya_n', ciTs('priya_n', 1), 'no_change', '');
  markReviewed('marcus_vell', ciTs('marcus_vell'), 'no_change', '');
  markReviewed('isla_b', ciTs('isla_b', 1), 'no_change', '');

  // ── agent drafts (checkinDraftsGet) ──
  const draft = (key, checkin_ts, action, for_coach, text, sent_at, createdHAgo) =>
    ({ client_key: key, checkin_ts, action, for_coach, draft: text, created_at: hAgo(createdHAgo || 20), sent_at: sent_at || null });
  const drafts = [
    draft('priya_n', ciTs('priya_n'), 'hold', ['Weight down 0.3 kg, on pace for the cut.', 'Hip thrust PR this morning (105 kg).', 'Hunger at night: suggest a casein snack.', 'Sleep 7.5 h, fine.'],
      'Hey Priya, great week. Down 0.3 kg and a new hip thrust PR. For the night hunger, have a Greek yoghurt before bed. Same plan this week.'),
    draft('tomasz_b', ciTs('tomasz_b'), 'adjust', ['Gaining 0.3 kg/wk, slightly under target.'], 'Tomasz, nice work. Add one shake a day so we get to +0.4 kg a week.'),
    draft('ravi_m', ciTs('ravi_m'), 'adjust', ['Down 1 kg in 2 weeks.'], 'Ravi, strong fortnight. Small drop in calories this week.', hAgo(5), 26),
    draft('nadia_k', ciTs('nadia_k'), 'hold', ['Steady.'], 'Nadia, all on track. Keep going.', hAgo(30), 50),
    draft('jonah_r', 'journey:offer:' + R.find((c) => c.storageKey === 'jonah_r').startDate, 'offer', ['Week 15 of 16: final-week offer.', 'Strength up 12% on squat.'],
      'Jonah, two weeks left in this block. Let\'s lock in the next one so you keep the momentum.'),
    draft('sofia_m', 'journey:next_block:' + R.find((c) => c.storageKey === 'sofia_m').startDate, 'next_block', ['Finished week 16, no next block yet.'],
      'Sofia, you finished the block. Want to book a quick call about Block 2?'),
  ];

  // ── Apple Health (healthGet) ──
  const hrows = [];
  for (let d = 19; d >= 0; d--) hrows.push({ storage_key: 'kwame_a', day: sydDay(d), steps: 8000 + (d * 377) % 4000, active_kcal: 450 + (d * 31) % 200, exercise_min: 30 + d % 25,
    resting_hr: 56 + d % 4, sleep_min: d === 0 ? 452 : 420 + d % 60, received_at: dAgo(d), sources: { steps: { "Kwame's iPhone": 3000, 'Apple Watch': 5400 }, sleep: { deep: 51, rem: 50, awake: 27 } } });
  for (let d = 15; d >= 3; d--) hrows.push({ storage_key: 'ravi_m', day: sydDay(d), steps: 6500 + d * 90, active_kcal: 380, exercise_min: 25, resting_hr: 62, sleep_min: null, received_at: dAgo(d),
    sources: { steps: { Connect: 6500 } } });
  const health = { rows: hrows, status: {
    kwame_a: { state: 'active', consentAt: dAgo(20), lastUsedAt: hAgo(6), issuedAt: dAgo(21) },
    ravi_m: { state: 'active', consentAt: dAgo(16), lastUsedAt: dAgo(3), issuedAt: dAgo(17) },
    hana_s: { state: 'pending', consentAt: null, lastUsedAt: null, issuedAt: dAgo(1) },
  } };

  // ── app accounts (accountList) ──
  const accounts = R.map((c, i) => ({ storageKey: c.storageKey, name: c.displayName, internal: false,
    account: i % 3 === 0 ? 'active' : 'none', email: i % 3 === 0 ? c.email : null, accessStatus: 'active',
    invite: i % 3 === 1 ? { status: 'pending', purpose: 'invite', expiresAt: iso(now + 5 * DAY) } : { status: i % 3 === 0 ? 'accepted' : 'none', purpose: null, expiresAt: null },
    activeDevices: i % 3 === 0 ? 1 : 0, lastSeen: i % 3 === 0 ? hAgo(10) : null }));

  // ── intakes (intakeList) ──
  const intakes = [
    { intakeId: '00000000-0000-4000-8000-000000000001', submittedAt: dAgo(2), fullName: 'Hana Sato', phone: '+61400000116', email: 'hana_s@example.test', weightKg: 74.3,
      status: 'linked', ingestionState: 'complete', linkedClientId: '00000000-0000-4000-8000-0000000000aa', linkedStorageKey: 'hana_s', photoViews: ['front', 'side', 'back'], legacyPhotoViews: [] },
    { intakeId: '00000000-0000-4000-8000-000000000002', submittedAt: dAgo(1), fullName: 'Mateo Lindqvist', phone: '+61400000201', email: 'mateo@example.test', weightKg: 90.1,
      status: 'new', ingestionState: 'complete', linkedClientId: null, linkedStorageKey: null, photoViews: ['front', 'side'], legacyPhotoViews: [] },
    { intakeId: '00000000-0000-4000-8000-000000000003', submittedAt: hAgo(5), fullName: 'Yara Haddon', phone: '+61400000202', email: 'yara@example.test', weightKg: 63,
      status: 'new', ingestionState: 'photos_pending', linkedClientId: null, linkedStorageKey: null, photoViews: [], legacyPhotoViews: ['front'] },
  ];

  // ── workout completions (coachWorkoutCompletions) ──
  const ev = (key, d, label, st) => ({ ref: key + '-' + d, status: st || 'completed', completedAt: dAgo(d, 8), recordedAt: dAgo(d, 8), localDate: sydDay(d), timezone: 'Australia/Sydney',
    phase: '2', dayIdx: d % 4, dayLabel: label, sessionKind: 'mandatory', exercisesPrescribed: 6, exercisesLogged: d % 2 ? 6 : 4, setsLogged: 18, logged: d % 2 ? 'all' : 'partial',
    revokedAt: st === 'revoked' ? dAgo(d, 9) : null, revokedBy: st === 'revoked' ? 'client' : null });
  const cwvSum = (hist) => ({ timezone: 'Australia/Sydney', timezoneSource: 'client_setting', latest: hist.find((e) => e.status === 'completed') || null,
    thisWeek: { from: sydDay(6), to: sydDay(0), completed: hist.filter((e) => e.status === 'completed').length },
    previousWeek: { from: sydDay(13), to: sydDay(7), completed: 2 }, totals: { completed: hist.filter((e) => e.status === 'completed').length, revoked: hist.filter((e) => e.status !== 'completed').length, windowDays: 42 }, history: hist });
  const cwv = {};
  R.forEach((c) => { cwv[c.storageKey] = Object.assign({ displayName: c.displayName }, cwvSum([])); });
  cwv.priya_n = Object.assign({ displayName: 'Priya Nandakumar' }, cwvSum([ev('priya_n', 0, 'Lower A'), ev('priya_n', 3, 'Upper A'), ev('priya_n', 4, 'Lower B', 'revoked'), ev('priya_n', 5, 'Lower A')]));
  cwv.kwame_a = Object.assign({ displayName: 'Kwame Asante' }, cwvSum([ev('kwame_a', 1, 'Push'), ev('kwame_a', 3, 'Pull')]));

  // ── per-client reads ──
  const programs = { priya_n: { schemaVersion: 3, phases: { '2': { days: [{ name: 'Lower A', exercises: [{ name: 'Hip Thrust', sets: 4, reps: '8-10', weight: '100' }, { name: 'Romanian Deadlift', sets: 3, reps: '8-10', weight: '70' }] }] } } } };
  const weightLogs = {};
  Object.keys(D).forEach((k) => { weightLogs[k] = D[k].weightHistory.map((w) => ({ timestamp: w.ts, weightKg: w.kg, notes: null })); });
  const photos = { priya_n: [
    { url: '/__fixture/photo.svg?v=front-base', urlKind: 'signed', view: 'front', week: null, ts: dAgo(40), source: 'intake', intakeId: '00000000-0000-4000-8000-0000000000bb', label: 'Baseline', baselineWeight: 64.2 },
    { url: '/__fixture/photo.svg?v=front-w6', urlKind: 'signed', view: 'front', week: 6, ts: dAgo(1), source: 'checkin', intakeId: null, label: 'Week 6', baselineWeight: null },
    { url: '/__fixture/photo.svg?v=side-w6', urlKind: 'signed', view: 'side', week: 6, ts: dAgo(1), source: 'checkin', intakeId: null, label: 'Week 6', baselineWeight: null },
  ] };
  const progressionHistory = { priya_n: { hip_thrust: [{ ts: dAgo(3), exerciseName: 'Hip Thrust', decision: 'PROGRESS_LOAD', applied: true, prevLoad: '100', nextLoad: '105', reason: 'Top of the rep range on all sets at RPE 8.' }] } };

  const rosterTs = now - 3 * DAY;
  const registry = { schemaVersion: 1, generatedAt: dAgo(1), generatedBy: 'coach_ui_fixture', clientCount: R.length, clients: R.map((c) => ({ storageKey: c.storageKey, programUrl: c.programUrl })) };

  return {
    now, roster: R, rosterTs, dashboard: D, drafts, health, accounts, intakes, cwv, programs, weightLogs, photos, progressionHistory, registry,
    pageStatus: { elena_p: 404 },                   // clients/<key>/index.html HEAD -> 404 for Elena only ("client page not loading")
    ciTs: { priya: ciTs('priya_n'), isla: ciTs('isla_b'), tomasz: ciTs('tomasz_b'), ravi: ciTs('ravi_m') },
  };
}

// What the Today queue should show for each client (top reason source -> main button -> what it opens).
const EXPECT = {
  marcus_vell: { src: 'attn', label: 'Review', opens: 'review-modal', list: 'today' },
  priya_n: { src: 'checkin', label: 'Review', opens: 'checkin-review', list: 'today' },
  tomasz_b: { src: 'reply', label: 'Send reply', opens: 'checkin-review', list: 'today' },
  isla_b: { src: 'checkin', label: 'Review', opens: 'checkin-review', list: 'today' },
  nadia_k: { src: 'noreply', label: 'Nudge', opens: 'client', list: 'today' },
  jonah_r: { src: 'journey', label: 'Message', opens: 'journey', list: 'today' },
  sofia_m: { src: 'finished', label: 'Offer', opens: 'offer', list: 'today' },
  kwame_a: { src: 'unlock', label: 'Send code', opens: 'client', list: 'today' },
  felix_w: { src: 'task', label: 'Do it', opens: 'client', list: 'today' },
  elena_p: { src: 'broken', label: 'Open', opens: 'client', list: 'today' },
  amara_d: { src: 'quiet', label: 'Nudge', opens: 'client', list: 'week' },
};
const NEVER_IN_QUEUE = ['hana_s', 'diego_f', 'grace_o', 'ben_t'];   // onboarding / paused / archived / on track

module.exports = { build, EXPECT, NEVER_IN_QUEUE };
