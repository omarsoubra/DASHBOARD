#!/usr/bin/env python3
"""
LOCKED IN Workout Completion V1 — surgical shell patch (Finish Workout).

    python3 scripts/workouts/patch_completion_shell.py --file SHELL.html [--check] [--out OUT.html]

Adds the explicit Finish Workout action to the Training V2 block of ONE shell.
Four edits, all inside <script id="tv2-js">, each at an anchor that must occur
exactly once (otherwise the shell is REFUSED and nothing is written):

  1. BLOCK   the WORKOUT-COMPLETION-V1 functions, inserted before the GUIDE section
  2. WORKOUT one Finish Workout bar on the workout screen (before "Start this workout again")
  3. DONE    the completion status block on the session summary (before the tiles)
  4. BOOT    one call that re-sends pending completions / restores them at boot

Nothing else changes: no prescription, no programme payload, no exercise logging
path, no auth wiring. patch_and_prove() returns the patched text together with the
edit list, and proves that removing the four insertions reproduces the original
bytes exactly (reversal proof). The patch is idempotent (marker check).
Live client shells are never written by this tool unless --out/--file is given
explicitly; it never commits or deploys anything.
"""
import argparse
import hashlib
import sys

MARKER = 'WORKOUT-COMPLETION-V1'


class PatchError(Exception):
    pass


