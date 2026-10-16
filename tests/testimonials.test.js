// TESTIMONIALS V1 (Omar 2026-10-16) — the real handler source against an in-memory testimonials table.
//   link create is coach-only, stores only a sha256 · form get / submit by link token only · expired / unknown / malformed
//   tokens refused · answers trimmed + length-capped · consent enums only (unanswered = no) · editable, first submit time
//   kept · coach list returns answers, never the token
const ts = require('typescript');
const fs = require('fs');
const crypto = require('crypto');
const SRC = fs.readFileSync('supabase/functions/api/index.ts', 'utf8');
const i = SRC.indexOf('const TESTI_TTL_DAYS');
if (i < 0) throw new Error('locate testimonial handlers');
const js = ts.transpileModule(SRC.slice(i), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const DB = { testimonials: [], clients: [{ storage_key: 'ali_khan', display_name: 'Ali Khan' }] };
let nextId = 1;
function table(name) {
  const q = { f: [], upd: null, ins: null };
  q.select = () => q; q.order = () => q; q.limit = () => q;
  q.eq = (c, v) => { q.f.push([c, v]); return q; };
  q.maybeSingle = () => { q.single = true; return q; };
  q.update = (p) => { q.upd = p; return q; };
  q.insert = async (row) => { if (name === 'testimonials') DB.testimonials.push(Object.assign({ id: nextId++, created_at: new Date().toISOString(), submitted_at: null, updated_at: null, answers: {}, consent: {} }, row)); return { error: null }; };
  q.then = (res) => {
    const rows = DB[name].filter((r) => q.f.every(([c, v]) => r[c] === v));
    if (q.upd) { rows.forEach((r) => Object.assign(r, q.upd)); return res({ data: rows, error: null }); }
    return res({ data: q.single ? (rows[0] ? Object.assign({}, rows[0]) : null) : rows.map((r) => Object.assign({}, r)), error: null });
  };
  return q;
}
const admin = { from: table };
const json = (o) => ({ __body: o });
const ok = (e = {}) => json({ ok: true, ...e });
const err = (r, e = {}) => json({ ok: false, error: r, ...e });
const verifyCoachToken = (t) => t === 'coach';
const sha256 = async (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const M = {};
new Function('admin', 'ok', 'err', 'verifyCoachToken', 'sha256', 'randomToken', 'exports',
  js + '\nObject.assign(exports, { testimonialLinkCreate, testimonialFormGet, testimonialSubmit, testimonialsGet });')(admin, ok, err, verifyCoachToken, sha256, randomToken, M);

let pass = 0, fail = 0;
const t = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -- ' + JSON.stringify(d).slice(0, 300) : '')); } };
const B = (r) => r.__body;

(async () => {
  console.log('testimonials');
  t('link create needs the coach token', B(await M.testimonialLinkCreate({ coachToken: 'client', client: 'ali_khan' })).error === 'unauthorized');
  t('list needs the coach token', B(await M.testimonialsGet({})).error === 'unauthorized');
  t('link for an unknown client refused', B(await M.testimonialLinkCreate({ coachToken: 'coach', client: 'nobody' })).error === 'unknown_client');
  t('link for a malformed key refused', B(await M.testimonialLinkCreate({ coachToken: 'coach', client: "x'; drop" })).error === 'bad_client');
  const L = B(await M.testimonialLinkCreate({ coachToken: 'coach', client: 'ali_khan' }));
  t('link created: token + first name + 30-day expiry', L.ok && L.token.length >= 40 && L.firstName === 'Ali' && Math.round((Date.parse(L.expiresAt) - Date.now()) / 864e5) === 30, L);
  t('only the sha256 of the token is stored', DB.testimonials[0].token_hash === crypto.createHash('sha256').update(L.token).digest('hex') && !JSON.stringify(DB.testimonials).includes(L.token));

  const g = B(await M.testimonialFormGet({ t: L.token }));
  t('form get by token: first name, nothing submitted yet', g.ok && g.firstName === 'Ali' && g.submittedAt === null, g);
  for (const [n, tok] of [['unknown', 'A'.repeat(43)], ['malformed', '../../etc'], ['missing', undefined], ['short', 'abc']]) {
    t('form get with a ' + n + ' token -> link_invalid', B(await M.testimonialFormGet({ t: tok })).error === 'link_invalid');
  }
  t('submit with a bad token -> link_invalid (nothing written)', B(await M.testimonialSubmit({ t: 'B'.repeat(43), answers: { q1: 'x' } })).error === 'link_invalid' && !DB.testimonials[0].submitted_at);
  t('an empty submission is refused', B(await M.testimonialSubmit({ t: L.token, answers: { q6: 'only private' } })).error === 'empty');
  t('an over-long answer is refused', B(await M.testimonialSubmit({ t: L.token, answers: { q1: 'x'.repeat(1501) } })).error === 'too_long');
  t('a made-up consent value is refused', B(await M.testimonialSubmit({ t: L.token, answers: { q1: 'x' }, consent: { photos: 'everything' } })).error === 'bad_consent');
  const s = B(await M.testimonialSubmit({ t: L.token, answers: { name: '  Ali ', q1: '  Kept falling off.\r\nNo plan.  ', q2: 'Down 4.7 kg', q9: 'ignored', evil: '<script>' }, consent: { name: 'initials', photos: 'face_hidden' } }));
  const row = DB.testimonials[0];
  t('submit saves trimmed answers, only known fields', s.ok && row.answers.q1 === 'Kept falling off.\nNo plan.' && row.answers.name === 'Ali' && !('q9' in row.answers) && !('evil' in row.answers), row.answers);
  t('consent saved; the unanswered one counts as no', row.consent.name === 'initials' && row.consent.photos === 'face_hidden' && row.consent.numbers === 'no', row.consent);
  const first = row.submitted_at;
  await new Promise((r) => setTimeout(r, 5));
  B(await M.testimonialSubmit({ t: L.token, answers: { q1: 'Edited', q2: 'Down 4.7 kg' }, consent: { name: 'yes', photos: 'yes', numbers: 'yes' } }));
  t('editing keeps the first submit time, updates the answers', row.submitted_at === first && row.answers.q1 === 'Edited' && row.consent.numbers === 'yes' && row.updated_at >= first);
  const g2 = B(await M.testimonialFormGet({ t: L.token }));
  t('form get then shows their own answers back', g2.answers.q1 === 'Edited' && !!g2.submittedAt);
  const list = B(await M.testimonialsGet({ coachToken: 'coach' }));
  t('coach list: answers + consent, never the token or its hash', list.ok && list.testimonials.length === 1 && list.testimonials[0].answers.q2 === 'Down 4.7 kg' && !JSON.stringify(list).includes(L.token), list);
  t('the select never asks for token_hash', !/select\('[^']*token_hash/.test(SRC.slice(SRC.indexOf('async function testimonialsGet'))));
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  t('an expired link -> link_invalid for get and submit', B(await M.testimonialFormGet({ t: L.token })).error === 'link_invalid' && B(await M.testimonialSubmit({ t: L.token, answers: { q1: 'late' } })).error === 'link_invalid' && row.answers.q1 === 'Edited');
  t('the dispatch table routes all four actions', ['testimonialLinkCreate', 'testimonialFormGet', 'testimonialSubmit', 'testimonialsGet'].every((a) => SRC.includes("case '" + a + "':")));
  t('the public actions are documented in the ungated list', SRC.includes('testimonialFormGet / testimonialSubmit'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
