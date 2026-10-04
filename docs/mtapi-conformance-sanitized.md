# MTAPI Conformance Note (Sanitized)

Date: 2026-09-12 · Environment: hosted `mt5.mtapi.io` · Broker: Exness demo

> **Note:** Credentials, tokens, and account details have been redacted.
> See the original `docs/mtapi-conformance.md` (gitignored) for live values.

## Connection details

| Field | Value |
|-------|-------|
| Server | Exness-MT5Trial9 |
| Login | `<REDACTED>` |
| Host (from Search) | `<REDACTED>:443` |
| Platform | MT5 |
| Account type | Hedging, Demo, USD |
| Leverage | 1:2000 |
| Balance | $5,000 (demo) |

## Confirmed endpoints

### ConnectEx (preferred)

```
GET https://mt5.mtapi.io/ConnectEx?user=<LOGIN>&password=<PASSWORD>&server=<SERVER>
```

Response (HTTP 200, plain text token):
```
<TOKEN>
```

Notes:
- Uses server name (not host/port). Preferred over `Connect`.
- Token is deterministic per account (same account always returns same token).
- Response is plain text, not JSON.

### Connect (fallback)

```
GET https://mt5.mtapi.io/Connect?user=<LOGIN>&password=<PASSWORD>&host=<HOST>&port=443
```

Response: same token as ConnectEx.

### ConnectByToken

```
GET https://mt5.mtapi.io/ConnectByToken?id=<TOKEN>
```

Response (HTTP 200, plain text): same token.

**Critical finding:** Works even after `Disconnect` — the bridge stores connection details internally. Confirms token-based reconnect without password is viable.

### CheckConnect

```
GET https://mt5.mtapi.io/CheckConnect?id=<TOKEN>
```

Response: `OK` (plain text, not JSON).

After disconnect: returns JSON error `INVALID_TOKEN` ("Client with id ... not found"), HTTP 201.

### Disconnect

```
GET https://mt5.mtapi.io/Disconnect?id=<TOKEN>
```

Response: `OK` (plain text).

### ConnectionStatus

```
GET https://mt5.mtapi.io/ConnectionStatus?id=<TOKEN>
```

Response:
```json
{
    "id": "<TOKEN>",
    "isConnected": true,
    "connectTimeUTC": "2026-09-12T03:25:41.8315376Z",
    "lastQuoteTimeUTC": "0001-01-01T00:00:00",
    "clientIp": null
}
```

### AccountSummary

```
GET https://mt5.mtapi.io/AccountSummary?id=<TOKEN>
```

Response:
```json
{
    "balance": 5000,
    "credit": 0,
    "profit": 0,
    "equity": 5000,
    "margin": 0,
    "freeMargin": 5000,
    "marginLevel": 0,
    "leverage": 2000,
    "currency": "USD",
    "method": "Hedging",
    "type": "demo",
    "isInvestor": false,
    "synced": true
}
```

Notes:
- `synced: true` confirmed present. Must check before trusting balance/equity.
- `method` = "Hedging" (not "Netting") — important for position management.
- `isInvestor` = false — this is a full-access account.
- `marginLevel` = 0 when no open positions (not null, not undefined).

### GetQuote

```
GET https://mt5.mtapi.io/GetQuote?id=<TOKEN>&symbol=EURUSDm
```

Response:
```json
{
    "symbol": "EURUSDm",
    "bid": 1.16145,
    "ask": 1.16153,
    "time": "2026-09-11T01:01:13.176",
    "last": 0,
    "volume": 0
}
```

Notes:
- `time` is ISO 8601 string (not epoch).
- `last` and `volume` are 0 for forex pairs.
- Exness uses `m` suffix on symbols (e.g. `EURUSDm` not `EURUSD`).

### Symbols

```
GET https://mt5.mtapi.io/Symbols?id=<TOKEN>
```

Response: object keyed by symbol name. Key IS the symbol name (e.g. `"EURUSDm"`).

### SymbolParams

```
GET https://mt5.mtapi.io/SymbolParams?id=<TOKEN>&symbol=EURUSDm
```

