# TSCopier Admn Panel — Full Specification

> Copy this file into a new project and use it as the complete build reference.
> This admin panel connects to the same Supabase instance using the service_role key (bypasses RLS).
> Strictly read-only — no mutations.

---

## Techi Stack (must match main app)

- **Vite** 8.x + React 19 + TypeScript 6
- **Tailwind CSS** 3.4 (class-based dark mode, Inter font)
- **Recharts** 3.8 for charts
- **Lucide React** for icons
- **clsx** for conditional classes
- **React Router DOM** 7.x
- **@supabase/supabase-js** 2.x

### Tailwind Theme (copy from main app)

```js
// tailwind.config.js
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        primary: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
        success: { 50: '#f0fdf4', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
        warning: { 50: '#fffbeb', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
        error: { 50: '#fef2f2', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
        neutral: { 50: '#fafafa', 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717', 950: '#0a0a0a' },
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        'card-lg': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
      },
    },
  },
}
```

---

## Environment Variables

```
VITE_SUPABASE_URL=https://<project-id>.supabase.co
VITE_SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
VITE_ADMIN_PASSWORD=<simple-password-gate>
```

---

## Supabase Client (service_role, bypasses RLS)

```ts
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const key = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''

export const supabase = createClient(url, key)
```

---

## Authentication Gate

Simple password check stored in sessionStorage. No Supabase auth needed.

```ts
// Check VITE_ADMIN_PASSWORD against user input
// Store flag in sessionStorage('admin_authed')
// Wrap all routes in <AdminGuard>
```

---

## Navigation Structure

Sidebar with these sections:

1. **Overview** — `/` (home dashboard)
2. **Users** — `/users` (list) + `/users/:id` (detail)
3. **Subscriptions** — `/subscriptions`
4. **Broker Accounts** — `/brokers`
5. **Telegram** — `/telegram` (sessions + channels + profiles)
6. **Signals** — `/signals`
7. **Trades** — `/trades`
8. **Backtesting** — `/backtests`
9. **Presets** — `/presets`
10. **Edge Functions** — `/functions` (static reference)

---

## Complete Database Schema

### Table: `user_profiles`
| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid | PK, references auth.users |
| display_name | text | |
| first_name | text | |
| last_name | text | |
| username | text | |
| country | text | |
| city | text | |
| address | text | |
| mobile_number | text | |
| base_currency | text | |
| timezone | text | |
| is_admin | boolean | Bypass paywall |
| admin_until | timestamptz | Nullable, expiry for admin access |
| subscription_status | text | Mirrored from subscriptions |
| copier_paused | boolean | User-initiated copier pause |
| notification_sound | boolean | |
| email_verified_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `subscriptions`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | Unique per user |
| stripe_customer_id | text | |
| stripe_subscription_id | text | |
| plan | text | 'basic' or 'advanced' |
| status | text | 'active', 'trialing', 'canceled', 'past_due', 'incomplete' |
| extra_accounts | integer | Additional accounts beyond plan limit |
| trial_ends_at | timestamptz | |
| current_period_end | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `stripe_events`
| Column | Type | Notes |
|--------|------|-------|
| event_id | text | PK, Stripe event ID |
| event_type | text | |
| processed_at | timestamptz | |

### Table: `broker_accounts`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| label | text | |
| platform | text | MT4, MT5, cTrader, DXTrade, TradeLocker |
| metaapi_account_id | text | MetatraderAPI account UUID |
| account_login | text | |
| broker_name | text | |
| broker_server | text | |
| connection_status | text | 'pending', 'connected', 'error', 'recovering' |
| connection_error_kind | text | |
| connection_error_message | text | |
| is_active | boolean | |
| copier_mode | text | 'ai' or 'manual' |
| last_balance | numeric | |
| last_equity | numeric | |
| last_currency | text | |
| last_synced_at | timestamptz | |
| performance_baseline_balance | numeric | |
| performance_baseline_captured_at | timestamptz | |
| day_start_balance | numeric | |
| day_start_balance_on | text | |
| auto_reconnect_enabled | boolean | |
| password_updated_at | timestamptz | |
| signal_channel_ids | uuid[] | Subscribed telegram_channels |
| enforce_signal_channel_filter | boolean | |
| ai_settings | jsonb | AI copier config |
| manual_settings | jsonb | Manual copier config |
| channel_message_filters | jsonb | Per-channel management filters |
| channel_trading_configs | jsonb | Per-channel copier_mode + settings |
| default_lot_size | numeric | |
| pip_tolerance | integer | |
| max_trades_per_zone | integer | |
| last_activated_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `mt_servers`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| server_name | text | |
| platform | text | 'MT4', 'MT5', 'ANY' |
| broker_label | text | |
| is_active | boolean | |

