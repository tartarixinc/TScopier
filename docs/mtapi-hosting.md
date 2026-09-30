# MTAPI Hosting Guide

Date: 2026-09-16 · Status: **Decision made** · Owner: TBD

This document covers everything related to hosting the MTAPI Docker bridge:
infrastructure options, cost comparisons, the chosen setup (Contabo + nginx),
and how the worker connects to it.

---

## 1. What are we hosting?

MTAPI is a REST API bridge that connects to MetaTrader 5 (and 4) broker servers.
It runs as a Docker container (`timurila/mt5rest` or `mtapiio/mt5rest`, ~92MB).
The container includes the MT5 terminal + a .NET REST wrapper.

We host this bridge ourselves. The worker (on Railway) sends HTTP requests to the
bridge, which forwards them to the broker over the MT5 protocol.

```
Worker (Railway) → HTTP/HTTPS → MTAPI Bridge (Contabo) → MT5 protocol → Broker (Exness)
```

### What the Docker container actually is

The Docker container is software that does two things:

1. **Runs a MetaTrader 5 terminal** — the same trading platform that runs on a
   desktop, but running on a server inside the container.

2. **Exposes a REST API** — an HTTP interface so our code can talk to it.

When our worker needs to place a trade, it sends an HTTP request to the container.
The container receives that request, converts it into the MT5 protocol that the
broker understands, and sends it to the broker's server. The broker responds, and
the container sends the result back as JSON.

The container holds the broker connection open. Our worker does not connect to the
broker directly — it connects to the container, and the container connects to the
broker.

FXSocket does the same thing, but they run the terminals on their servers. With
the Docker container, we run the terminals on our own server. That is the only
difference.

---

## 2. Hosting options compared

### 2.1 MTAPI Cloud (hosted by mtapi.io)

| Tier | Price | Accounts | Notes |
|------|-------|----------|-------|
| Trial | Free | 1 | 14-day trial, token expires ~5min inactivity |
| Cloud 100 | $500/mo | 100 | Managed hosting, mtapi.io runs the bridge |
| Cloud 500 | $1,500/mo | 500 | Same, more capacity |
| On-Premise | $1,000/mo | Unlimited | License for self-hosted Docker |

**Pros:** No ops burden. Managed infrastructure. TLS included.
**Cons:** Expensive. $500/mo minimum for production. Token-based auth only (no API key).

### 2.2 Railway (where the worker already runs)

| Component | Cost |
|-----------|------|
| MTAPI bridge (2 vCPU, 4 GB RAM) | ~$80-100/mo |
| Worker (existing) | ~$50/mo |
| **Total** | **~$130-150/mo** |

Railway pricing: $20/vCPU/month + $10/GB RAM/month + plan fee ($5-20/mo).

**Pros:** Same platform as worker. Easy to manage. Auto-restarts.
**Cons:** Usage-based billing = expensive for an always-on service. Overkill for
a simple Docker container. Egress charges ($0.05/GB).

### 2.3 Hetzner

| Plan | CPU | RAM | Storage | Traffic | Price (US) | Price (EU) |
|------|-----|-----|---------|---------|------------|------------|
| CPX11 (shared) | 2 vCPU | 4 GB | 80 GB NVMe | 1 TB | $20.49/mo | €5.99/mo |
| CPX21 (shared) | 4 vCPU | 8 GB | 160 GB NVMe | 1 TB | $37.49/mo | €9.99/mo |
| CPX31 (shared) | 8 vCPU | 16 GB | 320 GB NVMe | 1 TB | $73.49/mo | €17.99/mo |
| CCX13 (dedicated) | 2 vCPU | 8 GB | 80 GB NVMe | 1 TB | $50.99/mo | €16.49/mo |

**Note:** Prices increased ~30-40% on June 15, 2026. US datacenters (Ashburn VA,
Hillsboro OR) only offer CPX/CCX — no CX/CAX budget tiers. EU regions (Germany,
Finland) are 3-4x cheaper but add ~80ms latency to NY broker servers. US plans
include only 1 TB traffic (vs 20 TB in EU); overage at $1/TB.

