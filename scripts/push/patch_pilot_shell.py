#!/usr/bin/env python3
"""
LOCKED IN Push Notifications V1 — pilot shell integration (byte-surgical).

    python3 scripts/push/patch_pilot_shell.py <storage_key> [--check] [--out FILE]

Makes exactly FOUR edits to clients/<key>/index.html and nothing else:

  1. SW   navigator.serviceWorker.register('sw.js')
          → navigator.serviceWorker.register('../../sw.js', { scope: './' })
          (the one shared root worker, scoped to this client's folder)
  2. LEGACY  removes the two in-page `try { if (Notification…granted) new Notification(…)
          … setTimeout(requestPermission, 3000) } catch` blocks. Permission is only
          ever requested from the explicit "Turn on" tap now. The in-app check-in
          banner itself is untouched.
  3. MOUNT  <div id="li-push-settings"> at the end of the Tracker (weekly check-in)
          section — a compact, collapsed "Notifications · On/Off" row.
  4. SCRIPT  ../../push-client.js + a 10-line mount call before </body>.

Plus: writes clients/<key>/manifest.json (display: standalone, scope ./) if the
folder has none — data, not code; the shell already links to it.

Safety:
  * Refuses unless every anchor is found exactly as expected (count-checked).
  * Idempotent: a shell carrying the LOCKED-IN-PUSH:v1 marker is left alone.
  * Proves itself: reversing the four edits must reproduce the ORIGINAL bytes
    exactly, so no prescription, meal, training or config byte can have moved.
  * --check reports without writing. Rollback is `git revert` of the commit.

Never run this on a live client shell without Omar's approval of the pilot list.
"""
import argparse
import hashlib
import json
import os
import re
import sys

MARKER = 'LOCKED-IN-PUSH:v1'
SW_OLD = "navigator.serviceWorker.register('sw.js')"
SW_NEW = "navigator.serviceWorker.register('../../sw.js', { scope: './' })"
LEGACY_HEAD = re.compile(r"try \{\s*if \('Notification' in window && Notification\.permission === 'granted'\) \{")
LEGACY_REPLACEMENT = "/* {m}: reminders arrive as opt-in push notifications; no automatic permission prompt. */".format(m=MARKER)
TRACKER_OPEN = '<section class="section" id="section-tracker">'
MOUNT_HTML = ('\n  <!-- {m} -->\n  <div id="li-push-settings" style="margin-top:1.5rem;"></div>\n').format(m=MARKER)
SCRIPT_HTML = """<!-- {m} -->
<script src="../../push-client.js"></script>
<script>
(function () {{
  try {{
    var box = document.getElementById('li-push-settings');
    var url = String((window.CLIENT_CONFIG || CLIENT_CONFIG).sheetsWebhookUrl || '');
    if (!box || !window.LockedInPush || !/^https:\\/\\/[a-z0-9]+\\.supabase\\.co\\/functions\\/v1\\/api$/.test(url)) return;
    var key = CLIENT_CONFIG.client.storageKey;
    window.LockedInPush.mount({{
      container: box, storageKey: key, compact: true, swUrl: '../../sw.js', pushUrl: url.replace(/\\/api$/, '/push'),
      getToken: function () {{ try {{ return (typeof CLIENT_TOKEN === 'string' && CLIENT_TOKEN) || localStorage.getItem(key + '_access_token') || ''; }} catch (e) {{ return ''; }} }},
    }});
  }} catch (e) {{}}
}})();
</script>
""".format(m=MARKER)

KEY_RE = re.compile(r'^[a-z0-9_]{2,40}$')


class PatchError(Exception):
    pass


def _skip_string(s, i):
    """s[i] is a quote; return index just past the closing quote."""
    q = s[i]
    i += 1
    while i < len(s):
        c = s[i]
        if c == '\\':
            i += 2
            continue
        if c == q:
            return i + 1
        i += 1
    raise PatchError('unterminated string')


def _match_brace(s, open_idx):
    """Index just past the brace matching s[open_idx] == '{' (quote-aware)."""
    depth = 0
    i = open_idx
    while i < len(s):
        c = s[i]
        if c in '\'"`':
            i = _skip_string(s, i)
            continue
        if c == '/' and s.startswith('/*', i):
            j = s.find('*/', i + 2)
            if j < 0:
                raise PatchError('unterminated comment')
            i = j + 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise PatchError('unbalanced braces')


def legacy_blocks(s):
    """[(start, end)] of each `try { if (Notification…granted) … } catch (e) { … }` block."""
    out = []
    for m in LEGACY_HEAD.finditer(s):
        try_open = s.index('{', m.start())
        after_try = _match_brace(s, try_open)
        cm = re.compile(r'\s*catch \(e\) \{').match(s, after_try)
        if not cm:
            raise PatchError('legacy block without catch')
        end = _match_brace(s, cm.end() - 1)
        block = s[m.start():end]
        if 'requestPermission' not in block or 'new Notification(' not in block or len(block) > 1500:
            raise PatchError('legacy block did not look as expected')
        out.append((m.start(), end))
    return out