### Table: `telegram_sessions`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | Unique (one session per user) |
| session_string | text | Encrypted MTProto token — MASK in UI |
| phone_number | text | |
| is_active | boolean | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `telegram_auth_pending`
| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid | PK |
| phone | text | |
| phone_code_hash | text | |
| expires_at | timestamptz | |

### Table: `telegram_channels`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| channel_id | text | Telegram numeric channel ID |
| channel_username | text | |
| display_name | text | |
| is_active | boolean | |
| lot_size_override | numeric | |
| pip_tolerance_override | integer | |
| channel_keywords | jsonb | Signal parsing keywords |
| last_seen_message_id | integer | High-water mark |
| last_seen_at | timestamptz | |
| last_live_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `channel_signal_profiles`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| channel_id | uuid | Unique per user+channel |
| lookback_days | integer | Analysis window (default 30) |
| sample_size | integer | Signals analyzed |
| signal_type | text | |
| tp_style | text | |
| sl_style | text | |
| entry_type | text | |
| most_traded_asset | text | |
| estimated_tp_pips | numeric | |
| estimated_sl_pips | numeric | |
| analysis_summary | text | |
| meta | jsonb | |
| analyzed_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `signals`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| channel_id | uuid | References telegram_channels |
| raw_message | text | |
| raw_image_url | text | |
| parsed_data | jsonb | AI-extracted trade instruction |
| status | text | 'pending', 'parsed', 'executed', 'skipped', 'failed' |
| skip_reason | text | |
| telegram_message_id | text | |
| reply_to_message_id | text | |
| is_modification | boolean | |
| parent_signal_id | uuid | For modifications |
| user_override | jsonb | Manual SL/TP override |
| created_at | timestamptz | |

### Table: `trades`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| signal_id | uuid | |
| broker_account_id | uuid | |
| telegram_channel_id | text | |
| metaapi_order_id | text | |
| symbol | text | |
| direction | text | 'buy' or 'sell' |
| entry_price | numeric | |
| sl | numeric | |
| tp | numeric | |
| tp_levels | numeric[] | Multiple TP targets |
| tp_open | boolean | |
| tp_step_policy | jsonb | |
| next_tp_index | integer | |
| lot_size | numeric | |
| status | text | 'open', 'closed', 'modified', 'cancelled' |
| profit | numeric | |
| opened_at | timestamptz | |
| closed_at | timestamptz | |
| created_at | timestamptz | |

### Table: `signal_broker_dispatch_claims`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| signal_id | uuid | |
| broker_account_id | uuid | |
| created_at | timestamptz | |
| Unique constraint: (signal_id, broker_account_id) |

### Table: `trade_execution_logs`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| channel_id | uuid | |
| signal_id | uuid | |
| broker_account_id | uuid | |
| action | text | 'order', 'close', 'modify', 'breakeven', etc. |
| status | text | 'executed', 'skipped', 'failed' |
| error_message | text | |
| meta | jsonb | |
| created_at | timestamptz | |

### Table: `backtest_runs`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| name | text | |
| status | text | 'pending', 'running', 'completed', 'failed', 'cancelled' |
| progress_pct | numeric | |
| progress_message | text | |
| config | jsonb | SimpleBacktestConfig |
| summary | jsonb | BacktestSummary (win_rate, profit_factor, max_drawdown, total_pips) |
| error_message | text | |
| started_at | timestamptz | |
| completed_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `backtest_run_channels`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| run_id | uuid | |
| channel_id | uuid | |
| Unique: (run_id, channel_id) |

