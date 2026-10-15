# Incident report — MTAPI bridge Docker logs have no size limit (2026-10-07)

**Detected:** 2026-10-07 · **Component:** VPS hosting — Docker logging for the MTAPI bridge ·
**Status:** Open (diagnosed, not yet fixed)

| Field | Value |
|---|---|
| Severity | Low — the disk is only 7% full, but one log file already holds 2.9 GB and nothing stops it growing |
| Status | **Open** — diagnosis complete, no change deployed yet |
| Reported by | Found during the "Single target TP" investigation (2026-10-07) |
| Affected users | All — the bridge serves every trade on the platform |
| Component | VPS Docker logging (`mtapi`, `mt4rest`) and `deploy/mtapi-log-redactor/install.sh` |
| Root cause | Containers are created with no log driver and no log options, so Docker uses the unbounded `json-file` driver; no size cap exists anywhere |
| Data impact | None — no customer data is at risk; this is a disk-exhaustion and log-retention problem |

---

## 1. Executive summary (plain English)

The MTAPI bridge — the small service on our VPS that actually places and modifies trades on the
MetaTrader terminal — writes a log line for **every request it receives**, and each line contains
the full request URL, which is long. Docker's default behaviour is to keep every line forever in a
single file, with **no maximum size and no rotation**.

Nothing in our setup caps that file. Our container installation script does not pass a log size
limit, we have no Docker daemon configuration file that sets a default, and the only time we ever
touch a log file is to wipe it during a security reinstall.

**Measured state of the disk today:** the disk is healthy — only **7% used (6.5 GB of 96 GB)**.
But one container's log file has already grown to **2.9 GB**, which is roughly a third of
everything stored on the machine, and it is still growing. Nothing is broken yet. The risk is that
it keeps growing silently until the disk fills, at which point Docker and the trading terminal
start failing in ways that are painful to diagnose.

There is a second, more useful finding: this log is **the only place** where we can see exactly what
the broker was asked to do. It turned out to be essential evidence in today's trading investigation,
so losing it — or having it roll over — directly costs us debugging capability.

The fix is small: give the container a log size limit when we create it.

---

## 2. Issue encountered

Investigating an unrelated trade problem, we needed the MTAPI bridge's own request log to see what
the broker had actually been asked to do. That log turned out to hold the only copy of the answer.
It then raised a second question: how far back does this log go, and how big is it?

### a) Measurements taken on the production VPS (2026-10-07)

**Overall disk:**

```
$ df -h /
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        96G  6.5G   90G   7% /
```

**Container log files (the unbounded ones):**

```
$ du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail -10
110M    .../ac4da626a5fd.../ac4da626a5fd...-json.log
2.9G    .../f92a9d631a24.../f92a9d631a24...-json.log
```

The 2.9 GB file is the bridge's log — the container handling every trade request. (Map container
IDs to names with `docker ps -a --format '{{.ID}} {{.Names}}'`.)

**Confirming no size limit is configured:**

```
$ docker ps -a --format '{{.Names}}' | xargs -I{} docker inspect -f \
    '{{.Name}} driver={{.HostConfig.LogConfig.Type}} opts={{.HostConfig.LogConfig.Config}}' {}
/mt4rest driver=json-file opts=map[]
/mtapi driver=json-file opts=map[]
```

`opts=map[]` is an empty options map — proof that neither container has a size limit.

**Confirming there is no daemon-wide default:**

```
$ cat /etc/docker/daemon.json 2>/dev/null || echo "no daemon.json"
no daemon.json
```

**nginx access and error logs (separate files):**

```
$ ls -lh /var/log/nginx/
total 237M
-rw-r----- 1 www-data adm    65M Oct  8 00:00 mtapi-access.log
-rw-r----- 1 www-data adm   101M Oct  7 00:00 mtapi-access.log.1
-rw-r----- 1 www-data adm   2.1M Oct  6 00:00 mtapi-access.log.2.gz
... daily .gz files back to Sep 21 ...
```

**Good news here:** nginx *is* rotating daily, roughly two weeks of compressed history is kept, and
this is not an active problem. It is noted because incident investigations depend on it.

### b) Two findings

1. **The Docker container log has no retention policy at all.** Docker's default `json-file`
   driver is in use because nothing overrides it. That driver writes to a single file per container
   and never rotates or truncates it on its own.
2. **The only log-size handling in the entire repository is a security wipe.** The installation
   script truncates log files to zero **only** as part of removing evidence of a previously exposed
   password (the 2026-09-23 incident). That is a one-off cleanup, not a size policy.

For reference, the 2026-09-23 incident report already listed *"Optionally cap Docker log size for
future restarts (`n` / `max-file` on the `mtapi` service)"* as a suggested follow-up. It was never
actioned.

---

## 3. Affected user(s)

Not user-specific. Every trade placed through the bridge contributes lines to this log, so growth
scales with platform activity rather than with any one customer.

| Item | Value |
|---|---|
| Containers affected | `mtapi` (the bridge), `mt4rest` |
| Log driver in use | Docker default `json-file` |
| Options configured | **None** (`opts=map[]`) |
| Largest log file | **2.9 GB** |
| Other container log | 110 MB |
| Disk usage | 6.5 GB of 96 GB (**7%**) |
| Rotation | **None** |
| nginx access log | 65 MB current + 101 MB previous, rotating daily — **working, unaffected** |

