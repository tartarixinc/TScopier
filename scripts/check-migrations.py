#!/usr/bin/env python3
"""Read-only check: which migration files has this database NOT applied?

Compares the migration files on a git ref (default: the working tree) against
the versions recorded in `supabase_migrations.schema_migrations`, and exits 1
if anything is missing. Run it before merging a branch into staging, and again
before a Railway deploy.

It NEVER executes DDL. The only query it sends is:

    SELECT version FROM supabase_migrations.schema_migrations

Examples:
    python3 scripts/check-migrations.py                      # working tree vs staging
    python3 scripts/check-migrations.py --ref origin/staging # what that branch needs
    python3 scripts/check-migrations.py --project sxkpcovbyaficvtkpsdo
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

PROJECTS = {
    "staging": "axdcledcyhyvzrnfkwat",
    "production": "sxkpcovbyaficvtkpsdo",
    "migration": "supmsgcubipmmowrzoub",
}
TOKEN_PATH = os.path.expanduser("~/.supabase/access-token")
MIGRATIONS_GLOB = "supabase/migrations/*.sql"


def applied_versions(project_ref: str) -> set:
    """Read the migration history recorded in the database (SELECT only)."""
    with open(TOKEN_PATH) as fh:
        token = fh.read().strip()
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    body = json.dumps({
        "query": "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version",
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            rows = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:500]
        sys.exit(f"Failed to read applied migrations: HTTP {exc.code}\n{detail}")
    return {str(row["version"]) for row in rows}


def file_versions(ref: str | None) -> list:
    """Migration files on a git ref, or in the working tree when ref is None."""
    if ref:
        out = subprocess.run(
            ["git", "ls-tree", "--name-only", ref, "supabase/migrations/"],
            capture_output=True, text=True, check=True,
        ).stdout
        paths = [line for line in out.splitlines() if line.endswith(".sql")]
    else:
        paths = glob.glob(MIGRATIONS_GLOB)
    entries = []
    for path in sorted(paths):
        name = os.path.basename(path)
        version = name.split("_")[0]
        if version.isdigit():
            entries.append((version, name))
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="staging",
                        help="staging | production | migration | a raw project ref")
    parser.add_argument("--ref", default=None,
                        help="git ref whose migration files to compare (default: working tree)")
    args = parser.parse_args()

    project_ref = PROJECTS.get(args.project, args.project)
    source = f"git ref {args.ref}" if args.ref else "working tree"
    print(f"Project: {args.project} ({project_ref})")
    print(f"Comparing migration files from the {source} against the database...\n")

    applied = applied_versions(project_ref)
    files = file_versions(args.ref)
    file_set = {version for version, _ in files}
    print(f"  migration files:  {len(files)}")
    print(f"  applied in db:    {len(applied)}")

    missing = [(v, n) for v, n in files if v not in applied]
    extra = sorted(applied - file_set)

    if extra:
        print(f"\n  {len(extra)} applied version(s) have no file in this ref"
              " (applied from another branch — normal during a merge):")
        for version in extra[-10:]:
            print(f"    {version}")
        if len(extra) > 10:
            print(f"    ... and {len(extra) - 10} more")

    if not missing:
        print("\nOK — every migration file on this ref has been applied to the database.")
        return 0

    print(f"\nMISSING — {len(missing)} migration file(s) this database has NOT applied:\n")
    for version, name in missing:
        print(f"  {name}")
    print("\nApply them (dashboard SQL editor, or scripts/apply-missing-migrations.py)")
    print("BEFORE deploying code that depends on them.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