Response:
```json
{
    "symbol": "EURUSDm",
    "symbolInfo": { "digits": 5, "points": 1e-05, "contractSize": 100000 },
    "symbolGroup": {
        "minLots": 0.01, "maxLots": 200, "lotsStep": 0.01,
        "tradeMode": "FullAccess", "tradeType": "Market",
        "fillPolicy": "FOK, IOC", "expiration": "ALL",
        "swapLong": -5.7, "swapShort": 0
    }
}
```

### OpenedOrders

```
GET https://mt5.mtapi.io/OpenedOrders?id=<TOKEN>
```

Response: `[]` (empty array when no open orders).

### OrderHistory

```
GET https://mt5.mtapi.io/OrderHistory?id=<TOKEN>&from=2026-01-01T00:00:00&to=2026-09-12T00:00:00
```

Response:
```json
{
    "partialResponse": false,
    "orders": [
        {
            "ticket": <TICKET>,
            "orderType": "Balance",
            "dealType": "Balance",
            "symbol": "",
            "lots": 0,
            "profit": 5000,
            "state": "Filled",
            "openTime": "2026-08-05T23:24:14.657",
            "closeTime": "2026-08-05T23:24:14.657",
            "comment": "D-trial-USD-..."
        }
    ],
    "internalDeals": [...],
    "internalOrders": [],
    "action": 1
}
```

Notes:
- `partialResponse` = false means all data returned (no pagination needed).
- Balance operations appear in history (initial deposit).

### ClosedOrders

```
GET https://mt5.mtapi.io/ClosedOrders?id=<TOKEN>
```

Response: `[]` (empty when no closed trades).

### OrderSend / OrderSendSafe

```
GET https://mt5.mtapi.io/OrderSend?id=<TOKEN>&symbol=EURUSDm&operation=Buy&volume=0.01
GET https://mt5.mtapi.io/OrderSendSafe?id=<TOKEN>&symbol=EURUSDm&operation=BuyLimit&volume=0.01&price=1.15000
```

**Confirmed: OrderSendSafe works.** Placed a Buy order successfully:
```json
{
    "ticket": <TICKET>,
    "openPrice": 1.15480,
    "lots": 0.01,
    "state": "Filled",
    "contractSize": 100000,
    "symbol": "EURUSDm",
    "stopLoss": 0,
    "takeProfit": 0
}
```

**Key findings:**
- Response includes full order details (ticket, openPrice, lots, state, contractSize)
- `state: "Filled"` for market orders, `"Placed"` for pending orders
- `contractSize: 100000` (standard lot) — important for volume calculations
- `expertId` field present (timestamp-based)
- `requestId` field present (sequential counter)

**Pending orders:**
- `BuyLimit` with valid price: placed successfully (state=Placed)
- `SellStop` with price too far from market: `INVALID_PRICE` error
- `SellStop` with valid price: placed successfully

### OrderModifySafe

```
GET https://mt5.mtapi.io/OrderModifySafe?id=<TOKEN>&ticket=<TICKET>&stoploss=1.15000&takeprofit=1.16000
```

**Confirmed: OrderModifySafe works.** Modified SL+TP successfully:
- Response includes full order details with updated `stopLoss` and `takeProfit`
- Returns `"partialFillDeals"` array showing modification history

**Critical finding:** `OrderModifySafe` with only SL (no TP) **succeeds** — it clears TP to 0. Similarly, `OrderModifySafe` with only TP (no SL) **succeeds** — it clears SL to 0. The bridge allows modifying one field at a time. **SL+TP are NOT required together** — this contradicts the migration plan's assumption.

### OrderCloseSafe

```
GET https://mt5.mtapi.io/OrderCloseSafe?id=<TOKEN>&ticket=<TICKET>
```

**Confirmed: OrderCloseSafe works.** Closed a market position successfully:
```json
{
    "ticket": <TICKET>,
    "closeVolume": 1000000,
    "closePrice": 1.1544,
    "closeTime": "2026-09-14T07:54:39.092",
    "closeLots": 0.01,
    "state": "Started",
    "profit": -0.4
}
```

**Also confirmed:** Pending orders can be cancelled with `OrderCloseSafe`:
- Response: `"state": "Cancelled"`

**Key findings:**
- `closeVolume` in contract units (not lots) — `1000000` = 0.01 lots × 100000 contractSize
- `closePrice` is the actual fill price
- `profit` shows realized P/L
- For pending orders: `state` becomes `"Cancelled"`

### OpenedOrders / ClosedOrders / OrderHistory

