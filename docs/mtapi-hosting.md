# MTAPI Hosting Guide

Date: 2026-09-14 · Status: **Decision made** · Owner: TBD

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

### 2.3 Contabo (chosen)

| Plan | CPU | RAM | Storage | Price |
|------|-----|-----|---------|-------|
| Cloud VPS 4 | 4 vCPU | 8 GB | 75 GB NVMe | $6.60/mo |
| Cloud VPS 6 | 6 vCPU | 12 GB | 100 GB NVMe | $7.95/mo |
| Cloud VPS 8 | 8 vCPU | 24 GB | 200 GB NVMe | $15.00/mo |

All plans include 32 TB traffic, unlimited incoming. 12-month term pricing shown.

**Pros:** Fixed monthly cost. Way cheaper ($7 vs $85-100). More resources.
**Cons:** Need to manage server ourselves (SSH, Docker, updates). Mixed support
reviews. No auto-scaling.

### 2.4 Other VPS providers (for reference)

| Provider | 4 vCPU, 8 GB RAM | Notes |
|----------|-------------------|-------|
| Hetzner | ~$15-20/mo | Better support, dedicated vCPU options |
| DigitalOcean | ~$24-40/mo | Better docs, marketplace |
| Vultr | ~$20-40/mo | Good global coverage |
| AWS Lightsail | ~$20-40/mo | Easy AWS integration |

---

## 3. Cost summary

| Scenario | Monthly cost |
|----------|-------------|
| MTAPI Cloud 500 | $1,500 |
| MTAPI Cloud 100 | $500 |
| Railway (MTAPI + Worker) | ~$130-150 |
| **Contabo + Worker (Railway)** | **~$57** |
| Contabo only | ~$7 |

**Decision:** Contabo for the MTAPI bridge. Worker stays on Railway.

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
2. Create a Cloud VPS 4 (Ubuntu 22.04)
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

# Allow HTTP (certbot renewal)
ufw allow 80/tcp

# Enable firewall
ufw enable
```

Port 5000 (MTAPI Docker) is NOT exposed publicly — nginx proxies to it locally.

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