BLOCK = r"""  // ============================================= WORKOUT-COMPLETION-V1
  /* The client's EXPLICIT statement "I completed this workout" (Finish Workout).
     It is NEVER derived from exercise logs: the automatic TV2 'complete' status
     above stays as it was and creates nothing on the server. Only tv2Finish()
     does, after a deliberate tap (plus a confirmation when exercises are
     unlogged). One completion ref is minted per occurrence and saved in the
     ledger BEFORE any network write, so double taps, refreshes, retries,
     offline/online and app restarts all converge on one server row
     (api: workoutComplete is idempotent on (client, ref)).
     s.wc = { ref, state: 'pending'|'synced'|'error', finishedAt, localDate, tz,
              snap: {...}, recordedAt, err, revoked, revokedAt }
     s.wcPast = [ { ref, revokedAt } ]   refs that were undone (audit only). */
  var WC_UNDO_MS = 24 * 3600e3;
  var WC_TRANSIENT = /^(network|timeout|http_5\d\d|http_429|db_error|write_failed|internal_error|bad_response|refused)$/;
  var wcInFlight = {};
  function wcRef() {
    try {
      if (window.crypto && crypto.randomUUID) return 'cmp_' + crypto.randomUUID();
      if (window.crypto && crypto.getRandomValues) {
        var a = new Uint8Array(16); crypto.getRandomValues(a);
        return 'cmp_' + [].map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }
    } catch (e) {}
    return 'cmp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  }
  function wcTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } }
  function wcKind(d) {
    var b = String((d && d.badge) || ''), l = String((d && d.label) || '');
    if (/optional/i.test(b) || /optional/i.test(l)) return 'optional';
    if (/^\s*mandatory\s*$/i.test(b)) return 'mandatory';
    return 'unspecified';
  }
  function wcHex(buf) { return [].map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function wcFingerprint(s) {
    try {
      if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.resolve(null);
      var names = (s.exs || []).map(function (x) { return String(x.subFor || x.name); }).join('\n');
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(names)).then(wcHex, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function wcFindRef(ref) {
    var L = ledgerLoad(), hit = null;
    Object.keys(L).forEach(function (k) {
      var m = k.match(/^p([^.]+)\.d(\d+)$/); if (!m) return;
      (L[k] || []).forEach(function (s) { if (s && s.wc && s.wc.ref === ref) hit = { ph: m[1], di: Number(m[2]), s: s }; });
    });
    return hit;
  }
  function wcAll() {
    var L = ledgerLoad(), out = [];
    Object.keys(L).forEach(function (k) {
      var m = k.match(/^p([^.]+)\.d(\d+)$/); if (!m) return;
      (L[k] || []).forEach(function (s) { if (s && s.wc) out.push({ ph: m[1], di: Number(m[2]), s: s }); });
    });
    return out;
  }
  /* The client's latest recorded (not undone) completion — the only one the
     server lets them undo, and only within 24 h of it being recorded. */
  function wcCanUndo(s) {
    if (!s || !s.wc || s.wc.state !== 'synced' || s.wc.revoked) return false;
    if (!(Date.now() - Date.parse(s.wc.recordedAt || s.wc.finishedAt || '') < WC_UNDO_MS)) return false;
    var mine = Date.parse(s.wc.finishedAt || '') || 0;
    return !wcAll().some(function (x) { return x.s.wc.ref !== s.wc.ref && !x.s.wc.revoked && x.s.wc.state !== 'error' && (Date.parse(x.s.wc.finishedAt || '') || 0) > mine; });
  }
  function wcRepaint() { try { if (V.view === 'done' || V.view === 'workout') show(V.view); } catch (e) {} }
  function wcSend(ph, di, sid) {
    var s = findSession(ph, di, sid); if (!s || !s.wc || s.wc.revoked || s.wc.state === 'synced') return Promise.resolve(null);
    if (typeof cloudWrite !== 'function') return Promise.resolve(null);
    var ref = s.wc.ref; if (wcInFlight[ref]) return wcInFlight[ref];
    var p = cloudWrite('workoutComplete', { completion: {
        ref: ref, phase: String(ph), dayIdx: Number(di), dayLabel: s.wc.snap.dayLabel, sessionKind: s.wc.snap.sessionKind,
        rxFingerprint: s.wc.snap.rxFingerprint, exercisesPrescribed: s.wc.snap.exercisesPrescribed,
        exercisesLogged: s.wc.snap.exercisesLogged, setsLogged: s.wc.snap.setsLogged,
        completedAt: s.wc.finishedAt, localDate: s.wc.localDate, timezone: s.wc.tz || null } })
      .then(function (r) {
        var cur = findSession(ph, di, sid); if (!cur || !cur.wc || cur.wc.ref !== ref) return r;
        if (r && r.ok && r.data && r.data.completion) {
          var c = r.data.completion;
          cur.wc.state = 'synced'; cur.wc.err = null; cur.wc.recordedAt = c.recordedAt || null;
          if (c.status === 'revoked') { cur.wc.revoked = true; cur.wc.revokedAt = c.revokedAt || null; }
        } else {
          var e = String((r && r.error) || 'network');
          cur.wc.err = e; cur.wc.state = WC_TRANSIENT.test(e) ? 'pending' : 'error';
        }
        putSession(ph, di, cur); wcRepaint(); return r;
      }, function () { return null; })
      .then(function (r) { delete wcInFlight[ref]; return r; }, function () { delete wcInFlight[ref]; return null; });
    wcInFlight[ref] = p;
    return p;
  }
  function wcFlushPending() {
    wcAll().forEach(function (x) { if (x.s.wc.state === 'pending' && !x.s.wc.revoked) wcSend(x.ph, x.di, x.s.sid); });
  }
  /* A fresh device has no ledger entries for completions made elsewhere; attach
     server completions to the matching (phase, day, local date) session only.
     Nothing is created and nothing is inferred when there is no match. */
  function wcRestore() {
    if (typeof cloudWrite !== 'function') return;
    cloudWrite('workoutCompletionsGet', {}).then(function (r) {
      if (!(r && r.ok && r.data && r.data.completions)) return;
      var changed = false;
      r.data.completions.forEach(function (c) {
        if (wcFindRef(c.ref)) return;
        var ss = sessionsOf(String(c.phase), Number(c.dayIdx));
        for (var i = ss.length - 1; i >= 0; i--) {
          var s = ss[i];
          if (s.wc || dayOf(s.completedAt || s.startedAt) !== c.localDate) continue;
          s.wc = { ref: c.ref, state: 'synced', finishedAt: c.completedAt, localDate: c.localDate, tz: c.timezone || '',
                   snap: { dayLabel: c.dayLabel, sessionKind: c.sessionKind, rxFingerprint: c.rxFingerprint,
                           exercisesPrescribed: c.exercisesPrescribed, exercisesLogged: c.exercisesLogged, setsLogged: c.setsLogged },
                   recordedAt: c.recordedAt, err: null, revoked: c.status === 'revoked', revokedAt: c.revokedAt || null, restored: true };
          putSession(String(c.phase), Number(c.dayIdx), s); changed = true; break;
        }
      });
      if (changed) wcRepaint();
    }, function () {});
  }
  function wcBoot() {
    wcFlushPending(); wcRestore();
    if (!window.__wcListen) {
      window.__wcListen = true;
      window.addEventListener('online', wcFlushPending);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') wcFlushPending(); });
    }
  }
  /* The session Finish applies to: the open occurrence, the fresh sheet (none
     yet), or the LATEST native occurrence of this day when it finished itself
     (all sets logged) or its completion was undone. Never history, never a
     session rebuilt from the cloud. */
  function wcTarget(s0) {
    var s = arguments.length ? s0 : curSession();
    if (!s) return { fresh: true, s: null };
    if (s.status === 'open') return { fresh: false, s: s };
    var last = lastSession(V.phase, V.day);
    if (last && last.sid === s.sid && !s.restored && s.status === 'complete' && (!s.wc || s.wc.revoked)) return { fresh: false, s: s };
    return null;
  }
  function wcFinishBar() {
    if (V.fix || !wcTarget()) return '';
    return '<button class="tv2-cta" style="margin-top:1.4rem;" onclick="tv2Finish()">Finish workout</button>';
  }
  function wcDoneBlock(s) {
    var w = s && s.wc, h = '';
    if (w && !w.revoked && w.state === 'synced') {
      h = '<div class="tv2-pres" style="margin:.9rem 0 0;color:inherit;"><b>✓ Workout completed</b> · ' + esc(fmtDate(w.finishedAt)) + '</div>' +
          (wcCanUndo(s) ? '<button class="tv2-link" onclick="tv2FinishUndo()">Undo completion<span>›</span></button>' : '');
    } else if (w && !w.revoked && w.state === 'pending') {
      h = '<div class="tv2-unsync"><span aria-hidden="true">✓</span><span><b>Finished · saved on this phone.</b> It will be sent to your coach when you are online.</span></div>' +
          '<button class="tv2-link" onclick="tv2FinishSync()">Send now<span>›</span></button>';
    } else if (w && !w.revoked && w.state === 'error') {
      h = '<div class="tv2-unsync"><span aria-hidden="true">!</span><span><b>This completion could not be recorded</b> (' + esc(w.err || 'error') + '). Tell your coach if it keeps happening.</span></div>';
    } else if (w && w.revoked) {
      h = '<div class="tv2-pres" style="margin:.9rem 0 0;">Completion undone' + (w.revokedAt ? ' · ' + esc(fmtDate(w.revokedAt)) : '') + '</div>';
    }
    return h + (s && wcTarget(s) && !V.fix ? '<button class="tv2-cta" style="margin-top:1.4rem;" onclick="tv2Finish()">Finish workout</button>' : '');
  }
  window.tv2Finish = function () {
    var t = wcTarget(); if (!t) return;
    var exs = t.s ? t.s.exs : dayExs(), pr = t.s ? progressIn(t.s) : { done: 0, total: exs.length };
    if (pr.done === 0 && !(t.s && Object.keys(t.s.entries || {}).length)) {
      if (!window.confirm('No exercises have been logged. Mark this workout as completed?')) return;
    } else if (pr.done < pr.total) {
      if (!window.confirm('Finish workout with ' + pr.done + ' of ' + pr.total + ' exercises logged?')) return;
    }
    flushAll();
    var s = t.s || createSession(V.phase, V.day); if (!s) return;
    V.sid = s.sid; V.fresh = false;
    if (s.wc && !s.wc.revoked) { wcSend(V.phase, V.day, s.sid); show('done'); return; }   /* already finished: converge, never re-mint */
    if (s.wc && s.wc.revoked) { (s.wcPast = s.wcPast || []).push({ ref: s.wc.ref, revokedAt: s.wc.revokedAt || null }); }
    var d = tv2Day(V.phase, V.day) || {}, st = sessionStats(s), p2 = progressIn(s), now = nowIso();
    if (s.status === 'open') { s.status = 'complete'; s.completedAt = now; }
    s.wc = { ref: wcRef(), state: 'pending', finishedAt: now, localDate: dayOf(now), tz: wcTz(),
             snap: { dayLabel: String(d.label || ('Day ' + (Number(V.day) + 1))).slice(0, 120), sessionKind: wcKind(d), rxFingerprint: null,
                     exercisesPrescribed: p2.total, exercisesLogged: p2.done, setsLogged: st.sets },
             recordedAt: null, err: null, revoked: false, revokedAt: null };
    putSession(V.phase, V.day, s);                         /* persisted BEFORE the network write */
    show('done');
    var ph = V.phase, di = V.day, sid = s.sid;
    wcFingerprint(s).then(function (fp) {
      var cur = findSession(ph, di, sid);
      if (cur && cur.wc && cur.wc.state === 'pending' && cur.wc.snap.rxFingerprint == null && fp) { cur.wc.snap.rxFingerprint = fp; putSession(ph, di, cur); }
      wcSend(ph, di, sid);
    });
  };
  window.tv2FinishSync = function () { var s = curSession(); if (s && s.wc) { if (s.wc.state === 'error') s.wc.state = 'pending'; putSession(V.phase, V.day, s); wcSend(V.phase, V.day, s.sid); } };
  window.tv2FinishUndo = function () {
    var s = curSession(); if (!wcCanUndo(s)) return;
    if (!window.confirm('Undo this workout completion? Your logged sets stay as they are.')) return;
    var ph = V.phase, di = V.day, sid = s.sid, ref = s.wc.ref;
    cloudWrite('workoutCompleteUndo', { ref: ref }).then(function (r) {
      var cur = findSession(ph, di, sid); if (!cur || !cur.wc || cur.wc.ref !== ref) return;
      if (r && r.ok && r.data && r.data.completion && r.data.completion.status === 'revoked') {
        cur.wc.revoked = true; cur.wc.revokedAt = r.data.completion.revokedAt || nowIso(); putSession(ph, di, cur); wcRepaint();
      } else { window.alert('Could not undo right now (' + String((r && r.error) || 'network') + ').'); }
    });
  };
  // =========================================== END WORKOUT-COMPLETION-V1

"""