def patch(src):
    """Return (patched_text, edits) or raise PatchError. edits allow exact reversal."""
    if MARKER in src:
        return src, None
    if src.count(SW_OLD) != 1:
        raise PatchError("expected exactly one register('sw.js'), found %d" % src.count(SW_OLD))
    blocks = legacy_blocks(src)
    if len(blocks) != 2:
        raise PatchError('expected 2 legacy notification blocks, found %d' % len(blocks))
    if src.count(TRACKER_OPEN) != 1:
        raise PatchError('tracker section not found exactly once')
    t0 = src.index(TRACKER_OPEN)
    t_close = src.index('</section>', t0)
    if '<section' in src[t0 + len(TRACKER_OPEN):t_close]:
        raise PatchError('tracker section contains a nested section')
    if src.count('</body>') != 1:
        raise PatchError('</body> not found exactly once')
    body_close = src.rindex('</body>')

    # Apply from the end backwards so earlier offsets stay valid.
    edits = [
        ('insert', body_close, SCRIPT_HTML),
        ('insert', t_close, MOUNT_HTML),
    ]
    sw_at = src.index(SW_OLD)
    edits.append(('replace', sw_at, SW_OLD, SW_NEW))
    for (a, b) in blocks:
        edits.append(('replace', a, src[a:b], LEGACY_REPLACEMENT))
    edits.sort(key=lambda e: e[1], reverse=True)

    out = src
    for e in edits:
        if e[0] == 'insert':
            out = out[:e[1]] + e[2] + out[e[1]:]
        else:
            _, at, old, new = e
            assert out[at:at + len(old)] == old
            out = out[:at] + new + out[at + len(old):]
    return out, edits


def unpatch(patched, edits):
    """Exact inverse of patch() — used to prove nothing else moved."""
    # Position of each edit in the PATCHED text = original offset + growth of
    # every edit before it. Undo from the end so earlier positions stay valid.
    placed, growth = [], 0
    for e in sorted(edits, key=lambda e: e[1]):
        placed.append((e[1] + growth, e))
        growth += len(e[2]) if e[0] == 'insert' else len(e[3]) - len(e[2])
    out = patched
    for at, e in reversed(placed):
        if e[0] == 'insert':
            if out[at:at + len(e[2])] != e[2]:
                raise PatchError('reversal mismatch (insert)')
            out = out[:at] + out[at + len(e[2]):]
        else:
            _, _, old, new = e
            if out[at:at + len(new)] != new:
                raise PatchError('reversal mismatch (replace)')
            out = out[:at] + old + out[at + len(new):]
    return out


def manifest_for(folder, src):
    m = re.search(r'<meta name="apple-mobile-web-app-title" content="([^"]{1,40})"', src)
    name = m.group(1) if m else 'LOCKED IN'
    icon = (lambda f: f if os.path.exists(os.path.join(folder, f)) else '../../' + f)
    return {
        'id': './', 'name': name, 'short_name': name, 'start_url': './', 'scope': './',
        'display': 'standalone', 'orientation': 'portrait',
        'background_color': '#ffffff', 'theme_color': '#ffffff',
        'icons': [{'src': icon('icon-192.png'), 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
                  {'src': icon('icon-512.png'), 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'}],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('key')
    ap.add_argument('--repo', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    ap.add_argument('--check', action='store_true', help='report only, write nothing')
    ap.add_argument('--out', help='write the patched shell here instead of in place (testing)')
    a = ap.parse_args(argv)
    if not KEY_RE.match(a.key) or a.key.startswith('_'):
        raise SystemExit('refusing: %r is not a real client storage key' % a.key)
    folder = os.path.join(os.path.abspath(a.repo), 'clients', a.key)
    path = os.path.join(folder, 'index.html')
    with open(path, 'rb') as f:
        raw = f.read()
    src = raw.decode('utf-8')
    if 'rel="manifest" href="manifest.json"' not in src:
        raise SystemExit('refusing: shell does not link manifest.json')
    try:
        out, edits = patch(src)
    except PatchError as e:
        raise SystemExit('refusing: %s — shell left untouched' % e)
    report = {'key': a.key, 'sha256_before': hashlib.sha256(raw).hexdigest()}
    if edits is None:
        report['status'] = 'already_patched'
        print(json.dumps(report))
        return 0
    try:
        reversed_ok = unpatch(out, edits) == src
    except PatchError:
        reversed_ok = False
    if not reversed_ok:
        raise SystemExit('refusing: reversal did not reproduce the original bytes — shell left untouched')
    if 'requestPermission' in out or 'new Notification(' in out:
        raise SystemExit('refusing: legacy notification code still present')
    new_bytes = out.encode('utf-8')
    report.update({
        'status': 'would_patch' if a.check else 'patched',
        'sha256_after': hashlib.sha256(new_bytes).hexdigest(),
        'edits': {'sw_registration': 1, 'legacy_blocks_removed': 2, 'mount_points': 1, 'script_blocks': 1},
        'bytes_delta': len(new_bytes) - len(raw),
        'reversal_proof': 'reversing the 5 edits reproduces the original bytes exactly',
    })
    man_path = os.path.join(folder, 'manifest.json')
    if not a.check:
        with open(a.out or path, 'wb') as f:
            f.write(new_bytes)
        if not a.out and not os.path.exists(man_path):
            with open(man_path, 'w') as f:
                json.dump(manifest_for(folder, src), f, indent=2)
                f.write('\n')
            report['manifest'] = 'created'
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