**Pros:** Excellent performance (Geekbench 6 single-core ~1,480, NVMe 58k IOPS).
Ashburn VA is the world's densest internet exchange — great peering. Provisioning
in ~25 seconds. 99.9% SLA. Clean API and Terraform provider.
**Cons:** US pricing is 3-4x EU pricing. Only 1 TB traffic included in US.
No phone support (ticket + email only). Servers bill whether on or off.

### 2.4 Contabo

| Plan | CPU | RAM | Storage | Traffic | Base Price (24-mo) |
|------|-----|-----|---------|---------|-------------------|
| Core VPS 4 | 4 vCPU | 8 GB | 100 GB SSD | Unlimited | €4.40/mo (~$5.28) |
| Core VPS 6 | 6 vCPU | 12 GB | 200 GB SSD | Unlimited | €6.00/mo (~$7.20) |
| Core VPS 8 | 8 vCPU | 24 GB | 300 GB SSD | Unlimited | €11.20/mo (~$13.44) |
| Performance VPS 4 | 4 vCPU AMD EPYC | 8 GB | 150 GB NVMe | Unlimited | €10.80/mo (~$13.00) |

US datacenter locations: **US East (Carlstadt, NJ)**, US Central (St. Louis),
US West (Seattle). Location fees apply on top of base price:

| Region | Location fee |
|--------|-------------|
| EU (Germany) | Free |
| US Central (St. Louis) | $1.80/mo |
| US West (Seattle) | $2.30/mo |
| **US East (New York)** | **$2.80/mo** |

All plans include unlimited traffic. Core VPS uses SSD; Performance VPS uses
NVMe with AMD EPYC CPUs. 99.9% SLA.

**Actual cost for US East (our use case):** $5.28 + $2.80 = **$8.08/mo** for
Core VPS 4 (24-month term).

**Pros:** Cheapest option — 4 vCPU + 8 GB for $8.08/mo in NY. Unlimited traffic.
Carlstadt NJ is ~5ms from NYC, ~15ms from NY broker servers. 99.9% SLA.
**Cons:** Shared vCPUs with lower per-core performance. Email-only support.
Provisioning can take hours on first order. No hourly billing.

### 2.5 Other VPS providers (for reference)

| Provider | 4 vCPU, 8 GB RAM | Notes |
|----------|-------------------|-------|
| DigitalOcean | ~$24-40/mo | Better docs, marketplace |
| Vultr | ~$20-40/mo | Good global coverage |
| AWS Lightsail | ~$20-40/mo | Easy AWS integration |

---

## 2.6 Broker landscape

User accounts by broker (production, as of 2026-09-16):

| Broker | Accounts | Server names | Primary datacenter |
|--------|----------|-------------|-------------------|
| Exness | 31 | MT5Trial9, MT5Trial15, MT5Trial11, MT5Real10, ... | NY (us-east-1) |
| VantageMarkets | 27 | Demo, Live 14, Live 4, Live, Live 6, ... | LD4 (London) + NY |
| PUPrime | 14 | Demo, Live 6, Live | LD4 (London) + HK |
| ICMarkets | 12 | SC-Demo, SC-MT5-3, SC-MT5-4, SC-MT5-2 | NY (us-east-1) + LD4 |
| MetaQuotes | 7 | Demo (MTAPI demo server) | Global |
| Tickmill | 6 | EU-Demo, Demo | LD4 (London) |
| XMGlobal | 5 | Demo 2, MT5 2/4/7/9 | LD4 + NY |
| FTMO | 5 | Demo, Demo2 | LD4 (London) |
| RoboForex | 4 | Pro, ProCent-5 | LD4 + HK |
| 4xHub | 4 | International-Server | LD4 (London) |
| VEOMarkets | 3 | Trade | LD4 (London) |
| FBS | 2 | Demo | LD4 + NY |
| BlackBull | 2 | Demo, Live | LD4 (London) |
| Pepperstone | 1 | UK-Demo | LD4 (London) |
| Other | 53 | (40+ different brokers) | Various |

**Top 4 brokers = 84 accounts (60% of userbase).** All have NY or LD4 servers.
Hetzner NY gives the lowest latency to the majority of broker endpoints.

---

## 3. Cost summary

