// COACH PLATFORM V1 (Omar 2026-11-24) — the real handler source against an in-memory database.
//   Isolation is the point of this file: a coach reaches ONLY their own clients and builds; Omar's coach token and a
//   coach session are never interchangeable; storage keys are made server-side; the worker key opens only the queue.
const { M, DB, OMAR, BUILDER_KEY, uuid, nodeCrypto } = require('./coach_platform_fixture.js');

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -- ' + JSON.stringify(d).slice(0, 400) : '')); } };
const B = (r) => r.__body;
const FORM = { firstName: 'Sam', lastName: 'Tester', sex: 'male', age: 28, heightCm: 178, weightKg: 92, goal: 'lose_fat', activity: 'moderate',
               training: 'gym5_ppl_ul', menu: 'everyday', mealsPerDay: 4, weeks: 12 };

async function newCoach(name, email, extra = {}) {
  const c = B(await M.cpCoachCreate({ coachToken: OMAR, name, brand: name.toUpperCase() + ' FIT', email, ...extra }));
  const token = c.setupLink.split('#setup=')[1];
  const password = 'correct horse ' + name;
  await M.cpSetup({ token, password });
  const l = B(await M.cpLogin({ email, password }));
  return { slug: c.slug, token, password, session: l.session, email };
}
async function buildAndPublish(coach, form, storageKey) {
  const c = B(await M.cpBuildCreate({ session: coach.session, form, ...(storageKey ? { storageKey } : {}) }));
  const job = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: job.id, kind: 'build', ok: true, pageSha256: 'a'.repeat(64),
    summary: { storageKey: job.storageKey, name: form.firstName + ' ' + (form.lastName || ''), firstName: form.firstName, startWeightKg: form.weightKg, goalWeightKg: 82 }, plan: { targets: {} } });
  const p = B(await M.cpPublish({ session: coach.session, buildId: c.buildId }));
  const pj = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: pj.id, kind: 'publish', ok: true });
  return { buildId: c.buildId, key: c.storageKey, publish: p, publishJob: pj };
}

