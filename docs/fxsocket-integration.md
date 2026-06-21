# FxSocket integration

TScopier uses [FxSocket](https://fxsocket.com/docs) for all MT5 broker connectivity. Legacy mt4api.dev (ConnectEx sessions, keepalive, reconnect) has been removed.

## Architecture

| Layer | Responsibility |
|-------|----------------|
| **FxSocket Cloud** | Hosts MT5 terminals; REST + WebSocket per account |
| **Railway worker** | Telegram listener, trade execution (FxSocket REST), WS proxy for browser |
| **Supabase Edge** | `fxsocket-broker` — connect, history, stream ticket (JWT auth) |
| **Browser** | Edge REST for connect/history bootstrap; worker WS for live account/positions |

## Environment

### Worker (Railway)

```env
FXSOCKET_API_KEY=fxs_live_...
FXSOCKET_BASE_URL=https://api.fxsocket.com   # optional
FXSOCKET_HTTP_CONNECTIONS=128                 # optional
WORKER_PUBLIC_URL=https://your-worker.up.railway.app  # for stream_ticket URLs
```

### Supabase Edge secrets

```env
FXSOCKET_API_KEY=fxs_live_...
WORKER_PUBLIC_URL=https://your-worker.up.railway.app
```

### Frontend (Vite)

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_WORKER_URL=https://your-worker.up.railway.app
```

## API surface

**Edge function:** `POST /functions/v1/fxsocket-broker`

| action | Description |
|--------|-------------|
| `connect` | Link MT4/MT5 via `POST /v1/accounts` (login/password/server/platform) |
| `search_brokers` | MT4/MT5 company/server lookup via [BSA `/searchMt4`](https://bsa.fxsocket.com/docs#/default/search_mt4_searchMt4_get) or [`/searchMt5`](https://bsa.fxsocket.com/docs#/default/search_mt5_searchMt5_get) (`company` ≥4 chars, `platform` MT4 or MT5) |
| `delete` | Unlink account |
| `list` | User's `broker_accounts` with FxSocket IDs |
| `refresh_summary` | Live balance/equity |
| `trades` / `order_history` | Closed deals + open positions |
| `opened_orders`, `quote`, `symbols`, `symbol_info` | Market data |
| `stream_ticket` | Returns worker WS URL (browser adds JWT) |

**Per-account REST:** `https://api.fxsocket.com/mt4/{account_id}/…` or `…/mt5/{account_id}/…` depending on platform ([MT4 docs](https://fxsocket.com/docs/mt4), [MT5 docs](https://fxsocket.com/docs/mt5)).

**Worker WebSocket:** `wss://{WORKER}/broker/stream?broker_account_id={uuid}&token={jwt}`

Topics: `account`, `positions`, `prices`, `trades`, `terminal` (subscribe via JSON frames).

## MT4 / MT5

Both platforms are supported. Link via `POST /v1/accounts` with `platform: mt4` or `mt5`; all terminal REST/WebSocket calls must use the matching `/mt4/{id}` or `/mt5/{id}` base path.

## Migration from legacy

1. Apply migrations through `20260616120000_fxsocket_unify_broker_accounts.sql`
2. Deploy worker + edge with `FXSOCKET_API_KEY`
3. Users with legacy `metaapi_account_id` reconnect via Account Config (credentials → new `fxsocket_account_id`)