### Table: `backtest_trades`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| run_id | uuid | |
| signal_id | uuid | |
| channel_id | uuid | |
| symbol | text | |
| direction | text | |
| signal_at | timestamptz | |
| closed_at | timestamptz | |
| entry_price | numeric | |
| exit_price | numeric | |
| sl | numeric | |
| tp_levels | numeric[] | |
| lot_size | numeric | |
| pnl | numeric | |
| pnl_r | numeric | Risk-multiple |
| outcome | text | 'sl_before_tp', 'tp1_then_sl', 'tp_then_be', 'all_tp_hit', 'breakeven', 'no_data', 'skipped', 'open', 'market_data_mismatch' |
| tps_hit | integer | |
| max_favorable_excursion | numeric | |
| max_adverse_excursion | numeric | |
| details | jsonb | |
| created_at | timestamptz | |

### Table: `backtest_equity_points`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| run_id | uuid | |
| ts | timestamptz | |
| equity | numeric | |
| balance | numeric | |
| drawdown_pct | numeric | |
| open_trades | integer | |

### Table: `channel_trading_presets`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | |
| name | text | 1-80 chars, unique per user |
| copier_mode | text | 'ai' or 'manual' |
| manual_settings | jsonb | |
| channel_filters | jsonb | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: `worker_session_leases`
| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid | PK |
| worker_id | text | |
| engine | text | 'python' or 'node' |
| renewed_at | timestamptz | |
| created_at | timestamptz | |

### Table: `affiliate_profiles`
| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid | PK |
| referral_code | text | Unique |
| custom_referral_code | text | Unique, nullable |
| payout_wallet_address | text | |
| created_at | timestamptz | |

### Table: `referral_attributions`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| affiliate_user_id | uuid | |
| referred_user_id | uuid | Unique |
| referral_code | text | |
| created_at | timestamptz | |

### Table: `commission_ledger`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| affiliate_user_id | uuid | |
| referred_user_id | uuid | |
| stripe_invoice_id | text | |
| gross_amount_cents | integer | |
| commission_cents | integer | |
| status | text | 'pending', 'paid', 'reversed' |
| created_at | timestamptz | |

### Table: `admin_audit_logs`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| admin_user_id | uuid | |
| target_user_id | uuid | |
| action | text | |
| reason | text | |
| payload | jsonb | |
| created_at | timestamptz | |

### Table: `app_settings`
| Column | Type | Notes |
|--------|------|-------|
| key | text | PK |
| value | jsonb | |
| updated_at | timestamptz | |

---

## Edge Functions (24 deployed)

| Slug | JWT | Purpose |
|------|-----|---------|
| broker-metatrader | yes | Unified MT API proxy (register, delete, summary, trades, reconnect, check, pnl_quick) |
| execute-trade | no | Place trades on broker accounts from signals |
| parse-signal | yes | AI signal parsing from raw Telegram messages |
| telegram-auth | yes | MTProto authentication (send_code, verify_code) |
| analyze-channel-profile | yes | Channel pattern analysis (signal_type, tp/sl style) |
| backtest-run | yes | Historical simulation engine |
| market-news | yes | FMP forex news feed |
| economic-calendar | yes | FMP economic calendar |
| market-sentiment | yes | Market sentiment data |
| create-checkout-session | yes | Stripe checkout session creation |
| stripe-webhook | no | Stripe event processing (subscription sync) |
| customer-portal | yes | Stripe billing portal link |
| update-extra-accounts | yes | Add extra broker accounts to subscription |
| sync-mt-servers | yes | MT server directory sync |
| range-pending-sweep | yes | Automated range pending order management |
| basket-sl-tp-sweep | yes | Automated basket SL/TP reconciliation |
| connect-metatrader-account | yes | Account lifecycle - connect |
| delete-metatrader-account | yes | Account lifecycle - delete |
| validate-broker-account | yes | Account lifecycle - validate |
| metatrader-brokers | yes | Legacy: broker search |
| metatrader-account-summary | yes | Legacy: account summary |
| metatrader-trades | yes | Legacy: trade history |
| mt-server-suggestions | yes | Legacy: server search |
| send-verification-email | no | Email verification on signup |
| admin-query | yes | Admin panel read queries |
| admin-mutate | yes | Admin panel write mutations |
| fxsocket-broker | yes | FXSocket broker terminal proxy |

---

## Page Specifications

### 1. Overview Dashboard (`/`)

