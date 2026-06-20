# Telegram Safe Reintegration Runbook

Follow these steps **in order** the next time you connect a Telegram account.
This runbook is the operational counterpart to the architectural changes
already shipped in this folder.

---

## 1. Rotate Telegram API credentials

The `api_id`/`api_hash` previously used may be flagged. Generate fresh ones:

1. Sign in at https://my.telegram.org with your **personal**, fully warmed-up
   Telegram account (not the one being onboarded).
2. Open **API development tools** and create a new application:
   - App title: anything (e.g. `tscopier-worker`)
   - Short name: `tscopier`
   - Platform: Desktop
3. Copy the new `api_id` and `api_hash`.

Set them in two places:

- `worker/.env` — `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- Supabase project secrets — same keys (used by edge functions)

Do **not** commit them. Do **not** reuse the old pair.

---

## 2. Warm up the new phone number (≥ 7 days)

Before any API call:

- Install the **official** Telegram mobile app and sign in with the new number.
- Have real conversations with 3–5 contacts.
- Join 5–10 channels normally (browse, scroll, react).
- Send and receive media at least once.
- Leave the app idle overnight several times.

Do **not** touch the API during this period. Telegram's anti-spam scoring is
heavily weighted on app activity history.

---

## 3. Set 2FA on the new account

In the Telegram app: **Settings → Privacy and Security → Two-Step Verification**.
Set a password and a recovery email. Accounts without 2FA are auto-flagged
much faster on first API contact.

The onboarding UI now gates completion behind a "I've set 2FA" confirmation
(`src/pages/onboarding/steps/TelegramLinkStep.tsx`), but you must actually do
it for the protection to apply.

---

## 4. Do the first authentication from a residential IP

The very first MTProto packet on the account must **not** come from a cloud
datacenter ASN. Two acceptable approaches:

### Option A — Run the worker locally for the first connect (recommended)

1. On your laptop (residential ISP or phone tethering — **not** a VPN to a
   datacenter), copy `worker/.env.example` to `worker/.env` and fill in the
   real values, including the **production** Supabase URL and service key
   (so the persisted session row lands in the production DB).
2. `cd worker && npm install && npm run dev`
3. Trigger `send_code` and `verify_code` once (via the deployed UI pointing
   at this local worker, or via curl directly against `http://localhost:8080`
   with the internal token). The worker writes the `session_string` to the
   `telegram_sessions` table.
4. Stop the local worker (Ctrl-C). The session is now persisted.
5. Deploy the cloud worker (Step 5 below). On startup, `loadAll()` will pick
   up the session from Supabase and connect with the same `session_string`.
   Telegram sees the second connection as a normal "session moved to a new
   device" event rather than a fresh signup from a datacenter.

### Option B — Residential proxy on the cloud worker

If running locally is impractical, route the cloud worker's outbound MTProto
through a residential or mobile proxy. GramJS supports proxies via the
`proxy` option on `TelegramClient`. Plug it in inside `buildClient` in
`worker/src/telegramClient.ts`:

```ts
proxy: {
  ip: process.env.TG_PROXY_IP!,
  port: parseInt(process.env.TG_PROXY_PORT!),
  socksType: 5,
  username: process.env.TG_PROXY_USER,
  password: process.env.TG_PROXY_PASS,
}
```

Use a stable residential endpoint — rotating proxies will cause MTProto
to re-handshake from new IPs and trigger the same ban signal we are
trying to avoid.

---

## 5. Deploy the cloud worker with a pinned egress IP

- Use a host that lets you pin a static outbound IP (Fly dedicated IPv4,
  Render egress, Hetzner with floating IP, etc.).
- After binding the session to a region/IP, **do not** redeploy to a
  different region. DC reassignment on a fresh session is itself a ban
  trigger.
- Required env (see `worker/.env.example`):
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (from Step 1)
  - `PARSE_SIGNAL_URL`, `PARSE_SIGNAL_KEY`
  - `WORKER_INTERNAL_TOKEN` (long random secret, e.g. `openssl rand -hex 32`)
  - `WORKER_PORT` (defaults to `8080`)

The worker exposes:
- `POST /auth/send_code`
- `POST /auth/verify_code`
- `POST /auth/list_channels`
- `GET  /health` (auth-free, returns 503 when any listener has been
  stalled for more than 5 minutes)

The MTProto endpoints require the `x-internal-token` header. `/health`
does not — it is intended for external uptime monitors.

### 5a. Single-instance rule (critical)