**Confirmed:** All three endpoints return complete data:
- `OpenedOrders`: returns `[]` when empty, or array of open orders/positions
- `ClosedOrders`: returns closed trades with `dealInternalIn` and `dealInternalOut`
- `OrderHistory`: includes `partialResponse` flag, `orders`, `internalDeals`, `internalOrders`, `action` fields

**Important:** `ClosedOrders` does NOT include pending orders that were cancelled — only market orders that were closed.

### Search

```
GET https://mt5.mtapi.io/Search?company=Exness
```

Response: array of broker groups, each with `companyName` and `results` containing server names and access points (IP:port).

### ConnectionStatusAll

Requires admin key — not available on trial/cloud.

## Error codes observed

| Code | Meaning | HTTP |
|------|---------|------|
| `INVALID_ACCOUNT` | Wrong login/password/server | 201 |
| `INVALID_TOKEN` | Session not found (after disconnect) | 201 |
| `MARKET_CLOSED` | Trading when market is closed (weekend) | 201 |
| `INVALID_TICKET` | Order/position ticket not found | 201 |
| `INVALID_SYMBOL` | Symbol name wrong (e.g. EURUSD vs EURUSDm) | 201 |
| `INVALID_PRICE` | Pending order price too far from market | 201 |
| `INVALID_REQUEST` | Invalid operation number (e.g. 8) | 201 |
| `TIMEOUT` | Trade timeout (operations 100-101) | 201 |

## Key findings

1. **Token-based reconnect works.** `ConnectByToken` reconnects without password, even after explicit `Disconnect`. This is the primary reconnect path.
2. **Token is deterministic.** Same account always returns the same UUID token.
3. **Response formats vary.** `ConnectEx`/`Connect`/`ConnectByToken` return plain text. `CheckConnect`/`Disconnect` return plain text. Everything else returns JSON.
4. **Exness uses `m` suffix.** Symbol names are `EURUSDm`, `GBPUSDm`, etc. Must use the broker's actual symbol names.
5. **`AccountSummary.synced` confirmed.** Boolean field present in response.
6. **`AccountSummary.method` = "Hedging".** Multiple positions per symbol allowed.
7. **Operation enum accepts both string and integer.** `"Buy"` and `0` both work.
8. **Market closed on weekends.** Cannot test order lifecycle on Saturday/Sunday.
9. **`Search` endpoint works.** Finds broker servers by company name.
10. **`ConnectionStatusAll` requires admin key.** Not available on trial.

## Plan deviations (corrected by conformance)

| Plan assumption (§7) | Conformance finding | Impact |
|----------------------|---------------------|--------|
| `OrderModify` requires both SL+TP | SL-only and TP-only both succeed; clears the other field to 0 | Phase 3 can modify one field at a time; no need to send unchanged value |
| `MaxSessions` default 0 = unlimited | MaxSessions = 1 per account (deterministic token) | Hosted trial is single-session; self-hosted needs `MaxSessions >= 150` |
| WebSocket endpoints unclear | Only `OnQuote` and `OnOrderUpdate` work; others return 404 | Phase 2.5 streaming limited to these two endpoints |

## Extended testing (market closed)

### Rate limiting
- 50 rapid sequential requests: all HTTP 200, no rate limiting observed.
- 10 rapid requests: average 750ms per request.
- No `429` or rate limit errors encountered.

### Concurrent requests

**Tested combinations (all passed):**
- `AccountSummary` x3 parallel: OK
- `AccountSummary` + `GetQuote` parallel: OK (100% success on 5 retries)
- `GetQuote` x10 parallel (same symbol): OK
- `GetQuote` x5 parallel (different symbols): OK
- `GetQuote` x3 parallel (different symbols): OK
- `OrderHistory` x2 parallel: OK
- `GetQuote` + `OrderHistory` parallel: OK
- `Symbols` + `SymbolParams` parallel: OK
- `ConnectionStatus` + `AccountSummary` parallel: OK
- `Search` + `GetQuote` parallel: OK
- 5 `AccountSummary` + 5 `GetQuote` mixed: OK
- 3 different endpoint types parallel: OK

**Initial error was transient:**
- First test of `AccountSummary` + `GetQuote` returned `CONNECT_ERROR` (socket disposed).
- Subsequent tests (100% success rate) suggest this was a transient issue, not a systemic concurrency problem.
- Likely caused by connection state instability during early testing.

