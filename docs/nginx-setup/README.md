# MTAPI Nginx Setup — Contabo VPS

Reverse proxy for the MTAPI MetaTrader bridge on the Contabo VPS.
Handles TLS termination, API key authentication, IP whitelisting, and rate limiting.

## Prerequisites

- Contabo VPS (Cloud VPS 4, Ubuntu 22.04)
- DNS A record: `mtapi.tscopier.ai` → VPS IP (Cloudflare, grey cloud / DNS only)
- SSH access as root

## Files

| File | Purpose |
|------|---------|
| `nginx.conf` | Main nginx config (worker processes, logging, SSL defaults, rate limit zones) |
| `mtapi-tscopier.conf` | Server block (reverse proxy, auth, security headers) |
| `setup.sh` | Automated setup (installs nginx + certbot + firewall, generates API key, obtains SSL cert) |
| `secrets.env.example` | Template for tracking secrets |

## Deploy (WSL → VPS via SCP)

### Step 1: Copy files to VPS

From WSL, in this directory:

```bash
# Set your VPS IP
VPS_IP="YOUR_CONTABO_IP"

# Copy all setup files to /tmp on the VPS
scp nginx.conf mtapi-tscopier.conf setup.sh root@${VPS_IP}:/tmp/nginx-setup/
```

### Step 2: SSH into VPS and run setup

```bash
ssh root@${VPS_IP}

# Create the target directory and run setup
mkdir -p /tmp/nginx-setup
cd /tmp/nginx-setup
sudo bash setup.sh
```

The script will:
1. Update system packages
2. Install nginx + certbot + fail2ban
3. Generate a 64-character API key (saved to `/root/.mtapi_api_key`)
4. Configure nginx with the API key
5. Set up UFW firewall (SSH + port 9443 only)
6. Obtain a Let's Encrypt SSL certificate
7. Set up auto-renewal cron

### Step 3: Verify

```bash
# Health check (no auth needed)
curl -k https://mtapi.tscopier.ai:9443/health

# Authenticated request
curl -k -H "Authorization: Bearer $(cat /root/.mtapi_api_key)" https://mtapi.tscopier.ai:9443/
```

### Step 4: Update Railway env vars

Add these to your Railway service:

```
MTAPI_URL=https://mtapi.tscopier.ai:9443
MTAPI_API_KEY=<the key from /root/.mtapi_api_key>
```

## Security Layers

| Layer | What | How |
|-------|------|-----|
| TLS | Encrypts traffic | Let's Encrypt, auto-renewed |
| IP whitelist | Only Railway IPs can connect | nginx `geo` block |
| API key | Proves caller is authorized | `Authorization: Bearer <key>` header |
| Rate limit | Blocks brute-force | 10 req/s per IP, burst of 50 |
| Non-standard port | Avoids automated scanners | `:9443` instead of `:443` |
| fail2ban | Bans repeated offenders | Bans IP after 5 failed attempts |
| UFW | Firewall | Only SSH + 9443 open |

## Updating Railway IP Whitelist

Railway's egress IPs may change. Check current ranges at:
https://docs.railway.com/reference/public-networking

Update the `geo $allowed_ip` block in `/etc/nginx/conf.d/mtapi-tscopier.conf`:

```bash
# Edit the config
nano /etc/nginx/conf.d/mtapi-tscopier.conf

# Test and reload
nginx -t && systemctl reload nginx
```

## Renewing SSL Certificates

Auto-renewal is set up via cron. To manually renew:

```bash
certbot renew --deploy-hook "systemctl reload nginx"
```

## Troubleshooting

```bash
# Check nginx status
systemctl status nginx

# Check nginx error log
tail -50 /var/log/nginx/error.log

# Test nginx config
nginx -t

# Check fail2ban
fail2ban-client status

# Check UFW
ufw status

# Reload nginx after config changes
nginx -t && systemctl reload nginx
```
