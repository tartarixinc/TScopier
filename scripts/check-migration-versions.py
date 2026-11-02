#!/usr/bin/env python3
"""Fail if two migration files share a version prefix.

A migration's version is the leading number of its filename
(`name.split("_")[0]`), and `supabase_migrations.schema_migrations` holds one
row per version. If two files share a version, a database that recorded the
version for one of them treats the other as already applied and silently skips
it. This guard keeps the migrations directory free of such collisions.

Run it before committing a migration or merging a branch:

    python3 scripts/check-migration-versions.py

Exits 1 and lists the colliding files when any version is shared.
"""

import collections
import glob
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS_DIR = os.path.join(REPO_ROOT, "supabase", "migrations")
MIGRATIONS_GLOB = os.path.join(MIGRATIONS_DIR, "*.sql")


def main() -> int:
    by_version = collections.defaultdict(list)
    for path in sorted(glob.glob(MIGRATIONS_GLOB)):
        name = os.path.basename(path)
        version = name.split("_")[0]
        if version.isdigit():
            by_version[version].append(name)

    duplicates = {v: names for v, names in by_version.items() if len(names) > 1}
    total = sum(len(names) for names in by_version.values())
    if total == 0:
        print(f"FAIL — no migration files found under {MIGRATIONS_DIR}")
        print("Check the repository layout; a guard that finds nothing cannot")
        print("detect collisions.")
        return 1
    print(f"Checked {total} migration file(s); {len(by_version)} distinct version(s).")

    if not duplicates:
        print("OK — every migration version is unique.")
        return 0

    print(f"\nFAIL — {len(duplicates)} version prefix(es) are shared:")
    for version, names in sorted(duplicates.items()):
        print(f"  {version}:")
        for name in names:
            print(f"    {name}")
    print("\nGive each colliding migration a unique version prefix (rename the")
    print("newer, not-yet-applied file) before it can be tracked correctly.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
