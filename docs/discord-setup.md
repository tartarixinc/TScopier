# Discord signal sources — setup

The dashboard "Connect Discord" panel is fully implemented. It stays disabled until
the Discord application, the environment variables and the listener service exist.

Pipeline: Discord bot (gateway) → `worker/src/discordListener.ts` → normal signal
parse → `signals` row → trade worker. Discord channels reuse `telegram_channels`
as shadow rows (`source_kind = 'discord'`, `channel_id = dc:<guild>:<channel>`), so
broker links and plan limits work exactly like Telegram.

## 1. Discord application

1. Open <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → add the bot and copy its **token** (this becomes `DISCORD_BOT_TOKEN`).
3. On the same tab enable **Message Content Intent** (Privileged Gateway Intents).
   Without it the bot receives empty message content.
4. **OAuth2 → General → Redirects** — add every origin the dashboard is served from:
   - `https://app.tscopier.ai/channels`
   - `https://preview.unicopier.com/channels`
   - `http://localhost:5173/channels` (local development)
5. Copy the **Application ID** (this becomes `VITE_DISCORD_CLIENT_ID`).

The invite URL is built in `src/lib/discordInvite.ts` with `scope=bot` and
permissions `66560` (View Channel + Read Message History).

## 2. Frontend (Netlify)

Set on the site that serves the dashboard:

```
VITE_DISCORD_CLIENT_ID=<Application ID>
```

Vite bakes this at build time, so **redeploy** after adding it. This alone replaces
"Discord invite is not configured yet." with a working invite button.

## 3. Supabase

```
supabase secrets set DISCORD_BOT_TOKEN=<bot token>
npm run deploy:function discord-sync
```

`discord-sync` lists the guild's text channels with the bot token; without it the
function returns `503 bot_not_configured`. The schema comes from
`supabase/migrations/20261010120000_discord_signal_source.sql`
(`discord_installations`, `discord_guild_channels`, `discord_channels`).

## 4. Worker listener (Railway)

Run the gateway as its own service from the same image:

| Setting | Value |
|---|---|
| Start command | leave **empty** (Dockerfile `CMD` is already `node dist/index.js`) — do **not** set `npm run discord` or bare `dist/index.js` |
| `WORKER_ROLE` | `discord_listener` |
| `DISCORD_BOT_TOKEN` | bot token |
| `SUPABASE_URL` | same project as the app |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key |
| `WORKER_INTERNAL_TOKEN` | same value as the trade worker (dispatch) |
| `TRADE_WORKER_URL` | trade worker base URL (dispatch) |
| `SENTRY_WORKER_HEARTBEAT_MONITOR_SLUG` | a slug of its own, not the listener's |

Rules:

- **One process per bot token.** A second gateway with the same token causes
  duplicate/undefined behaviour. Keep `WORKER_SHARD_COUNT=1` and
  `WORKER_SHARD_ID=0`; the worker refuses to start this role with any other shard
  settings, but it cannot detect extra replicas — set **Replicas = 1**. If
  `WORKER_SHARD_COUNT` is a shared project variable set above 1, override it to 1
  on this service or the guard will refuse to start.
- **Railway healthcheck: disable it for this service.** This role starts no HTTP
  server, so a TCP/HTTP check on `WORKER_PORT` would fail and crash-loop the
  service. Liveness is covered by the gateway watchdog, which exits non-zero if
  the client is not ready for 5 minutes, so `restartPolicyType = ON_FAILURE`
  restarts it.
- Without `WORKER_INTERNAL_TOKEN` / `TRADE_WORKER_URL`, signals still execute, but
  through the trade worker's periodic parsed-signal sweep instead of the
  low-latency push.
- Do **not** reuse `WORKER_ROLE=listener`: that starts a second Telegram MTProto
  client with the same auth key (`AUTH_KEY_DUPLICATED`). An unrecognised
  `WORKER_ROLE` is rejected at startup rather than silently starting every role.
- `WORKER_ROLE=discord_listener` starts only the gateway. Sentry, the process
  crash handlers and the worker heartbeat are inherited from `index.ts`.

The legacy `npm run discord` script (`node -r dotenv/config dist/discordListener.js`) still works for
local runs: same listener code, without the `index.ts` process bootstrap (Sentry,
heartbeat check-ins, graceful shutdown, role and shard guards).

## 5. Verify

1. Sign in to the dashboard → **Connect Discord** → invite the bot to a test server.
2. The bot caches the guild's text channels (`discord_guild_channels`).
3. Select the channels that post signals and link them to a broker account.
4. Post a test signal in one of those channels and confirm the copy on a test account.

## Known gaps

- The OAuth `state` parameter is not used and the returned `code` is never
  exchanged; the browser writes `guild_id` itself, so any signed-in user can claim
  any guild id. Fix before opening Discord to untrusted users.
- There is no "listener offline" message in the UI; a dead gateway looks like
  "make sure the bot can view the channel".