**Queries:**
```sql
-- Total users
SELECT count(*) FROM user_profiles;
-- Active brokers
SELECT count(*) FROM broker_accounts WHERE is_active = true;
-- Open trades
SELECT count(*) FROM trades WHERE status = 'open';
-- Closed trades today
SELECT count(*) FROM trades WHERE status = 'closed' AND closed_at >= <today_start>;
-- Active channels
SELECT count(*) FROM telegram_channels WHERE is_active = true;
-- Active subscriptions
SELECT count(*) FROM subscriptions WHERE status = 'active';
-- Signals today
SELECT count(*) FROM signals WHERE created_at >= <today_start>;
-- Worker leases (listener health)
SELECT * FROM worker_session_leases ORDER BY renewed_at DESC;
```

**UI:** 6 stat cards in a grid, plus a signals funnel chart (Recharts bar: pending/parsed/executed/skipped/failed counts).

---

### 2. Users List (`/users`)

**Query:**
```sql
SELECT user_id, display_name, first_name, last_name, subscription_status, is_admin, admin_until, created_at, base_currency
FROM user_profiles
ORDER BY created_at DESC
LIMIT 200;
```

Join with `broker_accounts` for total_balance per user. Use `supabase.auth.admin.listUsers()` for emails.

**UI:** Searchable table with columns: Name, Email, Joined, Balance, Plan, Admin status. Click row to navigate to detail.

---

### 3. User Detail (`/users/:id`)

**Query:**
```sql
-- Profile
SELECT * FROM user_profiles WHERE user_id = :id;
-- Subscription
SELECT * FROM subscriptions WHERE user_id = :id;
-- Brokers
SELECT * FROM broker_accounts WHERE user_id = :id;
-- Channels
SELECT * FROM telegram_channels WHERE user_id = :id;
-- Trades (recent 200)
SELECT * FROM trades WHERE user_id = :id ORDER BY created_at DESC LIMIT 200;
-- Backtests
SELECT * FROM backtest_runs WHERE user_id = :id ORDER BY created_at DESC LIMIT 50;
-- Copier logs (recent 100)
SELECT * FROM trade_execution_logs WHERE user_id = :id ORDER BY created_at DESC LIMIT 100;
```

**UI:** Profile card, subscription card, broker accounts table, channels table, recent trades table, backtest runs list.

---

### 4. Subscriptions (`/subscriptions`)

**Query:**
```sql
SELECT s.*, up.display_name, up.first_name, up.last_name
FROM subscriptions s
LEFT JOIN user_profiles up ON up.user_id = s.user_id
ORDER BY s.created_at DESC;
```

**UI:** Table with: User, Plan, Status, Extra Accounts, Stripe Customer ID, Trial Ends, Period End, Created.

---

### 5. Broker Accounts (`/brokers`)

**Query:**
```sql
SELECT ba.*, up.display_name, up.first_name, up.last_name
FROM broker_accounts ba
LEFT JOIN user_profiles up ON up.user_id = ba.user_id
ORDER BY ba.created_at DESC;
```

**UI:** Table with: User, Label, Platform, Server, Connection Status, Active, Copier Mode, Balance, Equity, Last Synced. Filter by: platform, connection_status. Click to expand JSONB (ai_settings, manual_settings, channel_trading_configs).

---

### 6. Telegram (`/telegram`)

Three tabs:

**Sessions tab:**
```sql
SELECT ts.*, up.display_name FROM telegram_sessions ts
LEFT JOIN user_profiles up ON up.user_id = ts.user_id;
```
Columns: User, Phone, Active, Created. MASK session_string.

**Channels tab:**
```sql
SELECT tc.*, up.display_name FROM telegram_channels tc
LEFT JOIN user_profiles up ON up.user_id = tc.user_id
ORDER BY tc.last_live_at DESC NULLS LAST;
```
Columns: User, Display Name, Username, Active, Last Live At, Last Seen At. Highlight stale channels (last_live_at > 1hr ago).

**Profiles tab:**
```sql
SELECT csp.*, tc.display_name AS channel_name FROM channel_signal_profiles csp
LEFT JOIN telegram_channels tc ON tc.id = csp.channel_id;
```
Columns: Channel, Signal Type, TP Style, SL Style, Entry Type, Most Traded Asset, Est TP Pips, Est SL Pips, Sample Size, Analyzed At.

---

### 7. Signals (`/signals`)