---

## 4. Root cause

`deploy/mtapi-log-redactor/install.sh` creates the container with `docker run -d` at **line 139**
and passes `--name`, `--restart always`, network/port/environment/volume arguments and a custom
entrypoint — but **no `--log-driver` and no `--log-opt`**:

```sh
docker run -d \
  --name "$CONTAINER" \
  --restart always \
  ...
  --entrypoint /mtapi-redactor/entrypoint.sh \
  "$IMAGE"
```

Consequences:

- Docker falls back to its compiled-in default, the `json-file` driver.
- The default `json-file` driver has no `max-size` and no `max-file`, so the file grows forever.
- There is **no `/etc/docker/daemon.json`** on the VPS (verified above), so there is no
  daemon-wide default that would have applied either.
- `install.sh` lines 188 and 192 call `truncate -s 0` on the container log — but only to scrub
  credentials during a reinstall, and only for the specific old and new container IDs involved.

The log redactor (`deploy/mtapi-log-redactor/redact.awk`) strips account passwords from lines as
they are written, so **this is not a secret-exposure issue** (that was the separate 2026-09-23
incident). It is purely an unbounded-growth issue.

---

## 5. The fix

### Step A — reclaim the space (the prune)

Two options. **Option 1 is preferred** because it does not interrupt trading.

**Option 1 — reclaim by redeploying (no trading interruption).**

Creating a container gives it a brand-new log file, and removing the old container removes its log
directory with it. Applying the fix in Step B and rerunning the installer therefore reclaims the
space as a side effect:

```bash
cd /root/TSCopier   # or wherever the repo lives on the VPS
docker rm -f mtapi
bash deploy/mtapi-log-redactor/install.sh
du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail -10
df -h /
```

**Option 2 — reclaim immediately without redeploying (brief trading interruption).**

Stopping the containers pauses trade execution for a few seconds, so **only do this in a quiet
window — outside market hours or at the weekend.**

```bash
docker stop mtapi mt4rest
find /var/lib/docker/containers -name '*-json.log' -exec truncate -s 0 {} +
docker start mtapi mt4rest
df -h /
```

> Truncating the log of a *running* container is not reliable, which is why Option 2 stops the
> containers first. Option 1 avoids the question entirely.

### Step B — cap the log so it cannot happen again

1. **Add log options to the container creation** in `deploy/mtapi-log-redactor/install.sh`,
   inside the `docker run -d` block at line 139:

   ```sh
   --log-driver json-file \
   --log-opt max-size=50m \
   --log-opt max-file=3 \
   ```

   This caps each container at 150 MB worst case (50 MB × 3 files).

2. **Add a daemon-wide default** at `/etc/docker/daemon.json` on the VPS, so containers we create
   later — including `mt4rest`, which is not created by this script — are capped too:

   ```json
   {
     "log-driver": "json-file",
     "log-opts": {
       "max-size": "50m",
       "max-file": "3"
     }
   }
   ```

   Apply it with `systemctl restart docker`. **Important:** these defaults only affect containers
   created *after* the restart; existing containers keep the settings they were created with, so
   they must still be recreated (Option 1 above).

3. **nginx needs no change.** Rotation was verified as working (daily `.gz` history back to
   21 September). Keep it as-is and re-check after any nginx reconfiguration.

---

## 6. Files changed

*Nothing has been changed yet.* The planned changes are:

| File | Change |
|---|---|
| `deploy/mtapi-log-redactor/install.sh` | Add `--log-driver json-file --log-opt max-size=50m --log-opt max-file=3` to the `docker run -d` block (line 139) |
| VPS `/etc/docker/daemon.json` | Create with daemon-wide log defaults (not in the repo — VPS only) |
| `docs/incidents/incident-2026-10-07-mtapi-bridge-log-retention.md` | This report |
| `docs/PROJECT_MEMORY.md` | Changelog entry |

---

## 7. Verification

After the fix is deployed:

1. `docker inspect -f '{{.HostConfig.LogConfig}}' mtapi` must show
   `json-file map[max-file:3 max-size:50m]`.
2. `df -h /` must show the reclaimed space (baseline: 6.5 GB used, 7%).
3. `du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail -10` must show every log file
   under 150 MB (baseline: 2.9 GB and 110 MB).
4. `cat /etc/docker/daemon.json` must exist and contain the log options.
5. Trade normally for a few days and confirm log files stop growing past the cap.

---

## 8. Deployment status

**Not deployed.** This is a VPS-side change and is not covered by the Railway or Netlify
deployments. It must be applied manually on the production VPS.

Because the disk is only 7% full, this is **not urgent** — it can be done in a normal maintenance
window. Recreating the container briefly interrupts trade execution, so schedule it outside market
hours.

---

## 9. Follow-ups

1. Apply Step A and Step B on the VPS in a quiet market window.
2. Add the log cap to the MTAPI cutover runbook so a future rebuild does not reintroduce it.
3. Decide whether the bridge request log should also be kept for a fixed number of days rather
   than only capped by size — incident investigations depend on being able to look back at it.
4. **Confirmed working, no action:** nginx access-log rotation (daily, ~2 weeks of history).
5. Re-measure the disk after the fix and record the "after" numbers here.