(async () => {
  console.log('coach platform — accounts');
  // Omar's own client: coach_id null. Its key deliberately looks like a coach key to prove the owner check, not the name, decides.
  DB.clients.push({ id: uuid(), storage_key: 'c_al_omars_client', display_name: 'Omars Client', coach_id: null, is_internal: false, profile_id: uuid() });
  DB.clients.push({ id: uuid(), storage_key: 'cruz_rehayem', display_name: 'Cruz', coach_id: null, is_internal: false, profile_id: uuid() });

  t('creating a coach needs Omar\'s token', B(await M.cpCoachCreate({ coachToken: 'nope', name: 'Al', email: 'al@x.co' })).error === 'unauthorized');
  t('bad email refused', B(await M.cpCoachCreate({ coachToken: OMAR, name: 'Al', email: 'not-an-email' })).error === 'bad_email');
  const made = B(await M.cpCoachCreate({ coachToken: OMAR, name: 'Al Coach', brand: 'AL FIT', email: 'Al@X.co' }));
  t('coach created with a setup link, slug from the first name, email lower-cased', made.ok && made.slug === 'al' && made.setupLink.includes('/coach/#setup=') && DB.coaches[0].email === 'al@x.co', made);
  const setupToken = made.setupLink.split('#setup=')[1];
  t('only the sha256 of the setup link is stored', DB.coaches[0].setup_token_hash === nodeCrypto.createHash('sha256').update(setupToken).digest('hex') && !JSON.stringify(DB).includes(setupToken));
  t('same email again is refused without reissue', B(await M.cpCoachCreate({ coachToken: OMAR, name: 'Al Coach', email: 'al@x.co' })).error === 'coach_exists');
  t('login before a password exists fails like any bad login', B(await M.cpLogin({ email: 'al@x.co', password: 'anything at all' })).error === 'bad_login');
  t('setup inspect shows the coach name', B(await M.cpSetupInspect({ token: setupToken })).name === 'Al Coach');
  t('setup inspect with a wrong token -> link_invalid', B(await M.cpSetupInspect({ token: 'A'.repeat(43) })).error === 'link_invalid');
  t('short password refused', B(await M.cpSetup({ token: setupToken, password: 'short' })).error === 'password_too_short');
  t('password set', B(await M.cpSetup({ token: setupToken, password: 'correct horse battery' })).ok === true);
  t('the password is stored only as a salted hash', /^[0-9a-f]{64}$/.test(DB.coaches[0].password_hash) && /^[0-9a-f]{32}$/.test(DB.coaches[0].password_salt) && !JSON.stringify(DB).includes('correct horse battery'));
  t('the setup link works once', B(await M.cpSetup({ token: setupToken, password: 'another password 1' })).error === 'link_invalid');
  t('wrong password -> bad_login', B(await M.cpLogin({ email: 'al@x.co', password: 'wrong password!' })).error === 'bad_login');
  const login = B(await M.cpLogin({ email: 'AL@x.co', password: 'correct horse battery' }));
  t('login returns a session and the coach, never the hash', login.ok && login.session.length >= 40 && login.coach.slug === 'al' && !JSON.stringify(login).includes(DB.coaches[0].password_hash), login);
  t('only the sha256 of the session is stored', DB.coach_sessions[0].token_hash === nodeCrypto.createHash('sha256').update(login.session).digest('hex') && !JSON.stringify(DB).includes(login.session));
  const al = { session: login.session, slug: 'al' };
  t('cpMe with the session', B(await M.cpMe({ session: al.session })).coach.name === 'Al Coach');
  t('Omar\'s coach token is not a coach session', B(await M.cpMe({ session: OMAR })).error === 'unauthorized' && B(await M.cpClients({ session: OMAR })).error === 'unauthorized');
  t('a coach session is not Omar\'s token', B(await M.cpCoachList({ coachToken: al.session })).error === 'unauthorized' && B(await M.cpCoachCreate({ coachToken: al.session, name: 'X', email: 'x@x.co' })).error === 'unauthorized');
  for (let k = 0; k < 8; k++) await M.cpLogin({ email: 'al@x.co', password: 'wrong password!' });
  t('8 wrong passwords lock the login, even with the right one', B(await M.cpLogin({ email: 'al@x.co', password: 'correct horse battery' })).error === 'locked');
  DB.coaches[0].locked_until = null; DB.coaches[0].failed_logins = 0;

  console.log('coach platform — plan builder');
  t('build needs a session', B(await M.cpBuildCreate({ form: FORM })).error === 'unauthorized');
  t('a form with a script for a name is refused', B(await M.cpBuildCreate({ session: al.session, form: { ...FORM, firstName: '<script>' } })).error === 'bad_form');
  t('a form field that is an object is refused', B(await M.cpBuildCreate({ session: al.session, form: { ...FORM, kcal: { $gt: 1 } } })).error === 'bad_form');
  const b1 = B(await M.cpBuildCreate({ session: al.session, form: { ...FORM, storageKey: 'cruz_rehayem', evil: 'x' } }));
  t('the storage key is made by the server from coach + name', b1.ok && b1.storageKey === 'c_al_sam_tester', b1);
  t('unknown form fields are dropped', !('evil' in DB.plan_builds[0].form) && !('storageKey' in DB.plan_builds[0].form));
  t('a second build for the same client while one is open is refused', B(await M.cpBuildCreate({ session: al.session, form: FORM })).error === 'build_in_progress');
  t('worker claim needs the builder key', B(await M.cpWorkerClaim({ builderKey: 'wrong' + 'x'.repeat(40) })).error === 'unauthorized' && B(await M.cpWorkerClaim({})).error === 'unauthorized');
  t('a coach session is not a builder key', B(await M.cpWorkerClaim({ builderKey: al.session })).error === 'unauthorized');
  const job = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  t('worker claims the build with the coach brand, no secrets', job && job.kind === 'build' && job.storageKey === 'c_al_sam_tester' && job.coach.brand === 'AL FIT' && !JSON.stringify(job).includes('password'), job);
  t('nothing left to claim', B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job === null);
  t('publish before the build is done is refused', B(await M.cpPublish({ session: al.session, buildId: b1.buildId })).error === 'not_ready');
  t('a result for the wrong client key fails the build', B(await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: job.id, kind: 'build', ok: true, summary: { storageKey: 'cruz_rehayem' } })).error === 'key_mismatch' && DB.plan_builds[0].status === 'failed');
  t('a failed build can be discarded', B(await M.cpBuildDiscard({ session: al.session, buildId: b1.buildId })).ok === true);

  const r1 = await buildAndPublish(al, FORM);
  const samRow = DB.clients.find((c) => c.storage_key === 'c_al_sam_tester');
  t('first publish creates the client under this coach, hidden from Omar\'s lists', r1.publish.ok && samRow && samRow.coach_id === DB.coaches[0].id && samRow.is_internal === true, r1.publish);
  t('first publish grants access and returns the client link once', r1.publish.firstPublish === true && /clients\/c_al_sam_tester\/\?t=[0-9a-f]{64}$/.test(r1.publish.link) && DB.client_entitlements.some((e) => e.client_id === samRow.id && e.status === 'active'));
  t('the link token is stored only as a salted hash', !JSON.stringify(DB.client_sessions).includes(r1.publish.link.split('?t=')[1]));
  t('worker got a publish job and the build is live', r1.publishJob.kind === 'publish' && DB.plan_builds.find((b) => b.id === r1.buildId).status === 'live');
  t('a new build with the same name is refused (client exists)', B(await M.cpBuildCreate({ session: al.session, form: FORM })).error === 'client_exists');
  const r2 = await buildAndPublish(al, { ...FORM, kcal: [2300, 2200, 2100] }, 'c_al_sam_tester');
  t('updating a plan keeps the client link (no new link, same client row)', r2.publish.ok && r2.publish.link === null && r2.publish.firstPublish === false && DB.clients.filter((c) => c.storage_key === 'c_al_sam_tester').length === 1, r2.publish);
  t('exactly one live plan per client', DB.plan_builds.filter((b) => b.storage_key === 'c_al_sam_tester' && b.status === 'live').length === 1);

  console.log('coach platform — isolation between coaches');
  const bo = await newCoach('Bo', 'bo@y.co');
  t('second coach logs in', !!bo.session && bo.slug === 'bo');
  const rb = await buildAndPublish(bo, { ...FORM, firstName: 'Kim', lastName: 'Lee' });
  t('second coach\'s client key carries their own slug', rb.key === 'c_bo_kim_lee');
  const alList = B(await M.cpClients({ session: al.session }));
  const boList = B(await M.cpClients({ session: bo.session }));
  t('each coach lists only their own clients', alList.clients.map((c) => c.storageKey).join() === 'c_al_sam_tester' && boList.clients.map((c) => c.storageKey).join() === 'c_bo_kim_lee', [alList.clients, boList.clients]);
  t('each coach lists only their own builds', alList.builds.every((b) => b.storageKey.startsWith('c_al_')) && boList.builds.every((b) => b.storageKey.startsWith('c_bo_')));
  DB.weight_logs.push({ client_key: 'c_al_sam_tester', logged_at: new Date().toISOString(), weight_kg: 91.2 }, { client_key: 'c_bo_kim_lee', logged_at: new Date().toISOString(), weight_kg: 70 },
    { client_key: 'cruz_rehayem', logged_at: new Date().toISOString(), weight_kg: 66 });
  DB.check_ins.push({ client_key: 'c_al_sam_tester', submitted_at: new Date().toISOString(), notes: 'al-private-note' });
  const al2 = B(await M.cpClients({ session: al.session }));
  t('list shows the latest weight of own clients only', al2.clients.length === 1 && al2.clients[0].latestWeight === 91.2 && B(await M.cpClients({ session: bo.session })).clients.map((c) => c.latestWeight).join() === '70');
  t('a coach cannot open another coach\'s client', B(await M.cpClient({ session: bo.session, storageKey: 'c_al_sam_tester' })).error === 'unknown_client');
  t('a coach cannot open Omar\'s client', B(await M.cpClient({ session: al.session, storageKey: 'cruz_rehayem' })).error === 'unknown_client');
  t('a coach cannot open Omar\'s client even when its key looks like theirs', B(await M.cpClient({ session: al.session, storageKey: 'c_al_omars_client' })).error === 'unknown_client');
  const det = B(await M.cpClient({ session: al.session, storageKey: 'c_al_sam_tester' }));
  t('own client detail has weights, check-ins and the live plan', det.ok && det.weights.length === 1 && det.checkIns[0].notes === 'al-private-note' && det.live && det.live.status === 'live', det);
  t('a coach cannot read another coach\'s build', B(await M.cpBuildGet({ session: bo.session, buildId: r1.buildId })).error === 'unknown_build');
  t('a coach cannot publish another coach\'s build', B(await M.cpPublish({ session: bo.session, buildId: r2.buildId })).error === 'unknown_build');
  t('a coach cannot discard another coach\'s build', B(await M.cpBuildDiscard({ session: bo.session, buildId: r2.buildId })).error === 'unknown_build');
  t('a coach cannot update another coach\'s client plan', B(await M.cpBuildCreate({ session: bo.session, form: FORM, storageKey: 'c_al_sam_tester' })).error === 'unknown_client');
  t('a coach cannot update Omar\'s client plan', B(await M.cpBuildCreate({ session: al.session, form: FORM, storageKey: 'cruz_rehayem' })).error === 'unknown_client');
  t('a coach cannot issue a link for another coach\'s client', B(await M.cpClientLink({ session: bo.session, storageKey: 'c_al_sam_tester' })).error === 'unknown_client');
  t('a coach cannot issue a link for Omar\'s client', B(await M.cpClientLink({ session: al.session, storageKey: 'cruz_rehayem' })).error === 'unknown_client' && !DB.client_sessions.some((s) => s.storage_key === 'cruz_rehayem'));
  t('a coach cannot suspend another coach\'s client', B(await M.cpClientAccess({ session: bo.session, storageKey: 'c_al_sam_tester', status: 'suspended' })).error === 'unknown_client');
  t('own client: pause and resume access', B(await M.cpClientAccess({ session: al.session, storageKey: 'c_al_sam_tester', status: 'suspended' })).ok && DB.client_sessions.find((s) => s.storage_key === 'c_al_sam_tester').access_status === 'suspended'
    && B(await M.cpClientAccess({ session: al.session, storageKey: 'c_al_sam_tester', status: 'active' })).ok);
  const oldHash = DB.client_sessions.find((s) => s.storage_key === 'c_al_sam_tester').token_hash;
  const nl = B(await M.cpClientLink({ session: al.session, storageKey: 'c_al_sam_tester' }));
  t('own client: a new link replaces the old one', nl.ok && nl.link.includes('c_al_sam_tester') && DB.client_sessions.find((s) => s.storage_key === 'c_al_sam_tester').token_hash !== oldHash);
  t('Omar\'s clients were never touched', DB.clients.filter((c) => c.coach_id === null).length === 2 && DB.clients.filter((c) => c.coach_id === null).every((c) => c.is_internal === false));

  console.log('coach platform — limits, suspension, owner view');
  DB.coaches.find((c) => c.slug === 'bo').client_limit = 1;
  t('client limit is enforced for new clients', B(await M.cpBuildCreate({ session: bo.session, form: { ...FORM, firstName: 'Zed' } })).error === 'client_limit');
  const owner = B(await M.cpCoachList({ coachToken: OMAR }));
  t('Omar sees every coach with client counts, no hashes', owner.coaches.length === 2 && owner.coaches.find((c) => c.slug === 'al').clients === 1 && owner.coaches.every((c) => c.passwordSet === true) && !JSON.stringify(owner).includes('password_hash'), owner);
  t('suspending a coach needs Omar', B(await M.cpCoachSetStatus({ coachToken: bo.session, slug: 'al', status: 'suspended' })).error === 'unauthorized');
  await M.cpCoachSetStatus({ coachToken: OMAR, slug: 'bo', status: 'suspended' });
  t('a suspended coach\'s session stops working at once', B(await M.cpMe({ session: bo.session })).error === 'unauthorized' && B(await M.cpClients({ session: bo.session })).error === 'unauthorized');
  t('a suspended coach cannot log in', B(await M.cpLogin({ email: 'bo@y.co', password: bo.password })).error === 'suspended');
  const re = B(await M.cpCoachCreate({ coachToken: OMAR, name: 'Al Coach', email: 'al@x.co', reissue: true }));
  t('a reissued setup link resets the password and ends every session', re.ok && re.reissued && B(await M.cpMe({ session: al.session })).error === 'unauthorized' && B(await M.cpLogin({ email: 'al@x.co', password: 'correct horse battery' })).error === 'bad_login');
  await M.cpLogout({ session: 'x'.repeat(50) });
  t('logout of an unknown session is harmless', true);

  console.log('coach platform — worker safety');
  const bo2 = await newCoach('Cy', 'cy@z.co');
  const cb = B(await M.cpBuildCreate({ session: bo2.session, form: { ...FORM, firstName: 'Ann' } }));
  const j1 = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  t('a claimed build is not handed out twice', j1.id === cb.buildId && B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job === null);
  DB.plan_builds.find((b) => b.id === cb.buildId).claimed_at = new Date(Date.now() - 11 * 60_000).toISOString();
  const j2 = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  t('a build whose worker died is re-queued after 10 minutes', j2 && j2.id === cb.buildId);
  await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: j2.id, kind: 'build', ok: false, error: { stage: 'meals', reasons: ['cannot land on target'] } });
  const got = B(await M.cpBuildGet({ session: bo2.session, buildId: cb.buildId })).build;
  t('a refused plan reaches the coach with its plain reason', got.status === 'failed' && got.error.reasons[0] === 'cannot land on target', got);
  t('worker done needs the builder key', B(await M.cpWorkerDone({ builderKey: bo2.session, id: j2.id, kind: 'build', ok: true })).error === 'unauthorized');
  t('a result for a build that is not claimed is refused', B(await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: j2.id, kind: 'build', ok: true, summary: { storageKey: j2.storageKey } })).error === 'not_claimed');
  t('storage key helper matches the engine rule', M.cpStorageKey('al', "Mary-Jane", "O'Neil") === 'c_al_mary_jane_o_neil' && M.cpStorageKey('a very long coach', 'Maximilian', 'Featherstonehaugh').length <= 40);

  console.log('coach platform — look, hand edits, client logins');
  const zlib = require('zlib');
  const png = (n) => {                                   // a real n x n PNG, built by hand
    const crc = (b) => { let c, t = []; for (let k = 0; k < 256; k++) { c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[k] = c >>> 0; }
      let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((n * 3 + 1) * n, 40);
    for (let y = 0; y < n; y++) raw[y * (n * 3 + 1)] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  };
  const logo = { 512: png(512), 192: png(192), 180: png(180), 32: png(32) };
  const cy = bo2;
  t('settings need a session', B(await M.cpSettingsSave({ session: OMAR, brand: 'X' })).error === 'unauthorized');
  t('a colour must be a 6-digit hex', B(await M.cpSettingsSave({ session: cy.session, accent: 'red' })).error === 'bad_accent' && B(await M.cpSettingsSave({ session: cy.session, accent: '#12' })).error === 'bad_accent');
  t('a brand name with markup is refused', B(await M.cpSettingsSave({ session: cy.session, brand: '<b>Cy</b>' })).error === 'bad_brand');
  t('a file that is not a PNG is refused as a logo', B(await M.cpSettingsSave({ session: cy.session, logo: { ...logo, 180: Buffer.from('<svg onload=alert(1)>'.repeat(10)).toString('base64') } })).error === 'bad_logo');
  t('a PNG of the wrong size is refused', B(await M.cpSettingsSave({ session: cy.session, logo: { ...logo, 180: logo[32] } })).error === 'bad_logo');
  const saved = B(await M.cpSettingsSave({ session: cy.session, brand: 'CY STRONG', accent: '#D4AF37', logo }));
  t('brand, colour and logo saved', saved.ok && saved.coach.brand === 'CY STRONG' && saved.coach.accent === '#d4af37' && saved.coach.logo === logo[180], saved.ok ? Object.keys(saved.coach) : saved);
  t('cpMe returns the look', B(await M.cpMe({ session: cy.session })).coach.accent === '#d4af37');
  const pub = B(await M.cpBrand({ slug: 'cy' }));
  t('the public brand has name, colour, logo and nothing else', pub.ok && pub.brand === 'CY STRONG' && pub.accent === '#d4af37' && pub.logo === logo[192] && Object.keys(pub).sort().join() === 'accent,brand,coachFirstName,logo,ok', Object.keys(pub));
  t('the public brand of an unknown or suspended coach is refused', B(await M.cpBrand({ slug: 'nobody' })).error === 'unknown_coach' && B(await M.cpBrand({ slug: 'bo' })).error === 'unknown_coach');
  t('removing the logo keeps the colour', B(await M.cpSettingsSave({ session: cy.session, logo: null })).coach.logo === null && DB.coaches.find((c) => c.slug === 'cy').accent === '#d4af37');
  await M.cpSettingsSave({ session: cy.session, logo });

  const edits = { training: { 1: [{ day: 'Push', exercises: [{ name: 'Barbell Bench Press', sets: 5, reps: '5-8', rest_seconds: 180 }] }] }, meals: { 1: { 'Chicken Rice Bowl': { items: [{ id: 'halal_chicken_breast_raw', qty: 200 }] } } }, junk: 'x' };
  await M.cpBuildDiscard({ session: cy.session, buildId: cb.buildId });
  const eb = B(await M.cpBuildCreate({ session: cy.session, form: { ...FORM, firstName: 'Ann', edits } }));
  const stored = DB.plan_builds.find((b) => b.id === eb.buildId);
  t('hand edits are stored with the form; unknown edit sections are dropped', eb.ok && stored.form.edits.training[1][0].exercises[0].name === 'Barbell Bench Press' && stored.form.edits.meals && !('junk' in stored.form.edits), eb);
  t('edits that are not an object are refused', B(await M.cpBuildCreate({ session: cy.session, form: { ...FORM, firstName: 'Zoe', edits: 'drop table' } })).error === 'bad_form');
  t('oversized edits are refused', B(await M.cpBuildCreate({ session: cy.session, form: { ...FORM, firstName: 'Zoe', edits: { meals: { 1: { x: { items: [], pad: 'y'.repeat(70000) } } } } } })).error === 'bad_form');
  const ej = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  t('the worker job carries the coach\'s colour and logo', ej.coach.accent === '#d4af37' && ej.coach.logo[512] === logo[512] && ej.form.edits.training[1].length === 1);
  await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: ej.id, kind: 'build', ok: true, pageSha256: 'b'.repeat(64), summary: { storageKey: ej.storageKey, name: 'Ann', firstName: 'Ann', startWeightKg: 92 }, plan: {} });
  const ep = B(await M.cpPublish({ session: cy.session, buildId: eb.buildId }));
  const pj2 = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: pj2.id, kind: 'publish', ok: true });
  t('edited plan published', ep.ok && DB.plan_builds.find((b) => b.id === eb.buildId).status === 'live');

  const rb2 = B(await M.cpRebrandAll({ session: cy.session }));
  const rj = B(await M.cpWorkerClaim({ builderKey: BUILDER_KEY })).job;
  t('"apply my look to every client" queues one publish per live plan, same form', rb2.ok && rb2.queued === 1 && rj.kind === 'publish' && rj.storageKey === ej.storageKey && rj.form.edits.meals[1]['Chicken Rice Bowl'].items[0].qty === 200, [rb2, rj && rj.kind]);
  t('asking twice while it is still going queues nothing more', B(await M.cpRebrandAll({ session: cy.session })).queued === 0);
  await M.cpWorkerDone({ builderKey: BUILDER_KEY, id: rj.id, kind: 'publish', ok: true });
  t('still exactly one live plan after re-branding', DB.plan_builds.filter((b) => b.storage_key === ej.storageKey && b.status === 'live').length === 1);
  t('re-branding only touches the caller\'s own clients', DB.plan_builds.filter((b) => b.status === 'publishing').length === 0 && B(await M.cpRebrandAll({ session: 'x'.repeat(50) })).error === 'unauthorized');

  const inv = B(await M.cpClientInvite({ session: cy.session, storageKey: ej.storageKey }));
  t('a login invite for own client: branded login link, token only in the fragment', inv.ok && inv.purpose === 'invite' && /\/login\/\?c=cy#invite=[A-Za-z0-9_-]{40,}$/.test(inv.link), inv);
  t('only the sha256 of the invite token is stored', DB.client_invites.length === 1 && !JSON.stringify(DB.client_invites).includes(inv.link.split('#invite=')[1]));
  const inv2 = B(await M.cpClientInvite({ session: cy.session, storageKey: ej.storageKey }));
  t('a second invite replaces the first', inv2.ok && DB.client_invites.filter((x) => !x.revoked_at).length === 1 && DB.client_invites.length === 2);
  t('a coach cannot invite another coach\'s client or Omar\'s', B(await M.cpClientInvite({ session: cy.session, storageKey: 'c_al_sam_tester' })).error === 'unknown_client' && B(await M.cpClientInvite({ session: cy.session, storageKey: 'cruz_rehayem' })).error === 'unknown_client');
  const annRow = DB.clients.find((c) => c.storage_key === ej.storageKey);
  DB.profiles.find((p) => p.id === annRow.profile_id).auth_user_id = 'auth-1';
  t('once the client has a login, the link becomes a password reset', B(await M.cpClientInvite({ session: cy.session, storageKey: ej.storageKey })).purpose === 'reset' && B(await M.cpClient({ session: cy.session, storageKey: ej.storageKey })).client.hasLogin === true);
  await M.cpClientAccess({ session: cy.session, storageKey: ej.storageKey, status: 'suspended' });
  t('no login link while the client is paused', B(await M.cpClientInvite({ session: cy.session, storageKey: ej.storageKey })).error === 'access_not_active');

  console.log('coach platform — saved plans and photos');
  const liveAnn = DB.plan_builds.find((b) => b.storage_key === ej.storageKey && b.status === 'live');
  t('saving a template needs your own build', B(await M.cpTemplateSave({ session: al.session, buildId: liveAnn.id, name: 'Mine' })).error === 'unauthorized' || B(await M.cpTemplateSave({ session: bo.session, buildId: liveAnn.id, name: 'Mine' })).error === 'unauthorized');
  const al3 = await (async () => { const l = B(await M.cpLogin({ email: 'cy@z.co', password: cy.password })); return l.session; })();
  const ts1 = B(await M.cpTemplateSave({ session: al3, buildId: liveAnn.id, name: '  My 5 day  cut ' }));
  const tpl = DB.coach_templates[0];
  t('template saved: structure and training edits, no client details, no meal amounts by default', ts1.ok && tpl.name === 'My 5 day cut' && tpl.form.training === 'gym5_ppl_ul' && tpl.form.edits.training[1][0].exercises[0].name === 'Barbell Bench Press'
    && !('firstName' in tpl.form) && !('weightKg' in tpl.form) && !('age' in tpl.form) && !tpl.form.edits.meals, tpl.form);
  t('saving under the same name replaces it', B(await M.cpTemplateSave({ session: al3, buildId: liveAnn.id, name: 'my 5 DAY cut', includeMeals: true })).replaced === true && DB.coach_templates.length === 1 && !!DB.coach_templates[0].form.edits.meals);
  t('a template name with markup is refused', B(await M.cpTemplateSave({ session: al3, buildId: liveAnn.id, name: '<i>x</i>' })).error === 'bad_name');
  const list = B(await M.cpTemplates({ session: al3 }));
  t('a coach lists only their own templates', list.templates.length === 1 && list.templates[0].trainingEdited === true && B(await M.cpTemplates({ session: (B(await M.cpLogin({ email: 'al@x.co', password: 'x'.repeat(12) })).session) || 'x'.repeat(50) })).error === 'unauthorized');
  const other = await newCoach('Di', 'di@w.co');
  t('another coach sees none of them and cannot delete or copy them', B(await M.cpTemplates({ session: other.session })).templates.length === 0
    && B(await M.cpTemplateDelete({ session: other.session, id: tpl.id })).error === 'unknown_template' && B(await M.cpTemplateSave({ session: other.session, buildId: liveAnn.id, name: 'Stolen' })).error === 'unknown_build');
  DB.photo_uploads.push({ id: 1, client_key: ej.storageKey, storage_path: 'ann/w1-front.jpg', view: 'front', week: 1, uploaded_at: '2026-11-20T00:00:00Z', source: 'checkin' },
    { id: 2, client_key: 'cruz_rehayem', storage_path: 'cruz/w1-front.jpg', view: 'front', week: 1, uploaded_at: '2026-11-20T00:00:00Z', source: 'checkin' });
  await M.cpClientAccess({ session: al3, storageKey: ej.storageKey, status: 'active' });
  const ph = B(await M.cpClientPhotos({ session: al3, storageKey: ej.storageKey }));
  t('own client photos come back as signed links only', ph.ok && ph.photos.length === 1 && ph.photos[0].url.startsWith('https://signed.example/ann/') && !('storage_path' in ph.photos[0]), ph);
  t('a coach cannot see another coach\'s or Omar\'s client photos', B(await M.cpClientPhotos({ session: other.session, storageKey: ej.storageKey })).error === 'unknown_client' && B(await M.cpClientPhotos({ session: al3, storageKey: 'cruz_rehayem' })).error === 'unknown_client');
  t('deleting your own template', B(await M.cpTemplateDelete({ session: al3, id: tpl.id })).ok && DB.coach_templates.length === 0);

  console.log('coach platform — today, notes, check-in review');
  const DAY = 86400000, now = Date.parse('2026-12-01T00:00:00Z'), iso = (d) => new Date(now + d * DAY).toISOString();
  const kinds = (c) => M.cpNeeds(c, now).map((n) => n.kind).join(',');
  const base = { publishedAt: iso(-20), startDate: iso(-20).slice(0, 10), weeks: 12, access: 'active', lastOpenedAt: iso(-1), lastWorkoutAt: iso(-1), lastCheckinAt: iso(-2), reviewedThrough: iso(-2) };
  t('a client who is logging and reviewed needs nothing', kinds(base) === '');
  t('a new check-in needs the coach until it is marked read', kinds({ ...base, reviewedThrough: iso(-5) }) === 'checkin' && kinds({ ...base, reviewedThrough: null }) === 'checkin');
  t('a plan in its last two weeks, then ended', kinds({ ...base, weeks: 4 }) === 'ending' && M.cpNeeds({ ...base, weeks: 4 }, now)[0].days === 8 && kinds({ ...base, weeks: 2 }) === 'ended');
  t('a client who never opened the app after 3 days', kinds({ ...base, lastOpenedAt: null, lastWorkoutAt: null, lastCheckinAt: null }) === 'not_started');
  t('a client gone quiet for a week', kinds({ ...base, lastWorkoutAt: iso(-8), lastCheckinAt: iso(-8), reviewedThrough: iso(-8) }) === 'quiet');
  t('logging but no check-in for 9 days', kinds({ ...base, lastCheckinAt: null }) === 'no_checkin');
  t('a paused client, a future start and an unpublished plan are left alone', kinds({ ...base, access: 'suspended', lastWorkoutAt: iso(-30), lastCheckinAt: null }) === ''
    && kinds({ ...base, startDate: iso(5).slice(0, 10), lastWorkoutAt: null, lastCheckinAt: null, lastOpenedAt: null }) === '' && kinds({ ...base, publishedAt: null, lastWorkoutAt: null, lastCheckinAt: null }) === '');
  DB.check_ins.push({ client_key: ej.storageKey, submitted_at: '2026-11-22T08:00:00Z', week_number: 1, weight_kg: 80 }, { client_key: 'cruz_rehayem', submitted_at: '2026-11-23T08:00:00Z', week_number: 3 });
  const home1 = B(await M.cpClients({ session: al3 })).clients.find((c) => c.storageKey === ej.storageKey);
  t('the client list flags the unread check-in', home1.needs.some((n) => n.kind === 'checkin'), home1.needs);
  const rv = B(await M.cpCheckinReviewed({ session: al3, storageKey: ej.storageKey }));
  const home2 = B(await M.cpClients({ session: al3 })).clients.find((c) => c.storageKey === ej.storageKey);
  t('marking it read clears the flag', rv.ok && rv.reviewedThrough === '2026-11-22T08:00:00Z' && !home2.needs.some((n) => n.kind === 'checkin'), home2.needs);
  DB.check_ins.push({ client_key: ej.storageKey, submitted_at: '2026-11-29T08:00:00Z', week_number: 2 });
  t('the next check-in raises it again', B(await M.cpClients({ session: al3 })).clients.find((c) => c.storageKey === ej.storageKey).needs.some((n) => n.kind === 'checkin'));
  t('notes save and come back, and keep the read mark', B(await M.cpClientNote({ session: al3, storageKey: ej.storageKey, notes: 'Knee niggle. Likes mornings.' })).ok
    && B(await M.cpClient({ session: al3, storageKey: ej.storageKey })).client.notes === 'Knee niggle. Likes mornings.' && DB.coach_client_state.length === 1 && DB.coach_client_state[0].reviewed_through === '2026-11-22T08:00:00Z');
  t('notes over 4000 characters are refused', B(await M.cpClientNote({ session: al3, storageKey: ej.storageKey, notes: 'x'.repeat(4001) })).error === 'bad_notes');
  t('another coach cannot write notes on, or mark, this client; nor can anyone touch Omar\'s', B(await M.cpClientNote({ session: other.session, storageKey: ej.storageKey, notes: 'x' })).error === 'unknown_client'
    && B(await M.cpCheckinReviewed({ session: other.session, storageKey: ej.storageKey })).error === 'unknown_client' && B(await M.cpCheckinReviewed({ session: al3, storageKey: 'cruz_rehayem' })).error === 'unknown_client'
    && B(await M.cpClientNote({ session: 'x'.repeat(50), storageKey: ej.storageKey, notes: 'x' })).error === 'unauthorized');

  console.log('coach platform — what changed note');
  const upForm = { ...liveAnn.form, update: { title: '  Calories down a little ', why: 'You stalled for two weeks.', date: '1999-01-01', id: 'x' } };
  const up1 = B(await M.cpBuildCreate({ session: al3, form: upForm, storageKey: ej.storageKey }));
  const upRow = DB.plan_builds.find((b) => b.id === up1.buildId);
  t('a plan update carries the coach\'s note, trimmed, with the server\'s date', up1.ok && upRow.form.update.title === 'Calories down a little' && upRow.form.update.why === 'You stalled for two weeks.'
    && upRow.form.update.date === new Date().toISOString().slice(0, 10) && !('id' in upRow.form.update), upRow && upRow.form.update);
  await M.cpBuildDiscard({ session: al3, buildId: up1.buildId });
  t('a note that is too long, or has no title, is refused in plain words', B(await M.cpBuildCreate({ session: al3, form: { ...liveAnn.form, update: { title: 'x'.repeat(71) } }, storageKey: ej.storageKey })).error === 'bad_update'
    && B(await M.cpBuildCreate({ session: al3, form: { ...liveAnn.form, update: { why: 'hello' } }, storageKey: ej.storageKey })).error === 'bad_update');
  const nu = B(await M.cpBuildCreate({ session: other.session, form: { ...liveAnn.form, firstName: 'Newby', update: { title: 'Hi' } } }));
  t('a brand new client never gets a what-changed note', nu.ok && !('update' in DB.plan_builds.find((b) => b.id === nu.buildId).form));

  console.log('coach platform — client form');
  const ANS = { firstName: 'Kim', lastName: 'Newman', sex: 'female', age: 31, heightCm: 165, weightKg: 70, goalWeightKg: 62, goal: 'lose_fat', activity: 'moderate', where: 'gym', days: 5,
                mealsPerDay: 4, allergies: ['peanut', '<x>'], health: 'Old ankle sprain', foods: 'No mushrooms', notes: '', phone: '+61 400 000 000<script>', coach_id: 'hack' };
  const f1 = B(await M.cpIntakeCreate({ session: al3, label: 'Kim from the gym' }));
  const ftok = f1.link.split('#f=')[1];
  t('a form link: on the coach app address, token only in the fragment, only its hash stored', f1.ok && /\/coach\/intake\.html\?c=cy#f=[A-Za-z0-9_-]{40,}$/.test(f1.link) && !JSON.stringify(DB.coach_intakes).includes(ftok), f1);
  const insp = B(await M.cpIntakeInspect({ token: ftok }));
  t('the open form shows the coach\'s brand and nothing else', insp.ok && typeof insp.brand === 'string' && !('email' in insp) && B(await M.cpIntakeInspect({ token: 'x'.repeat(43) })).error === 'bad_link', insp);
  t('answers need consent, an adult, and every required field', B(await M.cpIntakeSubmit({ token: ftok, answers: ANS })).error === 'consent_required'
    && B(await M.cpIntakeSubmit({ token: ftok, consent: true, answers: { ...ANS, age: 17 } })).error === 'bad_answers' && B(await M.cpIntakeSubmit({ token: ftok, consent: true, answers: { ...ANS, firstName: '<b>' } })).error === 'bad_answers');
  t('the client submits once', B(await M.cpIntakeSubmit({ token: ftok, consent: true, answers: ANS })).ok && B(await M.cpIntakeSubmit({ token: ftok, consent: true, answers: ANS })).error === 'bad_link' && B(await M.cpIntakeInspect({ token: ftok })).error === 'bad_link');
  const auto = DB.plan_builds.find((x) => x.from_form && /kim_newman$/.test(x.storage_key));
  const an = auto && DB.coach_client_state.find((x) => x.storage_key === auto.storage_key);
  t('a sent form starts the plan by itself: queued for the coach to review, nothing published', auto && auto.status === 'queued' && auto.is_update === false && auto.form.firstName === 'Kim'
    && auto.form.training === 'gym5_ppl_ul' && auto.form.menu === 'everyday' && auto.form.allergies.join() === 'peanut' && !('coach_id' in auto.form) && !DB.clients.some((c) => c.storage_key === auto.storage_key), auto);
  t('their health and food answers land in the coach\'s notes and the form is erased', an && /Old ankle sprain/.test(an.notes) && /No mushrooms/.test(an.notes) && /5 days a week at a gym/.test(an.notes) && !/script/.test(an.notes)
    && DB.coach_intakes[0].status === 'closed' && DB.coach_intakes[0].answers === null && B(await M.cpIntakes({ session: al3 })).forms.length === 0, an);
  t('the coach\'s plan list marks it as coming from their form', B(await M.cpClients({ session: al3 })).builds.some((x) => x.id === auto.id && x.fromForm === true));
  // the same name again while that plan is waiting: no second plan, the answers wait in the form list
  const f3 = B(await M.cpIntakeCreate({ session: al3 })), f3tok = f3.link.split('#f=')[1];
  const nBefore = DB.plan_builds.length;
  await M.cpIntakeSubmit({ token: f3tok, consent: true, answers: ANS });
  const forms = B(await M.cpIntakes({ session: al3 })).forms;
  t('a form that cannot start a plan waits in the list with cleaned answers: unknown keys dropped, markup stripped', DB.plan_builds.length === nBefore && forms.length === 1 && forms[0].status === 'submitted' && forms[0].answers.firstName === 'Kim' && !('coach_id' in forms[0].answers)
    && forms[0].answers.allergies.join() === 'peanut' && forms[0].answers.phone === '+61 400 000 000', forms[0]);
  t('another coach sees no forms and cannot close this one', B(await M.cpIntakes({ session: other.session })).forms.length === 0 && B(await M.cpIntakeClose({ session: other.session, id: forms[0].id })).error === 'unknown_form');
  t('another coach cannot build from this form', (await (async () => { const r = B(await M.cpBuildCreate({ session: other.session, form: { ...liveAnn.form, firstName: 'Thief' }, intakeId: f3.id })); return r.ok && DB.coach_intakes.find((x) => x.id === f3.id).status === 'submitted' && !DB.coach_client_state.some((x) => x.storage_key === r.storageKey); })()));
  const kb = B(await M.cpBuildCreate({ session: al3, form: { ...liveAnn.form, firstName: 'Kim', lastName: 'Newmanb' }, intakeId: f3.id }));
  const kn = DB.coach_client_state.find((x) => x.storage_key === kb.storageKey);
  t('building from a waiting form by hand saves the notes and erases the form', kb.ok && kn && /Old ankle sprain/.test(kn.notes) && /No mushrooms/.test(kn.notes)
    && DB.coach_intakes.find((x) => x.id === f3.id).status === 'closed' && DB.coach_intakes.find((x) => x.id === f3.id).answers === null, kn);
  const f4 = B(await M.cpIntakeCreate({ session: al3 }));
  await M.cpIntakeSubmit({ token: f4.link.split('#f=')[1], consent: true, answers: ANS });
  const f4row = B(await M.cpIntakes({ session: al3 })).forms[0];
  t('closing a form erases the answers', f4row && B(await M.cpIntakeClose({ session: al3, id: f4row.id })).ok && DB.coach_intakes.find((x) => x.id === f4row.id).answers === null && B(await M.cpIntakes({ session: al3 })).forms.length === 0);
  // the standing sign-up link
  const L1 = B(await M.cpIntakeLink({ session: al3 })), L1b = B(await M.cpIntakeLink({ session: al3 }));
  const code = (L1.link || '').split('#s=')[1];
  t('the coach has one standing sign-up link and it stays the same', L1.ok && /\/coach\/intake\.html\?c=cy#s=[A-Za-z0-9_-]{16,64}$/.test(L1.link) && L1b.link === L1.link && B(await M.cpIntakeLink({ session: 'x'.repeat(43) })).error === 'unauthorized', L1);
  const si = B(await M.cpIntakeInspect({ code }));
  t('the standing link shows the coach\'s brand, and a made-up one is dead', si.ok && si.brand === insp.brand && !('email' in si) && B(await M.cpIntakeInspect({ code: 'a'.repeat(24) })).error === 'bad_link');
  const ANS2 = { ...ANS, firstName: 'Lee', lastName: 'Standing', where: 'home', days: 3, allergies: [] };
  const s1 = B(await M.cpIntakeSubmit({ code, consent: true, answers: ANS2 })), s2 = B(await M.cpIntakeSubmit({ code, consent: true, answers: { ...ANS2, firstName: 'Mia' } }));
  const lee = DB.plan_builds.find((x) => /lee_standing$/.test(x.storage_key)), mia = DB.plan_builds.find((x) => /mia_standing$/.test(x.storage_key));
  t('the standing link works for many people, each one starting their own plan for this coach only', s1.ok && s2.ok && lee && mia && lee.from_form && lee.form.training === 'home5' && lee.coach_id === auto.coach_id && mia.coach_id === auto.coach_id
    && B(await M.cpIntakeSubmit({ code, answers: ANS2 })).error === 'consent_required' && B(await M.cpIntakeSubmit({ code, consent: true, answers: { ...ANS2, age: 17 } })).error === 'bad_answers', [s1, s2]);
  const L2 = B(await M.cpIntakeLink({ session: al3, reset: true }));
  t('a new link kills the old one', L2.ok && L2.link !== L1.link && B(await M.cpIntakeInspect({ code })).error === 'bad_link' && B(await M.cpIntakeSubmit({ code, consent: true, answers: ANS2 })).error === 'bad_link'
    && B(await M.cpIntakeInspect({ code: L2.link.split('#s=')[1] })).ok);
  const stamp = new Date().toISOString();
  for (let i = 0; i < 30; i++) DB.coach_intakes.push({ id: 'flood' + i, coach_id: auto.coach_id, status: 'closed', answers: null, created_at: stamp, token_hash: 'f' + i, expires_at: stamp });
  t('the standing link stops taking answers after 30 in a day', B(await M.cpIntakeSubmit({ code: L2.link.split('#s=')[1], consent: true, answers: { ...ANS2, firstName: 'Zed' } })).error === 'form_busy');
  DB.coach_intakes = DB.coach_intakes.filter((r) => !String(r.id).startsWith('flood'));
  const f2 = B(await M.cpIntakeCreate({ session: al3 }));
  DB.coach_intakes.find((r) => r.id === f2.id).expires_at = '2020-01-01T00:00:00Z';
  t('an expired link is dead', B(await M.cpIntakeInspect({ token: f2.link.split('#f=')[1] })).error === 'bad_link' && B(await M.cpIntakeSubmit({ token: f2.link.split('#f=')[1], consent: true, answers: ANS })).error === 'bad_link');

  console.log('coach platform — the coach dashboard only reaches the coach\'s own clients');
  const { admin: A } = require('./coach_platform_fixture.js');
  const scA = await M.tenantScope('dashboard', { coachToken: al3 }), scB = await M.tenantScope('dashboard', { coachToken: other.session });
  const mineKeys = DB.clients.filter((c) => c.coach_id === scA.coach.id).map((c) => c.storage_key).sort();
  t('a coach session opens a scope holding exactly their clients', scA && scA !== 'refused' && scA.keys.filter((k) => k.startsWith('c_')).sort().join() === mineKeys.join() && mineKeys.includes(ej.storageKey) && !scA.keys.includes('cruz_rehayem'), scA && scA.keys);
  t('Omar\'s token, a client, junk and cp* calls open no scope', (await M.tenantScope('dashboard', { coachToken: OMAR })) === null && (await M.tenantScope('dashboard', { coachToken: 'x'.repeat(50) })) === null
    && (await M.tenantScope('dashboard', {})) === null && (await M.tenantScope('cpClients', { coachToken: al3 })) === null);
  t('request types not opened to coaches are refused outright', ['clientCreate', 'intakeList', 'intakePromote', 'entitlementGrant', 'provisionSelfGuidedClient', 'testimonialsGet', 'checkinDraftsPut', 'legacyQueueGet', 'registryGetPrivate', 'someFutureEndpoint']
    .every((ty) => !M.TENANT_TYPES.has(ty)) && (await M.tenantScope('clientCreate', { coachToken: al3 })) === 'refused');
  DB.clients.push({ id: 'omar-client-1', storage_key: 'omar_only', coach_id: null, is_internal: false });
  DB.weight_logs.push({ client_key: 'omar_only', logged_at: '2026-11-20T00:00:00Z', weight_kg: 99 }, { client_key: ej.storageKey, logged_at: '2026-11-21T00:00:00Z', weight_kg: 77 });
  DB.meal_logs.push({ client_id: 'omar-client-1', logged_at: '2026-11-20T00:00:00Z', meal_name: 'secret' });
  DB.client_sessions.push({ storage_key: 'omar_only', access_status: 'active' });
  DB.roster_snapshots.push({ id: 1, snapshot_ts: '2026-11-20T00:00:00Z', roster_json: [{ storageKey: 'omar_only' }], coach_id: null });
  const inA = (fn) => M.TENANT.run(scA, fn);
  const seen = await inA(async () => ({
    clients: (await A.from('clients').select('*')).data, weights: (await A.from('weight_logs').select('*')).data, checkins: (await A.from('check_ins').select('*').gte('submitted_at', '2000')).data,
    meals: (await A.from('meal_logs').select('*')).data, sessions: (await A.from('client_sessions').select('*')).data, roster: (await A.from('roster_snapshots').select('*').order('snapshot_ts', { ascending: false }).limit(1)).data,
    photos: (await A.from('photo_uploads').select('*')).data, intakes: await A.from('intakes').select('*').eq('id', 1).maybeSingle(), coaches: await A.from('coaches').select('*'), unknown: await A.from('brand_new_table').select('*'),
  }));
  t('every read inside the scope is narrowed to the coach\'s clients', seen.clients.length === mineKeys.length && seen.clients.every((c) => c.coach_id === scA.coach.id) && seen.weights.length > 0 && seen.weights.every((w) => mineKeys.includes(w.client_key))
    && seen.checkins.every((c) => mineKeys.includes(c.client_key)) && seen.meals.every((m) => m.meal_name !== 'secret') && seen.sessions.every((x) => mineKeys.includes(x.storage_key)) && seen.photos.every((x) => mineKeys.includes(x.client_key))
    && seen.roster.length === 0, { w: seen.weights.length, r: seen.roster });
  t('tables with no rule are closed: Omar\'s intakes, the coaches table, any future table', seen.intakes.data === null && !!seen.intakes.error && seen.coaches.data === null && seen.unknown.data === null);
  const wr = await inA(async () => ({
    log: await A.from('weight_logs').insert({ client_key: ej.storageKey, weight_kg: 1 }), client: await A.from('clients').update({ coach_id: scA.coach.id }).eq('storage_key', 'omar_only'),
    steal: await A.from('client_sessions').update({ access_status: 'revoked' }).eq('storage_key', 'omar_only'), own: await A.from('client_sessions').update({ reason: 'tenant-test' }).eq('storage_key', ej.storageKey),
    foreignRow: await A.from('access_log').insert({ client_key: 'omar_only', event: 'x' }), ownRow: await A.from('access_log').insert({ client_key: ej.storageKey, event: 'tenant-test' }),
    move: await A.from('client_sessions').update({ storage_key: 'omar_only' }).eq('storage_key', ej.storageKey), del: await A.from('weight_logs').delete().eq('client_key', 'omar_only'),
    roster: await A.from('roster_snapshots').insert({ snapshot_ts: '2026-11-25T00:00:00Z', roster_json: [{ storageKey: ej.storageKey }], coach_id: 'forged' }), product: await A.from('products').insert({ code: 'free' }),
  }));
  t('writes: read-only tables refuse, a foreign row is untouched, an own row changes', !!wr.log.error && !!wr.client.error && DB.clients.find((c) => c.storage_key === 'omar_only').coach_id === null
    && DB.client_sessions.find((x) => x.storage_key === 'omar_only').access_status === 'active' && DB.client_sessions.find((x) => x.storage_key === ej.storageKey).reason === 'tenant-test'
    && !!wr.foreignRow.error && !DB.access_log.some((x) => x.client_key === 'omar_only') && DB.access_log.some((x) => x.event === 'tenant-test') && !!wr.move.error && !!wr.del.error
    && DB.weight_logs.some((w) => w.client_key === 'omar_only') && !!wr.product.error, wr);
  const rosterMine = await inA(async () => (await A.from('roster_snapshots').select('*').order('snapshot_ts', { ascending: false }).limit(1)).data);
  t('the roster a coach saves is stamped as theirs and is the only one they read back', rosterMine.length === 1 && rosterMine[0].coach_id === scA.coach.id && rosterMine[0].roster_json[0].storageKey === ej.storageKey
    && (await M.TENANT.run(scB, async () => (await A.from('roster_snapshots').select('*')).data)).length === 0 && DB.roster_snapshots.find((r) => r.id === 1).coach_id === null);
  const both = await Promise.all([M.TENANT.run(scA, async () => { await new Promise((r) => setTimeout(r, 15)); return (await A.from('clients').select('*')).data.map((c) => c.coach_id); }),
    M.TENANT.run(scB, async () => { await new Promise((r) => setTimeout(r, 5)); return (await A.from('clients').select('*')).data.map((c) => c.coach_id); }),
    (async () => { await new Promise((r) => setTimeout(r, 10)); return (await A.from('clients').select('*')).data.length; })()]);
  t('two coaches at the same moment never see each other, and Omar outside any scope sees everything', both[0].every((x) => x === scA.coach.id) && both[1].every((x) => x === scB.coach.id) && both[0].length > 0 && both[2] === DB.clients.length, both);
  const gone = await M.tenantScope('dashboard', { coachToken: other.session });
  await M.cpCoachSetStatus({ coachToken: OMAR, slug: other.coach ? other.coach.slug : scB.coach.slug, status: 'suspended' });
  t('a suspended coach opens no scope', gone !== null && (await M.tenantScope('dashboard', { coachToken: other.session })) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