**Connection transition behavior:**
- `INVALID_TOKEN` errors occur when requests are in-flight during `Disconnect`.
- `ConnectByToken` during in-flight requests succeeds (token preserved).
- **Recommendation:** Catch `INVALID_TOKEN`, reconnect, and retry.

### Connection status reliability
- `ConnectionStatus.isConnected` returns `false` during market closure, even though data endpoints work.
- `AccountSummary.synced` changes between `true` and `false` during off-hours.
- `CheckConnect` returns `SERVICE_NOT_AVAILABLE` when market is closed.
- **Critical:** Do not rely on `isConnected` or `synced` for connection health checks during off-hours.

### Token lifecycle
- Token is deterministic: same account always returns same UUID.
- `ConnectByToken` works after `Disconnect` (reconnects without password).
- `ConnectEx` always returns same token for same account.
- **Token expires** after ~5 minutes of inactivity. Returns `INVALID_TOKEN`. Must reconnect via `ConnectEx` or `ConnectByToken`.

### MaxSessions
- Token is deterministic per account — same account always returns same UUID.
- **Effective MaxSessions = 1 per account.** Cannot create multiple concurrent sessions with same credentials.
- Multiple `ConnectEx` calls return same token, not additional sessions.

### Bridge restart session survival
- **Confirmed:** Orders and positions survive `Disconnect` + `ConnectByToken` reconnect.
- Tested with 5s and 10s disconnect intervals — both survived.
- Pending orders, market positions, and SL/TP modifications all persist across restart.
- **Recommendation:** Use `ConnectByToken` for reconnection after bridge restart.

### Operation enum values

**Tested values:**

| Value | Result | Notes |
|-------|--------|-------|
| 0-7 | MARKET_CLOSED | Valid operations (market closed) |
| 8 | INVALID_REQUEST | Not a valid operation |
| 9-15 | MARKET_CLOSED | Valid operations (market closed) |
| 16-99 | MARKET_CLOSED | Accepts any integer |
| 100-101 | TIMEOUT | Special operations (trade timeout) |
| 102+ | MARKET_CLOSED | Accepts any integer |

**String operations:** `Buy`, `Sell`, `BuyLimit`, `SellLimit`, `BuyStop`, `SellStop` all work.

**Key finding:** Bridge accepts almost any integer as operation and passes it to MT5 terminal. Only operations 8 and 100-101 give different errors. The terminal validates the actual operation.

### Error handling
| Error code | Trigger | HTTP |
|------------|---------|------|
| `SERVICE_NOT_AVAILABLE` | Invalid user ID or market closed | 201 |
| `INVALID_ACCOUNT` | Wrong password | 201 |
| `INVALID_TOKEN` | Session not found | 201 |
| `NULL_ARGUMENT` | Missing `id` parameter | 201 |
| `MARKET_CLOSED` | Trading when market closed | 201 |
| `INVALID_TICKET` | Order/position not found | 201 |
| `INVALID_SYMBOL` | Wrong symbol name | 201 |

### Invalid server error
```
Server 'FakeServer' not found: neither /Search nor /SearchMQ has it.
Use the exact server name shown in the MT5 terminal.
```
- Validates server name against broker's server list.
- Returns `DONE` code with descriptive message.

### Non-existent endpoints
`OpenOrders`, `Positions`, `PendingOrders`, `Deals`, `ClosedDeals`, `OrderBook`, `TimeServer` all return HTTP 404.
Correct names: `OpenedOrders`, `ClosedOrders`, `OrderHistory`.

## Still untested

_(none — all items tested)_

## Price boundary rules (confirmed)

| Order type | Direction | Valid price | Invalid price | Rule |
|------------|-----------|-------------|---------------|------|
| BuyLimit | Buy below market | ≤ bid | > bid | Price must be at or below bid |
| SellStop | Sell below market | ≤ bid | > bid | Same as BuyLimit |
| SellLimit | Sell above market | ≥ bid | < bid | Price must be at or above bid |
| BuyStop | Buy above market | ≥ ask | < ask | Price must be at or above ask |

**Key finding:** Boundary is based on **bid** for BuyLimit/SellStop/SellLimit, and **ask** for BuyStop. The spread (bid-ask gap) matters — BuyStop prices between bid and ask will fail.