EDITS = [
    # (name, anchor, text inserted immediately BEFORE the anchor)
    ('BLOCK', '  // ============================================================== GUIDE\n', BLOCK),
    ('WORKOUT', "(upRows ? '<span class=\"tv2-sec\">Upcoming exercises</span>' + upRows : '') + abandon;",
     None),
    ('DONE', "'<div class=\"tv2-tiles\">' + tiles + '</div>' +", "wcDoneBlock(s) + /* WORKOUT-COMPLETION-V1 */ "),
    ('BOOT', "    try { ledgerSync(); } catch (e) {}\n    var rp = null; try { rp = resolvePhase(); } catch (e) {}\n    V.phase = String((rp && phases[rp])",
     "    try { wcBoot(); } catch (eWc) {}   /* WORKOUT-COMPLETION-V1 */\n"),
]
# WORKOUT: insert after the upcoming list, before `abandon`
WORKOUT_OLD = "(upRows ? '<span class=\"tv2-sec\">Upcoming exercises</span>' + upRows : '') + abandon;"
WORKOUT_INS = "wcFinishBar() + /* WORKOUT-COMPLETION-V1 */ "
WORKOUT_AT = WORKOUT_OLD.index('abandon;')


def sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def _tv2_bounds(src):
    a = src.find('<script id="tv2-js">')
    if a < 0:
        raise PatchError('no Training V2 block (<script id="tv2-js">)')
    b = src.find('</script>', a)
    if b < 0:
        raise PatchError('unterminated Training V2 block')
    if src.find('<script id="tv2-js">', a + 1) >= 0:
        raise PatchError('more than one Training V2 block')
    return a, b


