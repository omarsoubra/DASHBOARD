// CHECK-IN REPLY DRAFTS (Omar 2026-10-13) — the real handler source against an in-memory checkin_drafts table.
//   coach-only on every action · upsert by (client_key, checkin_ts) never resets sent_at · bad keys refused ·
//   mark / unmark sent · get returns recent drafts
const ts = require('typescript');
const fs = require('fs');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const i = SRC.indexOf('const CI_KEY_RE'), j = SRC.indexOf('async function registryGetPrivate');
if (i < 0 || j < 0) throw new Error('locate check-in draft handlers');
const js = ts.transpileModule(SRC.slice(i, j), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

let ROWS = [];
function table() {
  const q = { f: [], gte: null, upd: null };
  q.select = () => q; q.order = () => q; q.limit = () => q;
  q.gte = (c, v) => { q.gte = [c, v]; return q; };
  q.eq = (c, v) => { q.f.push([c, v]); return q; };
  q.neq = (c, v) => { q.nf = [c, v]; return q; }; q.maybeSingle = () => { q.single = true; return q; };
  q.update = (p) => { q.upd = p; return q; };
  q.upsert = async (rows) => {
    for (const r of [].concat(rows)) {
      const ex = ROWS.find(x => x.client_key === r.client_key && x.checkin_ts === r.checkin_ts);
      if (ex) Object.assign(ex, r); else ROWS.push(Object.assign({ created_at: new Date().toISOString(), sent_at: null }, r));
    }
    return { error: null };
  };
  q.then = (res) => {
    if (q.upd) {
      const hit = ROWS.filter(r => q.f.every(([c, v]) => r[c] === v)); hit.forEach(r => Object.assign(r, q.upd));
      return res({ data: hit.map(r => ({ sent_at: r.sent_at })), error: null });
    }
    const out = ROWS.filter(r => (!Array.isArray(q.gte) || r[q.gte[0]] >= q.gte[1]) && q.f.every(([c, v]) => r[c] === v) && (!q.nf || r[q.nf[0]] !== q.nf[1]));
    return res({ data: q.single ? (out[0] || null) : out, error: null });
  };
  return q;
}
const admin = { from: table };
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const verifyCoachToken = (t) => t === 'coach';
const M = {};
new Function('admin', 'ok', 'err', 'verifyCoachToken', 'exports',
  js + '\nObject.assign(exports, { checkinDraftsGet, checkinDraftsPut, checkinDraftMark, coachSettingsGet, coachSettingsPut });')(admin, ok, err, verifyCoachToken, M);

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -- ' + JSON.stringify(d).slice(0, 300) : '')); } };
const B = r => r.__body;
const D = { clientKey: 'bishoy_shaker', checkinTs: '2026-10-12T09:15:00.000Z', action: 'hold', forCoach: ['Phase 2 starts this week'], draft: 'Bishoy, appreciate you being honest about the week bro.' };

(async () => {
  console.log('check-in drafts');
  for (const [name, fn, body] of [['get', M.checkinDraftsGet, {}], ['put', M.checkinDraftsPut, { drafts: [D] }], ['mark', M.checkinDraftMark, { clientKey: D.clientKey, checkinTs: D.checkinTs }]]) {
    t(`${name} without the coach token -> unauthorized`, B(await fn(Object.assign({ coachToken: 'client-token' }, body))).error === 'unauthorized');
  }
  t('put stores a draft', B(await M.checkinDraftsPut({ coachToken: 'coach', drafts: [D] })).count === 1 && ROWS.length === 1);
  const g = B(await M.checkinDraftsGet({ coachToken: 'coach' }));
  t('get returns it with for_coach + draft', g.ok && g.drafts.length === 1 && g.drafts[0].draft === D.draft && g.drafts[0].for_coach[0] === 'Phase 2 starts this week', g);
  const m = B(await M.checkinDraftMark({ coachToken: 'coach', clientKey: D.clientKey, checkinTs: D.checkinTs }));
  t('mark sets sent_at', m.ok && !!m.sent_at && !!ROWS[0].sent_at, m);
  await M.checkinDraftsPut({ coachToken: 'coach', drafts: [Object.assign({}, D, { draft: 'Reworded draft.' })] });
  t('re-publishing the same check-in updates the text but keeps it sent (no duplicate row)', ROWS.length === 1 && ROWS[0].draft === 'Reworded draft.' && !!ROWS[0].sent_at);
  t('unmark clears sent_at', B(await M.checkinDraftMark({ coachToken: 'coach', clientKey: D.clientKey, checkinTs: D.checkinTs, sent: false })).sent_at === null && ROWS[0].sent_at === null);
  t('a bad client key is refused', B(await M.checkinDraftsPut({ coachToken: 'coach', drafts: [Object.assign({}, D, { clientKey: "x'; drop" })] })).error === 'bad_draft');
  t('marking an unknown check-in -> not_found', B(await M.checkinDraftMark({ coachToken: 'coach', clientKey: 'nobody', checkinTs: '2026-10-12T09:15:00.000Z' })).error === 'not_found');
  // coach rules (Omar 2026-10-14)
  t('rules: coach token required', B(await M.coachSettingsPut({ coachToken: 'x', rules: { quietDays: 4 } })).error === 'unauthorized' && B(await M.coachSettingsGet({})).error === 'unauthorized');
  t('rules: empty at first', JSON.stringify(B(await M.coachSettingsGet({ coachToken: 'coach' })).rules) === '{}');
  const sp = B(await M.coachSettingsPut({ coachToken: 'coach', rules: { quietDays: 4, wrongWayKg14: 0.8, lowSteps: 7000 } }));
  t('rules: saved and read back on any device', sp.ok && B(await M.coachSettingsGet({ coachToken: 'coach' })).rules.wrongWayKg14 === 0.8, sp);
  t('rules: an unknown rule is refused', B(await M.coachSettingsPut({ coachToken: 'coach', rules: { deleteEverything: 1 } })).error === 'unknown_rule');
  t('rules: out-of-range refused (quiet 0 days)', B(await M.coachSettingsPut({ coachToken: 'coach', rules: { quietDays: 0 } })).error === 'out_of_range');
  t('rules: the settings row never shows up as a draft', !B(await M.checkinDraftsGet({ coachToken: 'coach' })).drafts.some((d) => d.client_key === '_coach'));
  await M.coachSettingsPut({ coachToken: 'coach', rules: { quietDays: 5 } });
  t('rules: saving again replaces (one row, last write wins)', ROWS.filter((r) => r.client_key === '_coach').length === 1 && B(await M.coachSettingsGet({ coachToken: 'coach' })).rules.quietDays === 5);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
