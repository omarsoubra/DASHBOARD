#!/usr/bin/env python3
"""
LOCKED IN Push Notifications V1 — 1:1 fleet integration manifest (READ-ONLY on DASHBOARD).

    python3 scripts/push/fleet_manifest.py --work DIR --out MANIFEST.json [--tools CLIENT_TEMPLATE_DIR]

For every clients/<key>/index.html it decides eligibility and, for eligible shells,
patches an in-memory copy (written only under --work) and proves:

  * reversal: undoing the four integration edits reproduces the original bytes;
  * regions: only the approved regions changed (sw registration, 2 legacy
    notification blocks, one Tracker mount block) — listed with offsets + hashes;
  * programme equivalence: the coaching payload extracted by the V1.4 tool
    shell_payload.js (CLIENT_CONFIG, phases, phaseTargets, DAY_TYPES, mealPlan)
    is identical before and after;
  * auth wiring: every auth/identity line outside the new mount block is identical;
  * lint parity: lint_shell.py findings are identical before and after;
  * syntax: every inline <script> of the patched shell compiles;
  * no automatic permission prompt / in-page Notification remains.

A shell that fails ANY check is excluded with its reason; it never blocks the rest.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import patch_pilot_shell as P  # noqa: E402

KEY_RE = re.compile(r'^[a-z0-9][a-z0-9_]{1,39}$')
API_RE = re.compile(r"sheetsWebhookUrl:\s*'https://[a-z0-9]{20}\.supabase\.co/functions/v1/api'")
AUTH_RE = re.compile(r"authClient|issueClientToken|coachToken|clientToken|sheetsWebhookUrl|AUTH|storageKey|sessionToken|CLIENT_TOKEN|_access_token")
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


def payload_fingerprint(tools, path):
    rc, out, err = run(['node', os.path.join(tools, 'agent_workspace/bin/shell_payload.js'), path])
    if rc != 0:
        return None, (err or out).strip()[:200]
    obj = json.loads(out)
    canon = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    parts = {k: sha(json.dumps(obj.get(k), sort_keys=True, ensure_ascii=False, separators=(',', ':'))) for k in sorted(obj)}
    return {'sha256': sha(canon), 'parts': parts}, None


def lint(tools, key, path):
    rc, out, err = run([sys.executable, os.path.join(tools, 'agent_workspace/bin/lint_shell.py'), key, '--html', path])
    text = (out + err).replace(path, '<shell>')
    return rc, sha(text), text[-400:]


def auth_lines(text, drop_block=None):
    if drop_block:
        text = text.replace(drop_block, '')
    return sha('\n'.join(l for l in text.split('\n') if AUTH_RE.search(l)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--tools', default=os.path.expanduser('~/Desktop/client_template'))
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    shells, excluded = [], []
    for key in sorted(os.listdir(os.path.join(REPO, 'clients'))):
        path = os.path.join(REPO, 'clients', key, 'index.html')
        if not os.path.isfile(path):
            continue
        rel = f'clients/{key}/index.html'
        if key.startswith('_'):
            excluded.append({'key': key, 'reason': 'internal canary / test folder (not a client)'})
            continue
        raw = open(path, 'rb').read()
        src = raw.decode('utf-8')
        why = None
        if not KEY_RE.match(key):
            why = 'folder name is not a storage key'
        elif 'x-registry-skip' in src:
            why = 'declared redirect shim (x-registry-skip), not a client shell'
        elif not API_RE.search(src):
            why = 'not wired to the Supabase api (legacy Apps Script / other backend) — no client auth to attach push to'
        elif not re.search(r"const CLIENT_CONFIG = \{\s*client: \{[^}]*?\bstorageKey:\s*'%s'" % re.escape(key), src):
            why = 'CLIENT_CONFIG storageKey does not match the folder'
        elif 'const CLIENT_TOKEN' not in src:
            why = 'no CLIENT_TOKEN wiring'
        if why:
            excluded.append({'key': key, 'path': rel, 'original_sha256': sha(raw), 'reason': why})
            continue
        try:
            out, edits = P.patch_and_prove(src)
        except P.PatchError as e:
            excluded.append({'key': key, 'path': rel, 'original_sha256': sha(raw), 'reason': 'patch refused: %s' % e})
            continue
        if edits is None:
            excluded.append({'key': key, 'path': rel, 'original_sha256': sha(raw), 'reason': 'already integrated'})
            continue
        work = os.path.join(a.work, key)
        os.makedirs(work, exist_ok=True)
        orig_p, pat_p = os.path.join(work, 'original.html'), os.path.join(work, 'patched.html')
        open(orig_p, 'wb').write(raw)
        open(pat_p, 'wb').write(out.encode('utf-8'))

        fp0, e0 = payload_fingerprint(a.tools, orig_p)
        fp1, e1 = payload_fingerprint(a.tools, pat_p)
        l0 = lint(a.tools, key, orig_p)
        l1 = lint(a.tools, key, pat_p)
        rc, cj, _ = run(['node', '-e', COMPILE_JS, pat_p])
        comp = json.loads(cj) if rc == 0 else {'scripts': 0, 'errors': ['compile runner failed']}
        rec = {
            'key': key, 'path': rel,
            'original_sha256': sha(raw), 'patched_sha256': sha(out),
            'bytes_delta': len(out.encode()) - len(raw),
            'regions': P.describe(src, edits),
            'reversal_proof': P.unpatch(out, edits) == src,
            'programme_fingerprint_before': fp0 and fp0['sha256'], 'programme_fingerprint_after': fp1 and fp1['sha256'],
            'programme_parts_equal': bool(fp0 and fp1 and fp0['parts'] == fp1['parts']),
            'programme_parts': fp0 and sorted(fp0['parts']),
            'auth_lines_equal': auth_lines(src) == auth_lines(out, drop_block=P.MOUNT_HTML),
            'lint_equal': l0[0] == l1[0] and l0[1] == l1[1], 'lint_exit': l0[0],
            'inline_scripts': comp['scripts'], 'inline_script_errors': comp['errors'],
            'auto_prompt_after': ('requestPermission' in out) or ('new Notification(' in out),
            'manifest_json': 'exists' if os.path.exists(os.path.join(REPO, 'clients', key, 'manifest.json')) else 'will_create',
        }
        problems = []
        if not rec['reversal_proof']: problems.append('reversal')
        if e0 or e1 or rec['programme_fingerprint_before'] != rec['programme_fingerprint_after'] or not rec['programme_parts_equal']:
            problems.append('programme payload changed or unreadable: %s %s' % (e0 or '', e1 or ''))
        if not rec['auth_lines_equal']: problems.append('auth wiring changed')
        if not rec['lint_equal']: problems.append('lint findings changed')
        if rec['inline_script_errors']: problems.append('inline script syntax errors')
        if rec['auto_prompt_after']: problems.append('automatic prompt remains')
        if problems:
            excluded.append({'key': key, 'path': rel, 'original_sha256': sha(raw), 'reason': 'gate failed: ' + '; '.join(problems)})
        else:
            shells.append(rec)
        print(f"{key:24s} {'OK' if not problems else 'EXCLUDED: ' + '; '.join(problems)}", flush=True)

    manifest = {
        'subsystem': 'LOCKED IN Push Notifications V1 — 1:1 fleet integration',
        'integration_marker': P.MARKER,
        'mount_block_sha256': sha(P.MOUNT_HTML), 'legacy_replacement_sha256': sha(P.LEGACY_REPLACEMENT),
        'sw_registration': {'from': P.SW_OLD, 'to': P.SW_NEW},
        'eligible': len(shells), 'excluded': excluded, 'shells': shells,
    }
    with open(a.out, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print(f"\neligible+proven: {len(shells)}   excluded: {len(excluded)}   → {a.out}")


if __name__ == '__main__':
    main()
