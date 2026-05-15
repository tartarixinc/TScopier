# MT4/MT5 REST API endpoint map (mt4api.dev)

Hosts (Basic Auth on every request):

- MT5: `https://mt5.mt4api.dev`
- MT4: `https://mt4.mt4api.dev`

Session `id` is a client-supplied UUID v4 (ConnectEx) or server-returned token; stored in `broker_accounts.metaapi_account_id`.

| TSCopier usage | HTTP | MT5 path | MT4 path | Notes |
|----------------|------|----------|----------|--------|
| Connect (new) | GET | `/ConnectEx` | `/ConnectEx` | Query: `user`, `password`, `server`, `id` (our UUID) |
| Reconnect | GET | `/ConnectByToken` | `/ConnectByToken` | Query: `id` only |
| Disconnect | GET | `/Disconnect` | `/Disconnect` | Replaces legacy `/DeleteAccount` |
| Health | GET | `/CheckConnect` | `/CheckConnect` | |
| Balance | GET | `/AccountSummary` | `/AccountSummary` | |
| Open orders | GET | `/OpenedOrders` | `/OpenedOrders` | |
| Closed orders | GET | `/ClosedOrders` | `/ClosedOrders` | |
| Quote | GET | `/GetQuote` | `/Quote` | |
| Symbol params | GET | `/SymbolParams` | `/SymbolParams` | |
| Symbols list | GET | `/Symbols` | `/Symbols` | |
| Order send | GET | `/OrderSendSafe` | `/OrderSend` | Same query params |
| Order modify | GET | `/OrderModifySafe` | `/OrderModify` | |
| Order close | GET | `/OrderCloseSafe` | `/OrderClose` | |

Swagger: `https://mt5.mt4api.dev/swagger/v1/swagger.json`, `https://mt4.mt4api.dev/swagger/v1/swagger.json` (Basic Auth).

Environment variables:

- **Recommended:** `MT4API_BASIC_USER` and `MT4API_BASIC_PASSWORD` — plain text from support (not base64). TSCopier sends `Authorization: Basic base64(user:password)` per [RFC 7617](https://datatracker.ietf.org/doc/html/rfc7617).
- **Optional:** `MT4API_BASIC_TOKEN` — if you already have only the base64 blob (without `Basic ` prefix).
- **Optional:** `MT4API_AUTHORIZATION` — full header value (`Basic …`).
- `MT4API_MT5_BASE_URL`, `MT4API_MT4_BASE_URL` — defaults to `https://mt5.mt4api.dev` and `https://mt4.mt4api.dev`.
