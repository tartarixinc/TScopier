# Market News (Financial Modeling Prep)

Forex headlines on **Market News** are loaded via the `market-news` Supabase Edge Function, which proxies [FMP Forex News](https://site.financialmodelingprep.com/developer/docs/stable/forex-news) (`/stable/news/forex-latest`). The API key never ships to the browser.

Uses the same **`FMP_API_KEY`** as the Economic Calendar.

## Setup

1. Use your [Financial Modeling Prep](https://site.financialmodelingprep.com) API key (premium includes forex news).
2. Set the secret on your Supabase project (once for both news and calendar):

   ```bash
   supabase secrets set FMP_API_KEY=your_fmp_api_key
   ```

3. Deploy the function:

   ```bash
   supabase functions deploy market-news
   ```

4. Sign in and open **Market News** (`/market-news`).

## Optional query parameters

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `0` | Pagination page |
| `limit` | `50` | Articles per page (max 100) |
| `symbols` | — | If set, uses `/news/forex?symbols=EURUSD` instead of latest feed |

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| `FMP_API_KEY is not configured` | Run `supabase secrets set` and redeploy `market-news`. |
| `Invalid API KEY` from FMP | Verify premium access includes forex news endpoints. |
| `Could not reach market-news` | Deploy to the same project as `VITE_SUPABASE_URL`. |
| Empty list | Refresh; confirm your FMP plan includes forex news. |
| No thumbnails | FMP often includes `image`; OG fallback runs for missing covers. |

## Security

- Do **not** add `VITE_FMP_*` — keep the key in Supabase Edge Function secrets only.
- You can remove `FINNHUB_API_KEY` from Supabase secrets if it is no longer used.