| Scenario | Monthly cost |
|----------|-------------|
| MTAPI Cloud 500 | $1,500 |
| MTAPI Cloud 100 | $500 |
| Railway (MTAPI + Worker) | ~$130-150 |
| **Contabo Core VPS 4 (US East) + Worker (Railway)** | **~$58** |
| Hetzner CPX21 (US) + Worker (Railway) | ~$87 |
| Contabo Core VPS 4 (US East) only | ~$8 |
| Hetzner CPX21 (US) only | ~$37 |

**Decision:** Contabo Core VPS 4 in US East (Carlstadt, NJ) for the MTAPI bridge.
At $8.08/mo ($5.28 base + $2.80 location fee) with 4 vCPU, 8 GB RAM, and
unlimited traffic, it delivers the MTAPI bridge workload at one-quarter the cost
of Hetzner US. Carlstadt NJ is ~5ms from NYC, ~15ms from NY broker servers.
Worker stays on Railway.

---

## 4. Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Worker        │  HTTPS  │   nginx         │  HTTP   │   MTAPI Docker  │
│   (Railway)     │────────▶│   (Contabo)     │────────▶│   (Contabo)     │
│                 │  :443   │   TLS + auth    │  :5000  │   MT5 terminal  │
└─────────────────┘         └─────────────────┘         └────────┬────────┘
                                                                 │
                                                         MT5 protocol
                                                                 │
                                                        ┌────────▼────────┐
                                                        │   Broker        │
                                                        │   (Exness)      │
                                                        └─────────────────┘
```

### Why nginx?

1. **TLS encryption** — encrypts traffic between Railway and Contabo
2. **Authentication** — shared secret header (`X-MTAPI-Key`) proves identity
3. **Rate limiting** — can throttle abusive requests
4. **Logging** — logs all requests for debugging

MTAPI itself has no API key. Security is network-level (nginx + firewall).

---

## 5. Setup guide

### 5.1 Contabo VPS

1. Sign up at contabo.com
2. Create a Cloud VPS 4 (Ubuntu 22.04) — select **US East (New York)** datacenter
3. Note the IP address and root password

### 5.2 Initial server setup

```bash
# SSH into the server
ssh root@<contabo-ip>

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker

# Install nginx
apt install -y nginx

# Install certbot (for TLS)
apt install -y certbot python3-certbot-nginx
```

### 5.3 Deploy MTAPI Docker

```bash
docker run -d \
  --name mt5rest \
  --restart always \
  -p 5000:80 \
  timurila/mt5rest