**Query:**
```sql
SELECT s.*, tc.display_name AS channel_name, up.display_name AS user_name
FROM signals s
LEFT JOIN telegram_channels tc ON tc.id = s.channel_id
LEFT JOIN user_profiles up ON up.user_id = s.user_id
ORDER BY s.created_at DESC
LIMIT 50 OFFSET :page * 50;
```

**UI:** Paginated table (50 per page). Columns: User, Channel, Status, Message (truncated 80 chars), Is Modification, Created. Click to expand full raw_message + parsed_data JSONB.

**Stats panel:** Pie chart of status distribution. Bar chart of signals per day (last 30 days).

---

### 8. Trades (`/trades`)

**Query:**
```sql
SELECT t.*, ba.label AS broker_label, up.display_name AS user_name
FROM trades t
LEFT JOIN broker_accounts ba ON ba.id = t.broker_account_id
LEFT JOIN user_profiles up ON up.user_id = t.user_id
ORDER BY t.created_at DESC
LIMIT 50 OFFSET :page * 50;
```

**UI:** Paginated table. Columns: User, Broker, Symbol, Direction, Entry, Lot Size, Status, Profit, Opened At, Closed At. Filter by: status, direction, symbol. Sort by: opened_at, profit.

**Analytics panel:** Daily P&L bar chart (last 30 days). Top symbols by trade count.

---

### 9. Backtesting (`/backtests`)

**Query:**
```sql
SELECT br.*, up.display_name AS user_name
FROM backtest_runs br
LEFT JOIN user_profiles up ON up.user_id = br.user_id
ORDER BY br.created_at DESC;
```

**UI:** Table with: User, Name, Status, Progress, Config summary, Started, Completed. Click to expand full config + summary JSONB. For completed runs, show link to view equity curve from `backtest_equity_points`.

---

### 10. Presets (`/presets`)

**Query:**
```sql
SELECT ctp.*, up.display_name AS user_name
FROM channel_trading_presets ctp
LEFT JOIN user_profiles up ON up.user_id = ctp.user_id
ORDER BY ctp.created_at DESC;
```

**UI:** Table with: User, Name, Copier Mode, Created. Click to expand manual_settings + channel_filters JSONB.

---

### 11. Edge Functions (`/functions`)

Static reference page listing all 24 functions with: slug, JWT setting, purpose, related tables.

---

## Shared Components to Build

1. **AdminShell** — Sidebar + top bar + main content area + dark mode toggle
2. **DataTable** — Reusable table with sorting, pagination, loading skeleton, CSV export
3. **JsonViewer** — Expandable JSONB display (collapsible tree)
4. **StatCard** — Single metric display (value + label + optional trend)
5. **UserLink** — Display name that links to `/users/:id`
6. **StatusBadge** — Color-coded status pills (connected=green, error=red, pending=yellow)
7. **DateDisplay** — Relative time + full date tooltip
8. **ExportButton** — CSV download for current table view
9. **SearchInput** — Debounced search with clear button
10. **TabGroup** — Tab switching for multi-view pages

---

## Data Fetching Pattern

All queries use the service_role Supabase client directly (no edge functions needed for read-only admin):

```ts
const { data, error, count } = await supabase
  .from('table_name')
  .select('*', { count: 'exact' })
  .order('created_at', { ascending: false })
  .range(from, to)
```

For user emails, use: `supabase.auth.admin.listUsers({ page, perPage })`

---

## Existing Admin Infrastructure (already deployed)

The project already has `admin-query` and `admin-mutate` edge functions deployed that handle:
- `overview` — Platform stats
- `users_list` — User list with search + balance aggregation + email lookup
- `user_360` — Full user detail (profile, brokers, channels, trades, backtests, logs)
- `user_trades` — Paginated trades for a user
- `trades_recent` — Recent 500 trades globally
- `channels_recent` — Recent 300 channels
- `backtests_recent` — Recent 200 backtest runs
- `copier_logs_recent` — Recent 300 execution logs
- `affiliate_payouts_overview` — Affiliate commission ledger

You can EITHER use these edge functions (requires admin auth via Supabase login) OR query tables directly with service_role key (simpler for a standalone admin panel).

---

## Deployment

- Deploy as a separate Vite app on its own subdomain (e.g., admin.yourapp.com)
- Keep completely separate from the main app
- The VITE_ADMIN_PASSWORD gate is the only access control
- Never expose the service_role key to non-admin users
