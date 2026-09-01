#!/usr/bin/env python3
"""
rebuild_registry.py — regenerate clients_registry.json from the clients/ folder.

Self-contained. Does NOT depend on client_template. Scans DASHBOARD/clients/
directly, so any folder with an index.html becomes a registered client.

Runs automatically via .github/workflows/rebuild-registry.yml on every push
that touches clients/**. Also safe to run locally:
    python3 scripts/rebuild_registry.py

Exit codes:
    0  registry written (or unchanged)
    1  clients/ folder missing OR forbidden fields detected (refuses to write)
"""
from __future__ import annotations
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
DASHBOARD = HERE.parent
CLIENTS_DIR = DASHBOARD / "clients"
OUT_PATH = DASHBOARD / "clients_registry.json"


# ─── HARD ARCHITECTURAL INVARIANT ─────────────────────────────────────────────
# The registry is a PUBLIC surface, published to GitHub Pages.
# It MUST NEVER contain any field that the coach edits on the dashboard.
# If a future change to this script starts emitting anything in FORBIDDEN_FIELDS,
# the script FAILS loudly and refuses to write the registry.
FORBIDDEN_FIELDS = frozenset({
    "accessStatus", "accessRevokedAt", "accessRevokedReason", "accessRestoredAt",
    "programStatus", "isPaused", "pausedAt", "resumeDate",
    "archivedAt", "archiveReason",
    "coachReviewHistory", "lastMeaningfulCoachReview", "checkInReviews",
    "nextCoachAction", "nextCoachActionDue", "coachNotes",
    "startWeight", "goalWeight",
    "phone", "email",
    "startDate", "checkInDay",
    "kcal", "p", "c", "f", "steps", "goal", "phase",
})

ALLOWED_ENTRY_FIELDS = frozenset({"storageKey", "programUrl"})


def collect_clients() -> list[dict]:
    if not CLIENTS_DIR.is_dir():
        return []
    entries = []
    for folder in sorted(CLIENTS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        if folder.name.startswith(("_", ".")):
            continue
        if not (folder / "index.html").is_file():
            continue
        entries.append({
            "storageKey": folder.name,
            "programUrl": f"clients/{folder.name}/",
        })
    return entries


def main() -> int:
    if not CLIENTS_DIR.is_dir():
        print(f"[registry] clients/ not found at {CLIENTS_DIR}", file=sys.stderr)
        return 1

    entries = collect_clients()

    for e in entries:
        forbidden = set(e.keys()) & FORBIDDEN_FIELDS
        if forbidden:
            print(f"[registry] FATAL: entry '{e.get('storageKey', '?')}' contains "
                  f"coach-owned fields: {sorted(forbidden)}", file=sys.stderr)
            return 1
        unexpected = set(e.keys()) - ALLOWED_ENTRY_FIELDS
        if unexpected:
            print(f"[registry] FATAL: entry '{e.get('storageKey', '?')}' contains "
                  f"unexpected fields: {sorted(unexpected)}", file=sys.stderr)
            return 1

    registry = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generatedBy": "scripts/rebuild_registry.py",
        "clientCount": len(entries),
        "clients": entries,
        "note": "Public slim registry. Auto-generated from clients/*/index.html on every push. "
                "Full metadata lives behind the coach-authed registryGetPrivate endpoint.",
    }

    new_text = json.dumps(registry, indent=2) + "\n"

    if OUT_PATH.is_file():
        try:
            old = json.loads(OUT_PATH.read_text(encoding="utf-8"))
            old_keys = sorted(c.get("storageKey") for c in (old.get("clients") or []))
            new_keys = sorted(c.get("storageKey") for c in entries)
            if old_keys == new_keys and old.get("clientCount") == len(entries):
                print(f"[registry] no changes ({len(entries)} clients)")
                return 0
        except Exception:
            pass

    OUT_PATH.write_text(new_text, encoding="utf-8")
    print(f"[registry] wrote {OUT_PATH.name}: {len(entries)} clients")
    for e in entries:
        print(f"           - {e['storageKey']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
