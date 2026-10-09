#!/usr/bin/env python3
"""Read Railway service logs through the GraphQL API.

Design rules
------------
1. The token is read from the repo .env (RAILWAY_TOKEN_PROD). It is never printed
   and never hard-coded.
2. The script ALWAYS asks Railway which projects the token may see first, then
   verifies the requested project exists before using the key for anything else.
   If the project cannot be found, it stops instead of guessing.
3. Log windows must be expressed as `anchorDate` (window start) + `beforeDate`
   (window end). Railway ignores either one alone, rejects windows that scan too
   much data, and returns lines in ascending order.

Usage
-----
  scripts/railway-logs.py project
      List the projects and environments the token can see.

  scripts/railway-logs.py services --project TScopier.ai
      List services and environments of one project.

  scripts/railway-logs.py read --project TScopier.ai --env production \
      --from 2026-09-29T20:55:00Z --to 2026-09-29T20:58:20Z
      Print raw log lines for that window (auto-chunks if Railway refuses).

  scripts/railway-logs.py read ... --grep TIMEOUT --summary 10
      Local filtering and/or a normalised frequency summary.

  scripts/railway-logs.py read ... --since 30m
      Relative window instead of absolute --from/--to.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(REPO_ROOT, ".env")
GRAPHQL_URL = "https://backboard.railway.com/graphql/v2"
DEFAULT_PROJECT = "TScopier.ai"
TOKEN_VAR = "RAILWAY_TOKEN_PROD"


# --------------------------------------------------------------------------
# token
# --------------------------------------------------------------------------
def load_token() -> str:
    token = os.environ.get(TOKEN_VAR, "").strip()
    if token:
        return token
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(f"{TOKEN_VAR}="):
                    return line.split("=", 1)[1].strip()
    sys.exit(f"error: {TOKEN_VAR} not found in the environment or in {ENV_FILE}")


def gql(token: str, query: str, variables: dict | None = None) -> dict:
    payload: dict = {"query": query}
    if variables:
        payload["variables"] = variables
    proc = subprocess.run(
        [
            "curl", "-sS", "-X", "POST", GRAPHQL_URL,
            "-H", f"Authorization: Bearer {token}",
            "-H", "Content-Type: application/json",
            "--data-binary", "@-",
        ],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"error: transport failure: {proc.stderr.strip()}")
    try:
        body = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.exit(f"error: non-JSON response: {proc.stdout[:200]}")
    if body.get("errors"):
        message = body["errors"][0].get("message", "unknown GraphQL error")
        sys.exit(f"error: {message}")
    return body["data"]


# --------------------------------------------------------------------------
# project check (always first)
# --------------------------------------------------------------------------
def resolve_project(token: str, wanted: str) -> dict:
    """Ask Railway which projects this token may touch, then pick `wanted`.

    Stops with a clear message if the token cannot see the project, instead of
    silently querying somebody else's project.
    """
    data = gql(token, "query { projects { edges { node { id name } } } }")
    projects = [e["node"] for e in data["projects"]["edges"]]
    if not projects:
        sys.exit("error: this token can see no projects at all")
    for project in projects:
        if project["name"] == wanted or project["id"] == wanted:
            return project
    names = ", ".join(p["name"] for p in projects)
    sys.exit(
        f"error: project {wanted!r} is not visible to this token "
        f"(visible: {names}). Refusing to query any other project."
    )


def project_details(token: str, project_id: str) -> dict:
    query = """
    query($id: String!) {
      project(id: $id) {
        name
        services { edges { node { id name } } }
        environments { edges { node { id name } } }
      }
    }
    """
    return gql(token, query, {"id": project_id})["project"]


# --------------------------------------------------------------------------
# time helpers
# --------------------------------------------------------------------------
def to_utc(value: str) -> dt.datetime:
    value = value.strip().replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{value.microsecond // 1000:03d}000Z"
    )


def parse_since(value: str) -> dt.timedelta:
    match = re.fullmatch(r"(\d+)([smhd])", value.strip())
    if not match:
        sys.exit(f"error: --since expects e.g. 30m, 2h, 1d (got {value!r})")
    amount, unit = int(match.group(1)), match.group(2)
    seconds = amount * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    return dt.timedelta(seconds=seconds)


# --------------------------------------------------------------------------
# log fetching
# --------------------------------------------------------------------------
def fetch_chunk(token: str, env_id: str, start: dt.datetime, end: dt.datetime,
                limit: int) -> tuple[list[dict], str | None]:
    """Fetch one [start, end) window. Returns (lines, error_message)."""
    query = """
    query($e: String!, $anchor: String!, $before: String!, $limit: Int!) {
      environmentLogs(environmentId: $e, anchorDate: $anchor, beforeDate: $before,
                      beforeLimit: 10, afterLimit: $limit) {
        timestamp message severity
        tags { serviceId deploymentId }
      }
    }
    """
    try:
        data = gql(token, query, {
            "e": env_id, "anchor": iso(start), "before": iso(end), "limit": limit,
        })
    except SystemExit as exc:  # gql exits on GraphQL errors; re-raise after classify
        text = str(exc)
        if "too much data" in text:
            return [], "too_much_data"
        raise
    return data["environmentLogs"] or [], None


def fetch_window(token: str, env_id: str, start: dt.datetime, end: dt.datetime,
                 limit: int) -> list[dict]:
    """Fetch a window, splitting it automatically when Railway refuses the scan."""
    lines: list[dict] = []
    queue: list[tuple[dt.datetime, dt.datetime]] = [(start, end)]
    seen: set[str] = set()

    while queue:
        chunk_start, chunk_end = queue.pop(0)
        if chunk_end <= chunk_start:
            continue
        rows, error = fetch_chunk(token, env_id, chunk_start, chunk_end, limit)
        if error == "too_much_data":
            mid = chunk_start + (chunk_end - chunk_start) / 2
            if mid <= chunk_start:
                sys.exit(
                    f"error: Railway refuses to scan {chunk_start.isoformat()} "
                    f"(window too dense even when split)"
                )
            queue.insert(0, (mid, chunk_end))
            queue.insert(0, (chunk_start, mid))
            continue
        for row in rows:
            stamp = row["timestamp"]
            if stamp in seen:
                continue
            seen.add(stamp)
            lines.append(row)
        # A hit on the row limit means the window may hold more: resume after
        # the last timestamp we actually received.
        if len(rows) >= limit and rows:
            resume = parse_railway_stamp(rows[-1]["timestamp"]) + dt.timedelta(microseconds=1)
            if resume < chunk_end and resume > chunk_start:
                queue.insert(0, (resume, chunk_end))

    lines.sort(key=lambda r: r["timestamp"])
    return lines


def parse_railway_stamp(value: str) -> dt.datetime:
    return to_utc(value)


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
NUM_RE = re.compile(r"\d+")


def normalise(message: str) -> str:
    message = re.sub(r"^\S+Z \[\w+\]\s+", "", message)
    message = UUID_RE.sub("<uuid>", message)
    message = NUM_RE.sub("N", message)
    return message[:140]


def print_lines(rows: list[dict], grep: str | None, limit_out: int | None,
                service: str | None = None, with_service: bool = False) -> int:
    pattern = re.compile(grep, re.IGNORECASE) if grep else None
    shown = 0
    for row in rows:
        if service and row.get("service_name") != service:
            continue
        message = row.get("message") or ""
        if pattern and not pattern.search(message):
            continue
        prefix = f"{row.get('service_name', '?'):<18} " if with_service else ""
        print(f"{row['timestamp']} {prefix}{message}")
        shown += 1
        if limit_out and shown >= limit_out:
            break
    return shown


def print_summary(rows: list[dict], top: int, grep: str | None,
                  service: str | None = None) -> None:
    pattern = re.compile(grep, re.IGNORECASE) if grep else None
    counts: dict[str, int] = {}
    total = 0
    for row in rows:
        if service and row.get("service_name") != service:
            continue
        message = row.get("message") or ""
        if pattern and not pattern.search(message):
            continue
        total += 1
        key = normalise(message)
        counts[key] = counts.get(key, 0) + 1
    print(f"--- summary of {total} lines" + (f" ({service})" if service else "") + " ---")
    for key, count in sorted(counts.items(), key=lambda kv: -kv[1])[:top]:
        print(f"{count:>7}  {key}")


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------
def cmd_project(token: str, args: argparse.Namespace) -> None:
    data = gql(token, "query { projects { edges { node { id name } } } }")
    for edge in data["projects"]["edges"]:
        node = edge["node"]
        marker = "*" if node["name"] == args.project else " "
        print(f"{marker} {node['name']:30} {node['id']}")
    project = resolve_project(token, args.project)
    details = project_details(token, project["id"])
    print(f"\nproject {details['name']} ({project['id']})")
    print("environments:")
    for edge in details["environments"]["edges"]:
        print(f"  {edge['node']['name']:15} {edge['node']['id']}")
    print("services:")
    for edge in details["services"]["edges"]:
        print(f"  {edge['node']['name']:25} {edge['node']['id']}")


def cmd_services(token: str, args: argparse.Namespace) -> None:
    project = resolve_project(token, args.project)
    details = project_details(token, project["id"])
    print(f"project: {details['name']} ({project['id']})")
    print("environments:")
    for edge in details["environments"]["edges"]:
        print(f"  {edge['node']['name']:15} {edge['node']['id']}")
    print("services:")
    for edge in details["services"]["edges"]:
        print(f"  {edge['node']['name']:25} {edge['node']['id']}")


def pick_environment(details: dict, wanted: str) -> str:
    environments = {e["node"]["name"]: e["node"]["id"]
                    for e in details["environments"]["edges"]}
    if wanted in environments:
        return environments[wanted]
    if wanted in environments.values():
        return wanted
    names = ", ".join(environments)
    sys.exit(f"error: environment {wanted!r} not found in this project (have: {names})")


def cmd_read(token: str, args: argparse.Namespace) -> None:
    project = resolve_project(token, args.project)
    details = project_details(token, project["id"])
    env_id = pick_environment(details, args.env)
    services = {e["node"]["id"]: e["node"]["name"]
                for e in details["services"]["edges"]}
    service_filter = args.service.lower() if args.service else None
    if service_filter and not any(service_filter in name.lower()
                                  for name in services.values()):
        names = ", ".join(sorted(services.values()))
        sys.exit(f"error: no service matches {args.service!r} (have: {names})")

    if args.since:
        end = dt.datetime.now(dt.timezone.utc)
        start = end - parse_since(args.since)
    elif args.source and args.to:
        start, end = to_utc(args.source), to_utc(args.to)
    else:
        sys.exit("error: give either --from/--to or --since")
    if end <= start:
        sys.exit("error: window end must be after its start")

    window = end - start
    print(
        f"# project={project['name']} env={args.env} ({env_id}) "
        f"window={iso(start)} -> {iso(end)} ({window.total_seconds():.0f}s)",
        file=sys.stderr,
    )
    rows = fetch_window(token, env_id, start, end, args.limit)
    for row in rows:
        row["service_name"] = services.get(
            (row.get("tags") or {}).get("serviceId"), "?"
        )
    if service_filter:
        rows = [r for r in rows
                if service_filter in (r.get("service_name") or "").lower()]
    print(f"# fetched {len(rows)} lines", file=sys.stderr)

    if args.summary:
        print_summary(rows, args.summary, args.grep)
        return
    print_lines(rows, args.grep, args.max, with_service=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="railway-logs",
        description="Read Railway logs through GraphQL using the project token "
                    f"stored in .env ({TOKEN_VAR}).",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--project", default=DEFAULT_PROJECT,
                        help=f"project name or id (default: {DEFAULT_PROJECT})")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("project", parents=[common],
                   help="list projects visible to the token")
    sub.add_parser("services", parents=[common],
                   help="list services and environments of a project")

    read = sub.add_parser("read", parents=[common], help="read a log window")
    read.add_argument("--env", default="production", help="environment name or id")
    read.add_argument("--from", dest="source", help="window start (UTC, ISO)")
    read.add_argument("--to", dest="to", help="window end (UTC, ISO)")
    read.add_argument("--since", help="relative window, e.g. 30m, 2h, 1d")
    read.add_argument("--grep", help="regular expression applied to each line")
    read.add_argument("--service",
                      help="only lines of one service (e.g. Listener, Trade)")
    read.add_argument("--limit", type=int, default=800,
                      help="max rows fetched per chunk (default 800)")
    read.add_argument("--max", type=int, default=0,
                      help="max lines to print (0 = all)")
    read.add_argument("--summary", type=int, metavar="N",
                      help="print the N most common normalised messages instead")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    token = load_token()
    if args.command == "project":
        cmd_project(token, args)
    elif args.command == "services":
        cmd_services(token, args)
    elif args.command == "read":
        cmd_read(token, args)


if __name__ == "__main__":
    main()
