#!/usr/bin/env python3
"""Verify the self-hosted MT4 bridge and prove sessions survive a restart.

Run from a machine that can reach the server. Credentials come from the
environment only — nothing is printed, nothing is written outside the
session file.

Subcommands
  quick    liveness, auth enforcement, port privacy (no broker credentials)
  signin   sign in to the broker and store the session for the restart test
  resume   check that stored session still works after `docker restart mt4rest`
  close    sign out and remove the stored session file

Environment
  MTAPI_BASE            default https://mtapi.tscopier.ai:9443/mt4
  MTAPI_API_KEY         from /root/.mtapi_api_key on the server
  MTAPI_INTERNAL_TOKEN  from /root/.mtapi_internal_token on the server
  MT4_PUBLIC_IP         default 13.140.44.122 (used by `quick`)
  MT4_USER or MT4_LOGIN / MT4_PASSWORD / MT4_SERVER   broker account (signin/resume/close)

Session file: /tmp/mt4-bridge-session.json (mode 600, removed by `close`)
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("MTAPI_BASE", "https://mtapi.tscopier.ai:9443/mt4").rstrip("/")
API_KEY = os.environ.get("MTAPI_API_KEY", "").strip()
INTERNAL = os.environ.get("MTAPI_INTERNAL_TOKEN", "").strip()
PUBLIC_IP = os.environ.get("MT4_PUBLIC_IP", "13.140.44.122")
SESSION_FILE = "/tmp/mt4-bridge-session.json"

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def call(endpoint, params=None, auth=True, timeout=45):
    """Returns (status, body). Never raises on HTTP errors."""
    params = dict(params or {})
    query = urllib.parse.urlencode(params, doseq=True)
    url = f"{BASE}/{endpoint}" + (f"?{query}" if query else "")
    headers = {"Accept": "application/json, text/plain"}
    if auth:
        headers["Authorization"] = f"Bearer {API_KEY}"
        headers["X-Internal-Token"] = INTERNAL
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 — any transport failure is a test result
        return 0, f"{type(e).__name__}: {e}"


def as_json(body):
    try:
        return json.loads(body)
    except Exception:  # noqa: BLE001
        return body


def require(*names):
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        print("missing environment: " + ", ".join(missing), file=sys.stderr)
        sys.exit(2)


def broker_login():
    """The saved credential file calls it MT4_LOGIN; callers may use MT4_USER."""
    return os.environ.get("MT4_USER") or os.environ.get("MT4_LOGIN")


def summary():
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


def cmd_quick():
    # 1. Liveness — MT4 answers /Ping, not /health (verified 2026-09-29).
    status, body = call("Ping", auth=False)
    record("bridge reachable through nginx (/Ping)", status == 200, f"status={status}")

    # 2. /health must not be what we depend on — informational.
    status, _ = call("health", auth=False)
    record("/health absent as expected", status == 404, f"status={status}")

    # 3. Auth is enforced on a data endpoint (both layers: token then key).
    status, _ = call("AccountSummary", auth=False)
    record("data endpoint rejects unauthenticated calls", status in (401, 403), f"status={status}")

    # 4. With headers we pass nginx and reach the container.
    status, _ = call("AccountSummary", {"id": "__probe__"})
    record(
        "authenticated request reaches the container",
        status not in (0, 401, 403),
        f"status={status} (404 = endpoint answered, auth fine)",
    )

    # 5. The container port must not be reachable from outside the server.
    sock = socket.socket()
    sock.settimeout(5)
    try:
        sock.connect((PUBLIC_IP, 8081))
        sock.close()
        open_to_internet = True
    except Exception:  # noqa: BLE001
        open_to_internet = False
    record("container port 8081 is not reachable from outside", not open_to_internet)

    summary()


def cmd_signin():
    require("MT4_PASSWORD", "MT4_SERVER")
    login = broker_login()
    if not login:
        print("missing environment: MT4_USER or MT4_LOGIN", file=sys.stderr)
        sys.exit(2)
    status, body = call(
        "ConnectEx",
        {
            "user": login,
            "password": os.environ["MT4_PASSWORD"],
            "server": os.environ["MT4_SERVER"],
            "downloadOrderHistory": "true",
        },
        timeout=90,
    )
    token = as_json(body)
    if isinstance(token, str):
        token = token.strip().strip('"')
    if status not in (200, 201) or not isinstance(token, str) or not token:
        print(f"sign-in failed: status={status} body={str(body)[:200]}", file=sys.stderr)
        sys.exit(1)

    status, body = call("AccountSummary", {"id": token})
    usable = status in (200, 201) and "INTERNAL_ERROR" not in str(body)
    if not usable:
        print(f"signed in but AccountSummary failed: status={status}", file=sys.stderr)
        sys.exit(1)

    with open(SESSION_FILE, "w") as fh:
        os.chmod(SESSION_FILE, 0o600)
        json.dump({"token": token, "signed_in_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, fh)

    print(f"PASS  signed in, session stored in {SESSION_FILE}")
    print("\nNow restart the bridge on the server:")
    print("      docker restart mt4rest")
    print("Wait ~10 seconds, then run:  verify.py resume")
    sys.exit(0)


def cmd_resume():
    if not os.path.exists(SESSION_FILE):
        print("no stored session — run `verify.py signin` first", file=sys.stderr)
        sys.exit(2)
    with open(SESSION_FILE) as fh:
        token = json.load(fh)["token"]

    # CheckConnect reports whether the session is still alive inside the bridge.
    status, _ = call("CheckConnect", {"id": token})
    if status in (200, 201):
        record("session still alive after restart (CheckConnect)", True, f"status={status}")
        summary()

    # Otherwise the bridge may still be able to resume it from the database.
    status, _ = call("ConnectByToken", {"id": token})
    if status in (200, 201):
        record("session resumed from the database (ConnectByToken)", True, f"status={status}")
        status, body = call("AccountSummary", {"id": token})
        record("resumed session is usable", status in (200, 201), f"status={status}")
        summary()
        return

    record(
        "session survived the restart",
        False,
        "not alive and not resumable — the bridge is not using the database, "
        "or the stored session expired (a full re-login would still happen automatically)",
    )
    summary()


def cmd_close():
    token = None
    if os.path.exists(SESSION_FILE):
        with open(SESSION_FILE) as fh:
            token = json.load(fh)["token"]
        os.remove(SESSION_FILE)
    if token:
        status, _ = call("Disconnect", {"id": token})
        record("signed out", status in (200, 201), f"status={status}")
        summary()
    else:
        print("nothing to close")
        sys.exit(0)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {"quick", "signin", "resume", "close"}:
        print(__doc__)
        sys.exit(2)
    require("MTAPI_API_KEY", "MTAPI_INTERNAL_TOKEN")
    {"quick": cmd_quick, "signin": cmd_signin, "resume": cmd_resume, "close": cmd_close}[sys.argv[1]]()


if __name__ == "__main__":
    main()
