# TSCopier Docs (MVP)

User-facing documentation for TSCopier, intended for `https://docs.tscopier.ai`.

## Local development

From repo root:

```bash
npm install
npm run dev:docs
```

Or from this folder:

```bash
npm install
npm run dev
```

## Build

From repo root:

```bash
npm run build:docs
```

## CI

GitHub Actions runs a docs build on PRs and pushes that touch `apps/docs/**`:

- `.github/workflows/docs-ci.yml`

## Deploy checklist

1. Connect `apps/docs` to your docs hosting provider.
2. Set custom domain `docs.tscopier.ai`.
3. Confirm the site serves over HTTPS.
4. In app hosting env vars, set:
   - `VITE_HELP_DOCS_URL=https://docs.tscopier.ai`
5. Verify links open correctly from:
   - App header Help menu (`Documentation`)
   - Marketing footer (`Documentation`)

## MVP content map

- Introduction
- Quickstart
- Telegram setup
- Broker setup
- Configuration basics
- Plans and billing
- Troubleshooting FAQ
- Contact support