def plan(src):
    """Return [(offset, text)] insertions, or None when already integrated."""
    if MARKER in src:
        return None
    a, b = _tv2_bounds(src)
    tv2 = src[a:b]
    out = []
    for name, anchor, text in EDITS:
        n = tv2.count(anchor)
        if n != 1:
            raise PatchError(f'anchor {name} occurs {n}x in the Training V2 block (need exactly 1)')
        off = a + tv2.index(anchor)
        if name == 'WORKOUT':
            out.append((name, off + WORKOUT_AT, WORKOUT_INS))
        elif name == 'BOOT':
            # after the ledgerSync() line of boot()
            out.append((name, off + anchor.index('    var rp'), text))
        else:
            out.append((name, off, text))
    for name in ('tv2Finish', 'wcBoot', 'wcDoneBlock', 'wcFinishBar'):
        if name in tv2:
            raise PatchError(f'identifier {name} already present — refusing to shadow it')
    for dep in ('function findSession(', 'function putSession(', 'function sessionsOf(', 'function createSession(',
                'function progressIn(', 'function sessionStats(', 'function flushAll(', 'function ledgerLoad(',
                'function dayOf(', 'function fmtDate(', 'function esc('):
        if dep not in tv2:
            raise PatchError(f'Training V2 block lacks {dep.strip("(")} — incompatible shell')
    if 'async function cloudWrite(' not in src:
        raise PatchError('shell has no cloudWrite() — not wired to the api')
    return sorted(out, key=lambda x: x[1])


