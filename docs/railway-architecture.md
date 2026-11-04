# Railway Architecture — TScopier

## Overview

All services run from the **same Docker image** (`worker/Dockerfile`). The `WORKER_ROLE` env var determines what each instance does.

## Current production services

```
Railway Project: TScopier
├── Listener     (WORKER_ROLE=listener)
├── Worker       (WORKER_ROLE=trade)
├── Backtest     (WORKER_ROLE=backtest)
└── Discord      (WORKER_ROLE=discord_listener, 1 replica, no healthcheck)  ← planned, see docs/discord-setup.md
```

### 1. Listener

**Purpose:** The Telegram connection layer. Connects to Telegram via MTProto (GramJS), listens for signals in configured channels, parses them, and dispatches trade instructions to the Worker.

**What it does:**
- Maintains a persistent Telegram session (one user = one MTProto connection)
- Listens for new messages in configured channels/groups
- Parses signal text into structured trade data (inline parse, no external API call)
- Dispatches signals to the Worker via HTTP (`POST /internal/dispatch-signal`)
- Updates `telegram_sessions.last_event_at` to prove it's alive
- Leases sessions to prevent duplicate listeners

**Key constraint — ONE replica only:**
Telegram allows exactly one MTProto connection per auth key. Running two Listener instances with the same session causes `AUTH_KEY_DUPLICATED` — missed signals, missed trades. Never scale this service horizontally.

**Does NOT:**
- Connect to MT4/MT5 brokers
- Execute trades
- Run backtests

**Env highlights:**
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` — from my.telegram.org
- `TRADE_WORKER_URL` — where to send parsed signals (→ Worker)
- `WORKER_SHARD_ID` / `WORKER_SHARD_COUNT` — user partitioning
- `LISTENER_INLINE_PARSE=true` — parse signals locally (fast path)

---

### 2. Worker (combined trade)

**Purpose:** The execution engine. Receives parsed signals from the Listener and executes them on MT4/MT5 via FxSocket API.

**What it does:**
- Receives signals via HTTP from the Listener (or sweeps unprocessed signals)
- Connects to FxSocket API to send trades to users' MT4/MT5 accounts
- Manages open trades: breakeven, trailing stop, partial close, adjust SL/TP
- Runs monitors: virtual pending legs, broker heartbeat, basket reconciliation
- Handles all execution: buy, sell, close, modify, range trades, layering

**Execution engine v2:**
Uses `EXECUTION_ENGINE=v2` with `FXSOCKET_API_KEY` for broker communication. Keeps broker sessions warm via heartbeat (every 10-15s) to minimize latency.

**Can be split into 2 for scale (at 10k+ users):**
| Sub-role | Responsibility |
|----------|---------------|
| `trade_entry` | Buy/sell execution (latency-critical) |
| `trade_mgmt` | Close/modify/breakeven/trailing (less time-sensitive) |

**Does NOT:**
- Connect to Telegram
- Open MTProto connections
- Run backtests

---

### 3. Backtest

**Purpose:** Runs historical backtests of copier strategies.

**What it does:**
- Creates an ephemeral Telegram client per backtest run (never shares Listener's connection)
- Downloads historical channel messages
- Simulates trade execution against historical data
- Returns results to the frontend via Supabase

**Key difference from Listener:**
The Telegram client is temporary — it connects, downloads what it needs, and disconnects. No persistent session, no risk of `AUTH_KEY_DUPLICATED`.

**Env highlights:**
- No `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` needed (uses the same Supabase-stored credentials)
- No `FXSOCKET_API_KEY` needed (no live broker calls)
- `WORKER_URL` must be set in Supabase Edge secrets (Edge functions call this service)

---

## Data flow

```
Telegram ─→ Listener ─→ Worker ─→ FxSocket ─→ MT4/MT5
                │
                └→ Supabase (persist signal, update lease)
```

1. Telegram signal arrives → Listener's MTProto connection
2. Listener parses signal in-process (inline)
3. Listener pushes to Worker via `POST /internal/dispatch-signal` with shared `WORKER_INTERNAL_TOKEN`
4. Worker calls FxSocket API → `OrderSend` on user's MT4/MT5
5. Worker writes results to Supabase (`trades`, `trade_execution_logs`)

Backtest is a separate data flow: frontend → Edge function → Backtest worker → Telegram (ephemeral) → simulate → return results.

## For staging

Staging needs the same 3 services but connected to staging Supabase (separate project, separate data). The Worker must never point at production broker accounts.

**Simplified staging:**
- `Listener` + `Worker` (both `WORKER_ROLE=all`? No — use `WORKER_ROLE=listener` and `WORKER_ROLE=trade` to match prod)
- Or run a monolith (`WORKER_ROLE=all`) for simplicity
- `Backtest` — only needed if testing backtest features

The CEO needs to:
1. Create a **new Railway project** (e.g. `TScopier-staging`)
2. Add 2-3 services from the same `worker/` Docker image
3. Set the staging-specific env vars pointing at staging Supabase
