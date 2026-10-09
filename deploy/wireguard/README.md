# WireGuard private tunnel for MTAPI (option C)

Private path between the Railway worker and the Contabo VPS, so the worker
does not depend on rotating public egress IPs. Complements option D
(`X-Internal-Token` header), which replaces the IP allowlist on the public
HTTPS path.

## Design

| Piece | Value |
|-------|-------|
| VPS interface | `wg0` = `10.66.0.1/24`, listens `51820/udp` |
| Worker peer | `10.66.0.2/32` (one peer = Railway trade worker) |
| Tunnel nginx | `listen 10.66.0.1:9443` plain HTTP (WireGuard encrypts); checks `X-Internal-Token` + Bearer API key |
| Public nginx | `listen 9443 ssl` unchanged — edge + any client still use HTTPS + token + API key |
| Worker after cutover | `MTAPI_BASE_URL=http://10.66.0.1:9443` |

`/health` stays open on both listeners. The tunnel block is a **separate file**
so it can be installed and rolled back independently of the public HTTPS config.
With the production wildcard `listen 9443` (no IP), nginx still starts and
serves public HTTPS when `wg0` is down — traffic to `10.66.0.1:9443` only
reaches this block once `wg0` exists. Install this file only while `wg0` is up.

## Files

| File | Purpose |
|------|---------|
| `vps-setup.sh` | VPS: install WireGuard, generate keys, write `wg0.conf`, open UDP 51820, print peer conf |
| `peer-worker.conf.example` | Worker peer template (placeholders) |
| `mtapi-tscopier-tunnel.conf` | nginx server block for `10.66.0.1:9443` |

## Deploy order

1. **Option D first** (already in this change): edge + worker send `X-Internal-Token`;
   set secrets; enable nginx token check; disable IP allowlist. Public path works.
2. On VPS: `sudo bash vps-setup.sh` — brings up `wg0`, writes peer conf (path printed; private key not echoed).
3. Copy peer conf to the Railway worker host (kernel `wg` or userspace `wireguard-go`),
   replace placeholders, `wg-quick up wg0`.
4. Copy `mtapi-tscopier-tunnel.conf` → `/etc/nginx/conf.d/` **while wg0 is up**,
   then `nginx -t && systemctl reload nginx`.
5. **Verify from the peer first:** `curl http://10.66.0.1:9443/health` and a Bearer call.
   With the production wildcard `listen 9443` present, nginx still starts if
   wg0 later goes down (public HTTPS keeps serving; the tunnel IP is simply
   unbound). If you ever change the public listen to a fixed IP, a missing
   `10.66.0.1` will fail `nginx -t` for the whole process — keep wg0 up or
   move this file out of `conf.d` first. Optional boot ordering:
   `/etc/systemd/system/nginx.service.d/override.conf` with
   `[Unit]` / `After=wg-quick@wg0.service` / `Wants=wg-quick@wg0.service`,
   then `systemctl daemon-reload`.
6. Only after step 5 works: on Railway set `MTAPI_BASE_URL=http://10.66.0.1:9443`
   (keep API key + internal token).

## Railway limitation

Railway containers often **lack the kernel WireGuard module**. If `wg-quick`
fails with `Operation not supported` / `Cannot find device wg0`:

- Use userspace **wireguard-go** (or a sidecar with NET_ADMIN), or
- Stay on the public HTTPS path (option D alone) until a private path is verified.

The edge function has **no** WireGuard path yet — it keeps public HTTPS with
token + API key until a private route exists for Supabase egress too.

## Rollback

- Tunnel down: delete/rename `/etc/nginx/conf.d/mtapi-tscopier-tunnel.conf`,
  reload nginx, set `MTAPI_BASE_URL` back to `https://mtapi.tscopier.ai:9443`.
- WireGuard down: `wg-quick down wg0` (or disable `wg-quick@wg0`).

## Security notes

- Peer uses a preshared key (`wg genpsk`) in addition to keypair auth.
- Tunnel is plain HTTP **inside** WG only — never expose `10.66.0.1:9443` publicly.
- UFW: allow `51820/udp` only; do not open `10.66.0.0/24` to the world.
- API key + internal token still required on the tunnel (same maps as public).
