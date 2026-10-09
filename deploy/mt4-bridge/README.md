# MT4 bridge — deployment runbook

**Status (2026-09-29).** The MT5 bridge is running and currently uses a session
database next to it. MT4 is **not installed yet**. This runbook installs MT4 and
removes that session database.

**Server:** Contabo VPS `13.140.44.122` (Ubuntu 24.04, root required)

---

## What we are doing, in plain English

**1. Give MT4 its own container.** MT5 already has one. MT4 needs a second,
separate container — the two programs cannot share one.

**2. Remove the session database.** A small database was added beside the
containers to remember broker logins across restarts. It turned out to store
broker passwords in plain text on disk. Everything it provided, the application
already does for itself: when a connection is lost it signs the account back in
from its own encrypted records. So the database is being removed rather than
encrypted — removing it means those passwords stop existing on that server at
all.

**What this costs.** After a container restart, accounts take up to about four
minutes to sign back in, or they sign in immediately when the next trade
arrives. That is the trade: a few minutes instead of a second, in exchange for
no broker passwords sitting on the server.

Neither change alters how trades are placed.

---

## Before you start

1. **You can log in as root** on `13.140.44.122`.
2. **Nothing is mid-trade you cannot reconcile.** Steps 2 and 5 recreate the
   bridge containers. A trade being placed at that moment would end in an
   unknown state that has to be checked by hand against the broker.
3. **You know the licence state.** The MT4 image runs as a 14-day trial unless a
   licence is applied. Check what the existing MT5 container runs under before
   adding a second one.

---

## Step 1 — Copy the files to the server

From your local checkout:

```bash
bash deploy/mt4-bridge/01-copy-files.sh
```

It stages the scripts, the log redactor and the nginx config, copies them to
`/root/mt4-deploy`, prints the file list and confirms they arrived.

---

## Step 2 — Install the MT4 bridge

```bash
ssh root@13.140.44.122 'bash /root/mt4-deploy/04-mt4-bridge.sh'
```

Expected:

```
Status    : installing
PASS  local /Ping -> 200
WAIT  nginx does not serve the MT4 path yet — run stage 5
PASS  port bound to 127.0.0.1 only
PASS  port 8081 is not reachable from outside
PASS  no database connection (as intended)
ALL CHECKS PASSED — except nginx, which still needs stage 5
```

The `WAIT` line is expected here and is resolved by the next step.

---

## Step 3 — Expose MT4 through nginx

```bash
ssh root@13.140.44.122 'bash /root/mt4-deploy/05-nginx.sh'
```

It backs up the current config, installs the new one, checks it, reloads nginx
and rolls itself back automatically if the check fails.

Confirm the MT4 path now answers and MT5 is untouched:

```bash
curl -s https://mtapi.tscopier.ai:9443/mt4/Ping     # expect: OK
curl -s https://mtapi.tscopier.ai:9443/health       # expect: Healthy
```

---

## Step 4 — Tell the application where MT4 lives

The application already prefers a dedicated MT4 address when one is present.

- **Supabase** (migration project `supmsgcubipmmowrzoub`), add:

  ```
  MTAPI_MT4_BASE_URL = https://mtapi.tscopier.ai:9443/mt4
  ```

- **Railway** (migration project), add the same variable to the worker
  services, then restart them so they pick it up.

The CLI cannot reach Railway from here — this one is a dashboard job. See
`docs/mtapi-credentials.md` for the full secret list.

---

## Step 5 — Check both bridges can recover without the database  ← DO NOT SKIP

```bash
ssh root@13.140.44.122 'bash /root/mt4-deploy/11-check-reconnect.sh'
```

This asks each bridge what it says when asked about a session it does not know.
The application only signs an account back in when it recognises that message.
If a bridge words it differently, reconnecting would silently stop working and
trades would fail — so this step exists to catch that *before* anything is
removed. It only reads; it starts nothing and trades nothing.

Expected:

```
PASS  the application will recognise this and sign in again
...
BOTH BRIDGES ARE SAFE TO RUN WITHOUT THE SESSION DATABASE.
```

If it prints `STOP`, do not continue — send us the exact status and answer it
printed. On success it records that both bridges were proven, and the next step
refuses to run without that record. (To record it again, just re-run this.)

---

## Step 6 — Remove the session database

```bash
ssh root@13.140.44.122 'bash /root/mt4-deploy/10-remove-session-db.sh'
```

This takes the bridges off the database, removes the database container and
checks that MT5 and MT4 still answer. Safe to re-run.

It refuses to run while any bridge is still attached to the database and step 5
has not proven both, and says so if that is the case. Once the bridges are off
it, re-running is allowed — that is how you drop the stored contents.
If a bridge fails to rebuild, it stops immediately and prints the exact command
to bring it back — it does not leave you with a dead bridge and no way back.

