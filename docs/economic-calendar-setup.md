# Economic Calendar (Financial Modeling Prep)

The **Economic Calendar** page loads macro release schedules via the `economic-calendar` Supabase Edge Function, which proxies [FMP Economic Calendar](https://site.financialmodelingprep.com/developer/docs/stable/economics-calendar).

Optional **News filter** uses the `market-news` function (same `FMP_API_KEY`) to show related forex headlines.

## Setup

1. Use your [Financial Modeling Prep](https://site.financialmodelingprep.com) API key.
2. Set the secret once for both features:

   ```bash
   supabase secrets set FMP_API_KEY=your_fmp_api_key
   ```

3. Deploy both functions:

   ```bash
   supabase functions deploy economic-calendar market-news
   ```

4. Open **Economic Calendar** (`/economic-calendar`).

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| `FMP_API_KEY is not configured` | Run `supabase secrets set` and redeploy. |
| `Invalid API KEY` from FMP | Verify the key in the FMP dashboard. |
| News filter empty | Deploy `market-news` with the same `FMP_API_KEY`. |

## Security

- Do **not** add `VITE_FMP_*` — keep the key in Supabase Edge Function secrets only.