def apply(src, edits):
    out, last = [], 0
    for _, off, text in edits:
        out.append(src[last:off]); out.append(text); last = off
    out.append(src[last:])
    return ''.join(out)


def unpatch(patched, edits):
    """Remove the insertions from the PATCHED text (positions shift by earlier inserts)."""
    res, shift = patched, 0
    for _, off, text in edits:
        p = off + shift
        if res[p:p + len(text)] != text:
            raise PatchError('reversal: insertion not found where expected')
        res = res[:p] + res[p + len(text):]
    return res


def patch_and_prove(src):
    edits = plan(src)
    if edits is None:
        return src, None
    out = apply(src, edits)
    if unpatch(out, edits) != src:
        raise PatchError('reversal proof failed')
    if out.count(MARKER) < 4:
        raise PatchError('marker count unexpected')
    return out, edits


def describe(src, edits):
    return [{'edit': n, 'offset': off, 'inserted_bytes': len(t.encode('utf-8')), 'inserted_sha256': sha(t)} for n, off, t in edits]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--check', action='store_true', help='prove only; write nothing')
    ap.add_argument('--out', help='write the patched shell here (default: in place)')
    a = ap.parse_args()
    raw = open(a.file, 'rb').read()
    src = raw.decode('utf-8')
    try:
        out, edits = patch_and_prove(src)
    except PatchError as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        sys.exit(2)
    if edits is None:
        print('already integrated (no change)')
        return
    for d in describe(src, edits):
        print(f"{d['edit']:8s} @{d['offset']:>8d}  +{d['inserted_bytes']} bytes  {d['inserted_sha256'][:16]}")
    print(f'original {sha(src)[:16]} → patched {sha(out)[:16]}   reversal: OK')
    if a.check:
        return
    open(a.out or a.file, 'wb').write(out.encode('utf-8'))
    print('written:', a.out or a.file)


if __name__ == '__main__':
    main()