Only **one** worker may run against a given `telegram_sessions.session_string`
at a time. Telegram's protocol allows a single active connection per
session; if a second instance authenticates with the same string the
first is forcibly logged out (`AUTH_KEY_DUPLICATED`), causing a message
gap and re-handshake from a new IP — which is itself a ban signal.

Pick exactly one of the supervision recipes below. Do not run the worker
both as a docker-compose service and a systemd unit on the same host.

#### Docker (recommended)

`worker/docker-compose.yml` is included.

```bash
cd worker
cp .env.example .env  # then fill in real values
docker compose up -d --build
docker compose logs -f --tail=200
```

`container_name: tscopier-worker` plus `restart: always` makes a second
`docker compose up` on the same host fail rather than silently start a
duplicate. The healthcheck exercises `/health` every 60 s; combined with
[autoheal](https://github.com/willfarrell/docker-autoheal) (or Docker
Swarm) the container will be recreated on three consecutive failures.

#### systemd

```ini
# /etc/systemd/system/tscopier-worker.service
[Unit]
Description=TScopier Telegram worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/tscopier-worker
EnvironmentFile=/opt/tscopier-worker/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tscopier-worker
journalctl -u tscopier-worker -f
```

#### Fly.io

`fly.toml` snippet:

```toml
app = "tscopier-worker"
primary_region = "lhr"   # pick once, never change after the first auth

[build]
  dockerfile = "Dockerfile"

[[services]]
  internal_port = 8080
  protocol = "tcp"
  auto_stop_machines = false   # MUST stay running 24/7
  auto_start_machines = true
  min_machines_running = 1
  max_machines_running = 1     # single instance — see Section 5a above

  [[services.tcp_checks]]
    interval = "30s"
    timeout  = "5s"
    grace_period = "30s"

  [[services.http_checks]]
    interval = "60s"
    grace_period = "30s"
    method = "get"
    path = "/health"
    protocol = "http"
```

Set `min_machines_running = max_machines_running = 1` so Fly never
scales to two replicas during a deploy. Use `fly deploy --strategy=immediate`
to avoid a brief overlap window between old and new machines.

### 5b. Real-time listener guarantees

The worker's listener is built to deliver every message in a monitored
signal channel into the `signals` table within ~1 s, and to recover from
restarts and network blips without losing messages:

- **Always-on connection.** gramjs `autoReconnect: true` plus a 30-second
  watchdog (`updates.GetState` probe). Two consecutive probe failures
  force `disconnect()` + `connect()` and re-bind the channel filter.
- **Catch-up on (re)connect.** Each monitored channel has a
  `last_seen_message_id` high-water mark. After connecting, the listener
  pages `messages.GetHistory` from that id forward (cap 200 per channel)
  and inserts via the same `signals` upsert path used by live events. The
  partial unique index on `signals(user_id, telegram_message_id)` makes
  the insert idempotent so live + catch-up cannot duplicate a row.
- **First-ever listen does not backfill.** When `last_seen_message_id`
  is null for a channel, the listener seeds it from the latest message
  id without inserting anything — so adding a 5-year-old signal channel
  does not flood `signals` with history.
- **Instant subscription updates.** A Supabase Realtime subscription on
  `telegram_channels` rebinds the gramjs `NewMessage` filter the moment
  a user toggles a channel on or off (rather than waiting up to 5 min).
- **Health visibility.** `/health` returns 503 if any listener has been
  silent for more than 5 minutes, so an external monitor (UptimeRobot,
  BetterStack, etc.) can page on stalls.

---

## 6. Configure the supabase edge function

Add these secrets to the Supabase project (Project Settings → Edge Functions
→ Secrets):

- `WORKER_URL` — public URL of the worker (e.g. `https://worker.example.com`)
- `WORKER_INTERNAL_TOKEN` — same value as on the worker

Re-deploy the `telegram-auth` edge function. It is now a thin proxy and
contains no MTProto code.

---

## 7. Verify before onboarding more users

1. Connect the warmed account end-to-end.
2. Let the listener idle for 30 minutes — do **not** call `list_channels`.
   Confirm `@SpamBot` in Telegram still responds normally.
3. Call `list_channels`, pick 1–2 channels, and let messages flow for an hour.
4. Check `@SpamBot` daily for the first 7 days.
5. Stagger additional user onboarding — no more than one new account per
   IP per day for the first week.

If `@SpamBot` reports a limitation, **stop**, write to `recover@telegram.org`
from the affected number's email, and don't onboard more accounts until the
restriction is lifted.