Its stored contents are kept by default. Once everything above is confirmed
working, drop them too:

```bash
ssh root@13.140.44.122 'REMOVE_DATA=1 bash /root/mt4-deploy/10-remove-session-db.sh'
```

---

## Step 7 — Verify

From your machine:

```bash
python3 deploy/mt4-bridge/verify.py quick
python3 deploy/mt4-bridge/verify.py signin
```

Confirm both bridges carry the restart policy, so a daemon or host restart brings
them back by itself:

```bash
ssh root@13.140.44.122 \
  "docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}} {{.State.Running}}' mtapi mt4rest"
```

Expected: `mtapi unless-stopped true` and `mt4rest unless-stopped true`.
A policy of `no`, or `running=false`, means the bridge can be left down
(see `docs/incidents/incident-2026-10-08-mtapi-bridge-outage.md`).

Then prove recovery works, which is the whole point of this change:

```bash
ssh root@13.140.44.122 'docker restart mt4rest'
# wait ~10 seconds, then:
python3 deploy/mt4-bridge/verify.py resume
```

`resume` should succeed. If it does, the account signed back in by itself with
no database involved.

---

## Step 8 — Link an account from the frontend

1. Open `https://migration.tscopier.ai` — it is built against the migration
   database that has the connect functions; staging and production do not.
2. Add a broker account and select **MT4**.
3. Watch it reach `connected`, then confirm it reads prices and history.

---

## Rollback

**nginx only** (containers untouched):

```bash
cp "/etc/nginx/conf.d/mtapi-tscopier.conf.bak-<stamp>" /etc/nginx/conf.d/mtapi-tscopier.conf
nginx -t && systemctl reload nginx
```

**Remove MT4 entirely:**

```bash
docker rm -f mt4rest
# then roll back nginx as above
```

**Undo a bridge recreation** (sessions rebuild by themselves either way):

```bash
cd /root/mt4-deploy
CONTAINER=mtapi IMAGE=timurila/mt5rest HOST_PORT=8080 NETWORK=mtapi-net bash install.sh
```

**Bringing the session database back** is not a rollback we recommend — it
reintroduces plain-text broker passwords. The scripts that built it are kept in
`retired-session-db/` for reference only.

---

## Troubleshooting

**`https://mtapi.tscopier.ai:9443/mt4/Ping` returns 404**

nginx is serving an old config. Check `grep -n mt4_backend
/etc/nginx/conf.d/mtapi-tscopier.conf` and re-run step 3.

**MT4 container dies on start**

```bash
docker logs mt4rest --tail 30
```

If it is an image or licence error, tell us before retrying — repeated failed
sign-ins to the broker are worth avoiding.

**An account shows as disconnected after a restart**

Expected for up to four minutes. It signs back in on its own. If it does not
recover within ten, check that automatic reconnection is enabled on that
account, since recovery is skipped for accounts that have it switched off.

**Account links but shows no data**

The application is probably still pointed at the MT5 address. Check
`MTAPI_MT4_BASE_URL` is present in the migration project's secrets, and that the
Railway services were restarted after it was added.

**Step 5 says a message is not recognised**

Stop and report it. Reconnecting would fail for that platform until the wording
is added to the list the application recognises.

---

## How we know it will work

1. **Every script was run against a stand-in environment first** — real syntax
   checks plus full dry runs, with Docker, the bridges and the network replaced
   by stand-ins that answer exactly the way the real ones do. This catches
   wrong flags, wrong order, broken checks and damage on a re-run.
2. **Read over by independent reviewers** across four rounds, specifically for
   data loss, lockouts and leaked secrets. Real problems were found and fixed
   before anything ran.
3. **Each step checks its own result** and refuses to report success otherwise.
4. **The risky assumption is tested before it matters.** The only thing that
   cannot be known from here is how each bridge words a "session has gone"
   error; step 5 asks them directly, and step 7 proves a real account recovers.

---

## Known limits

- **A trade in flight when a container restarts** is still the one case needing
  manual reconciliation. The database never fixed this either.
- **Every restart is a fresh login to your broker.** Without the database,
  recovery signs in again rather than reusing a stored session. Brokers that
  watch for repeated logins from a new location may take an interest; this is
  the main reason to keep restarts rare.
- **Licence.** Confirm before this runs unattended — see "Before you start".
- **First run pulls images.** `timurila/mt4rest` may need downloading.
- **MT4 partial closes move the remainder to a new ticket.** Trade management
  still tracks the original one.
- **Log redaction** applies to both bridges. Never paste raw `docker logs`
  output into a ticket or chat.
