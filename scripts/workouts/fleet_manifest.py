#!/usr/bin/env python3
"""
LOCKED IN Workout Completion V1 — fleet integration manifest.

    python3 scripts/workouts/fleet_manifest.py --work DIR --out MANIFEST.json [--apply] [--tools CLIENT_TEMPLATE_DIR]

For every clients/<key>/index.html (not `_` internal folders) that carries the
Training V2 block, patch an in-memory copy (written under --work) and prove:
  * reversal: removing the four insertions reproduces the original bytes;
  * programme equivalence: shell_payload.js fingerprint identical before/after;
  * auth wiring: every auth/identity line identical;
  * lint parity: lint_shell.py findings identical;
  * syntax: every inline <script> of the patched shell compiles.
A shell that fails ANY check, or that the patcher refuses, is excluded with its
reason. With --apply, ONLY the proven shells are written in place.
"""
import argparse, hashlib, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import patch_completion_shell as P  # noqa: E402

AUTH_RE = re.compile(r"authClient|issueClientToken|coachToken|clientToken|sheetsWebhookUrl|storageKey|sessionToken|CLIENT_TOKEN|_access_token")
COMPILE_JS = r"""
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[1], 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0, bad = [];
while ((m = re.exec(html))) { n++; try { new vm.Script(m[1]); } catch (e) { bad.push(String(e.message).slice(0, 120)); } }
console.log(JSON.stringify({ scripts: n, errors: bad }));
"""


def sha(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode('utf-8')).hexdigest()


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def fingerprint(tools, path):
    rc, out, err = run(['node', os.path.join(tools, 'agent_workspace/bin/shell_payload.js'), path])
    if rc != 0:
        return None
    return sha(json.dumps(json.loads(out), sort_keys=True, ensure_ascii=False, separators=(',', ':')))


def lint(tools, key, path):
    rc, out, err = run([sys.executable, os.path.join(tools, 'agent_workspace/bin/lint_shell.py'), key, '--html', path])
    return rc, sha((out + err).replace(path, '<shell>'))


def auth_lines(text):
    return sha('\n'.join(l for l in text.split('\n') if AUTH_RE.search(l)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--tools', default=os.path.expanduser('~/Desktop/client_template'))
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    shells, excluded = [], []
    for key in sorted(os.listdir(os.path.join(REPO, 'clients'))):
        path = os.path.join(REPO, 'clients', key, 'index.html')
        if not os.path.isfile(path) or key.startswith('_'):
            continue
        raw = open(path, 'rb').read(); src = raw.decode('utf-8')
        if '<script id="tv2-js">' not in src:
            continue
        rel = f'clients/{key}/index.html'
        try:
            out, edits = P.patch_and_prove(src)
        except P.PatchError as e:
            excluded.append({'key': key, 'reason': 'patch refused: %s' % e}); continue
        if edits is None:
            excluded.append({'key': key, 'reason': 'already integrated'}); continue
        w = os.path.join(a.work, key); os.makedirs(w, exist_ok=True)
        op, pp = os.path.join(w, 'original.html'), os.path.join(w, 'patched.html')
        open(op, 'wb').write(raw); open(pp, 'wb').write(out.encode('utf-8'))
        f0, f1 = fingerprint(a.tools, op), fingerprint(a.tools, pp)
        l0, l1 = lint(a.tools, key, op), lint(a.tools, key, pp)
        rc, cj, _ = run(['node', '-e', COMPILE_JS, pp])
        comp = json.loads(cj) if rc == 0 else {'scripts': 0, 'errors': ['compile runner failed']}
        rec = {'key': key, 'path': rel, 'original_sha256': sha(raw), 'patched_sha256': sha(out),
               'bytes_delta': len(out.encode()) - len(raw), 'edits': P.describe(src, edits),
               'reversal_proof': P.unpatch(out, edits) == src,
               'programme_fingerprint': f0, 'programme_equal': bool(f0 and f0 == f1),
               'auth_lines_equal': auth_lines(src) == auth_lines(out),
               'lint_equal': l0 == l1, 'lint_exit': l0[0],
               'inline_scripts': comp['scripts'], 'inline_script_errors': comp['errors']}
        problems = [n for n, ok in [('reversal', rec['reversal_proof']), ('programme payload changed/unreadable', rec['programme_equal']),
                                   ('auth wiring changed', rec['auth_lines_equal']), ('lint findings changed', rec['lint_equal']),
                                   ('inline script errors', not rec['inline_script_errors'])] if not ok]
        if problems:
            excluded.append({'key': key, 'reason': 'gate failed: ' + '; '.join(problems)})
        else:
            shells.append(rec)
            if a.apply:
                open(path, 'wb').write(out.encode('utf-8'))
        print(f"{key:24s} {'OK' if not problems else 'EXCLUDED: ' + '; '.join(problems)}", flush=True)
    manifest = {'subsystem': 'LOCKED IN Workout Completion V1 — fleet integration', 'marker': P.MARKER,
                'block_sha256': sha(P.BLOCK), 'integrated': len(shells), 'applied': a.apply,
                'excluded': excluded, 'shells': shells}
    with open(a.out, 'w') as f:
        json.dump(manifest, f, indent=2); f.write('\n')
    print(f"\nproven: {len(shells)}   excluded: {len(excluded)}   applied: {a.apply}   → {a.out}")


if __name__ == '__main__':
    main()