```

Verify:
```bash
docker logs mt5rest
curl http://localhost:5000/AccountSummary?id=test-token
```

### 5.4 nginx configuration

Create `/etc/nginx/sites-available/mtapi`:

```nginx
server {
    listen 443 ssl;
    server_name mtapi.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/mtapi.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mtapi.yourdomain.com/privkey.pem;

    # Shared secret auth
    location / {
        if ($http_x_mtapi_key != "YOUR_SECRET_KEY_HERE") {
            return 403;
        }

        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for long-running requests
        proxy_connect_timeout 30s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

Enable and get TLS cert:
```bash
ln -s /etc/nginx/sites-available/mtapi /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# Get TLS certificate
certbot --nginx -d mtapi.yourdomain.com
```

### 5.5 Firewall

```bash
# Allow SSH
ufw allow 22/tcp

# Allow HTTPS (nginx)
ufw allow 443/tcp

# Allow HTTP (certbot renewal — ACME challenge only on :80)
ufw allow 80/tcp

# Enable firewall
ufw enable
```

Port 5000/8080 (MTAPI Docker) must **not** be public — nginx proxies to `127.0.0.1:8080`.
Docker published ports bypass UFW, so bind the container with `-p 127.0.0.1:8080:80`
(`HOST_IP` default in `deploy/mtapi-log-redactor/install.sh`). Do not rely on `ufw deny 8080`.

### 5.6 DNS

Point a subdomain to the Contabo IP:
```
mtapi.yourdomain.com → <contabo-ip>
```

---

## 6. Worker connection

### 6.1 Environment variables (Railway)

```
MTAPI_BASE_URL=https://mtapi.yourdomain.com
MTAPI_KEY=YOUR_SECRET_KEY_HERE
```

### 6.2 Worker code

Every MTAPI request includes the auth header:

```typescript
const response = await fetch(`${MTAPI_BASE_URL}/AccountSummary?id=${token}`, {
  headers: {
    'X-MTAPI-Key': process.env.MTAPI_KEY,
  },
});
```

### 6.3 Request flow

```
1. Worker sends: GET https://mtapi.yourdomain.com/AccountSummary?id=<token>
   Header: X-MTAPI-Key: <secret>

2. nginx receives request
   - Validates X-MTAPI-Key header → 403 if wrong
   - Forwards to http://127.0.0.1:5000/AccountSummary?id=<token>

3. MTAPI Docker receives request
   - Looks up session by token
   - Queries broker via MT5 protocol
   - Returns JSON response

4. nginx returns response to worker
```

---

## 7. Security model

| Layer | What it protects |
|-------|-----------------|
| nginx `X-MTAPI-Key` | Proves request came from our worker (not public internet) |
| TLS (Let's Encrypt) | Encrypts traffic between Railway and Contabo |
| Contabo firewall | Blocks all ports except 22, 80, 443 |
| MTAPI token (`?id=`) | Identifies the broker session (not authentication) |
| Broker credentials | MTAPI stores login/password to connect to Exness |

**MTAPI has no API key.** The `X-MTAPI-Key` is an nginx-level shared secret.
MTAPI never sees this header — nginx strips it before forwarding.

---

## 8. Monitoring

### 8.1 Health check

```bash
# From worker or anywhere with access
curl -H "X-MTAPI-Key: <secret>" https://mtapi.yourdomain.com/CheckConnect?id=<token>
# Expected: OK
```

### 8.2 Docker logs

```bash
ssh root@<contabo-ip>
docker logs -f mt5rest
```

> **Security:** `timurila/mt5rest` can log connection tuples that include the broker password on WRN/ERR paths (see `docs/incidents/incident-2026-09-23-mtapi-docker-password-logs.md`). Install the log redactor before using this container in production, and keep the container bound to localhost only — `ufw deny` does **not** block Docker-published ports:
>
> ```bash
> # from repo root, on the VPS
> bash deploy/mtapi-log-redactor/install.sh
> # defaults to -p 127.0.0.1:8080:80 so only nginx can reach the bridge
> ```
>
> Never paste raw `docker logs` output into tickets or chat. Secrets map: `docs/mtapi-credentials.md`.

### 8.3 nginx logs

```bash
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

### 8.4 Uptime monitoring

Set up a cron job or external monitor to ping:
```
GET https://mtapi.yourdomain.com/CheckConnect?id=<token>
Header: X-MTAPI-Key: <secret>
Expected: 200 OK
```

---

## 9. Backup and recovery

### 9.1 What to back up

- nginx config: `/etc/nginx/sites-available/mtapi`
- TLS certs: `/etc/letsencrypt/live/mtapi.yourdomain.com/`
- Docker container is stateless — no data to back up

### 9.2 Recovery

If the VPS dies:
1. Create new Contabo VPS
2. Run setup script (§5.2)
3. Deploy Docker container (§5.3)
4. Copy nginx config + TLS certs
5. Update DNS if IP changed

The MTAPI bridge is stateless — sessions are stored in-memory and re-created
on connect. The worker handles reconnection via `ConnectByToken`.

---

## 10. Scaling

Current sizing (Cloud VPS 4):
- 4 vCPU, 8 GB RAM
- Handles ~150 concurrent MTAPI sessions (each session = one broker account)
- MTAPI Docker uses ~200-500MB RAM per 100 sessions

If we exceed 150 accounts:
- Upgrade to Cloud VPS 6 ($7.95/mo) for 6 vCPU, 12 GB RAM
- Or Cloud VPS 8 ($15/mo) for 8 vCPU, 24 GB RAM

---

## 11. Rollback

If MTAPI hosting fails:
1. Set all accounts back to `provider = 'fxsocket'` in the database
2. Worker automatically routes to FXSocket (no deploy needed)
3. Shut down Contabo VPS (cancel or stop)
4. FXSocket is a hosted SaaS — it's always available

---

## 12. Follow-ups

1. Buy a domain or subdomain for the MTAPI bridge (~$1/year)
2. Set up the Contabo VPS (§5.2-5.5)
3. Deploy MTAPI Docker and nginx
4. Configure Railway env vars (`MTAPI_BASE_URL`, `MTAPI_KEY`)
5. Test connectivity from worker
6. Set up uptime monitoring
