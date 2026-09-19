#!/usr/bin/env python3
"""
check_client_db_rows.py — fail loudly if any live client shell has no
matching row in the Supabase `clients` table.

Why this exists: a client's static shell (clients/<key>/index.html) and its
database row (public.clients, storage_key = <key>) are created by two
independent processes. The shell can go live via git push with no dependency
on the database at all. But issueClientToken, workout logging, check-ins —
everything the client actually does after the coach sends them a link —
requires that database row. When it's missing, the failure doesn't surface
until the coach tries to generate an access link, with a bare "unknown_client"
error and no indication of what actually happened or when.

This script closes that gap at push time instead of link-generation time.
It reuses the exact same folder-discovery rule as rebuild_registry.py (any
clients/<key>/index.html not starting with "_" or "." and without the
registry-skip marker) so "counts as a client" means the same thing in both
places, then checks each one against the database in a single batched query.

Runs automatically via .github/workflows/rebuild-registry.yml, as the LAST
step, after the registry commit — so a missing DB row never blocks the
registry itself from staying current for every other client. It only makes
this specific workflow run show failed, which is the intended loud signal.

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
Read-only: does a single SELECT, writes nothing, prints no key material.

Exit codes:
    0  every live client shell has a matching clients row
    1  one or more shells have no matching row (listed by storageKey)
    2  configuration/environment problem (missing env vars, network failure)
"""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DASHBOARD = HERE.parent
CLIENTS_DIR = DASHBOARD / "clients"

REGISTRY_SKIP_MARKER = '<meta name="x-registry-skip" content="redirect-shim">'


def discover_client_keys() -> list[str]:
    if not CLIENTS_DIR.is_dir():
        print(f"[check-client-db] clients/ not found at {CLIENTS_DIR}", file=sys.stderr)
        return []
    keys = []
    for folder in sorted(CLIENTS_DIR.iterdir()):
        if not folder.is_dir() or folder.name.startswith(("_", ".")):
            continue
        index_html = folder / "index.html"
        if not index_html.is_file():
            continue
        try:
            if REGISTRY_SKIP_MARKER in index_html.read_text(encoding="utf-8", errors="ignore"):
                continue
        except OSError:
            pass
        keys.append(folder.name)
    return keys


def fetch_existing_keys(url: str, service_key: str, keys: list[str]) -> set[str]:
    # PostgREST `in.(...)` filter, one request for every candidate key.
    in_list = ",".join(keys)
    endpoint = f"{url}/rest/v1/clients?select=storage_key&storage_key=in.({in_list})"
    req = urllib.request.Request(
        endpoint,
        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    return {r["storage_key"] for r in rows}


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not service_key:
        print("[check-client-db] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
        return 2

    keys = discover_client_keys()
    if not keys:
        print("[check-client-db] no client shells found — nothing to check")
        return 0

    try:
        existing = fetch_existing_keys(url, service_key, keys)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"[check-client-db] could not query the database: {exc}", file=sys.stderr)
        return 2

    missing = [k for k in keys if k not in existing]
    if missing:
        print(f"[check-client-db] FAIL: {len(missing)}/{len(keys)} client shell(s) have no "
              f"matching row in public.clients:", file=sys.stderr)
        for k in missing:
            print(f"           - {k}", file=sys.stderr)
        print("[check-client-db] Fix: call clientCreate for each (coach dashboard \"Add "
              "Client\", or the API directly) before sending an access link. The shell being "
              "live does not create the database row.", file=sys.stderr)
        return 1

    print(f"[check-client-db] OK: {len(keys)}/{len(keys)} client shells have a matching "
          f"public.clients row")
    return 0


if __name__ == "__main__":
    sys.exit(main())
