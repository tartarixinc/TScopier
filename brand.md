# Brand — UniCopier

UniCopier — Unified Copy Trading. Ultra-fast Telegram signal copier for MetaTrader accounts: cloud-based, sub-50ms, no VPS, no EA, up to 100 MT4/MT5 connections, plus account mirroring, social trading, and a signal-provider marketplace.

_Documented from the live codebase on 2026-10-21. This file describes the brand **as built** — the code is the source of truth; update this file when the code changes, not the other way around._

## Palette — Signal Green on Slate (as-built)

**Vibe:** serious · technical · trustworthy
**Category:** consumer/social (retail trading SaaS with a social layer)
**Mood:** serious + technical (derived from the codebase: finance-grade risk/trust surfaces, latency/uptime metrics, engineered dark UI)

There is no separate design token layer (no shadcn CSS variables). The palette lives in two places:

- **`tailwind.config.js`** — the color scales (used everywhere via utilities like `bg-green-400`, `text-neutral-900`, `border-neutral-200`).
- **`src/index.css` `--tsc-*` variables** — page/surface/border/text for light and dark (legacy TScopier naming; `html`/`body` read them).

### Seeds

| Role | Light | Dark | Source |
|---|---|---|---|
| bg-base (page) | `#ffffff` | `#030616` | `--tsc-page` / `--tsc-surface` (`neutral-950`) |
| bg-elevated (muted surface) | `#f8fafc` | `#1e293b` | `--tsc-surface-muted` (`neutral-100` / `neutral-800`) |
| primary | `#4ade80` | `#4ade80` | **Brand green = Tailwind `green-400`**, pinned in `tailwind.config.js` |
| primary-soft (glow/tint) | `#f0fdf4` | `#052e16` | `primary-50` light / `primary-950` dark |
| fg-base | `#0f172a` | `#f8fafc` | `--tsc-text` (`neutral-900` / `neutral-50`) |
| border | `#e2e8f0` / `#f1f5f9` | `#334155` / `#1e293b` | `--tsc-border` / `--tsc-border-subtle` (`neutral-200/100`, `neutral-700/800`) |

### Color scales (tailwind.config.js)

- **`primary` and `teal` are deliberately the same green ramp** (50–950 all mapped onto `#f0fdf4 → #4ade80 → #052e16`; 400/500/600 are all `#4ade80`). The config comment states it: *"Brand primary is Tailwind green-400 (#4ade80). 400–600 share it so existing teal/primary utilities match text-green-400."* Classes like `teal-950` therefore render **deep forest green, not cyan** — this is intentional, not a bug.
- **`success`** — standard green ramp (`#22c55e` family) for positive states.
- **`warning`** — amber ramp (`#f59e0b` family).
- **`error` / `red`** — custom soft-red ramp: 600–950 run `#FF8585 → #8F3333`; note `error-500`/`red-500` is the muted gray `#737373` (safelisted), used as the "danger" button background — destructive actions are deliberately understated, not alarm-red.
- **`neutral`** — slate ramp (`#f8fafc → #030616`): the surface/text foundation for both modes.

### Canonical buttons (`src/components/ui/Button.tsx`)

- **primary** — `bg-green-400 text-neutral-950 hover:bg-green-500 ring-green-400` (near-black text on brand green)
- **secondary** — white / `neutral-800` surface with `neutral-200/700` border
- **ghost** — text-only, hover `neutral-100`/`neutral-800`
- **danger** — `bg-error-500 text-white` (the muted `#737373`)

### Theme switching

Class strategy: `.dark` toggled on `<html>` by `src/context/ThemeContext.tsx` — stored choice in `localStorage` first, otherwise system `prefers-color-scheme`; user-facing toggle in `src/components/ui/ThemeToggle.tsx`. Both modes are derived from the same slate/green scales and must stay visually identical families.

## Typography

- **Display + body: SF Pro** — system stack `'SF Pro', 'SF Pro Text', 'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif` (`tailwind.config.js` `fontFamily.sans`, mirrored on `html`/`body` in `src/index.css`). No Latin webfont is downloaded — it renders native on Apple devices and falls back to `system-ui` elsewhere.
- **Arabic: Noto Sans Arabic** — the only Google Font loaded (`index.html`), injected into the stack for `html[dir='rtl']`.
- **Mono** — no brand mono is defined; `font-mono` falls back to Tailwind's default `ui-monospace` stack and is used sparingly (log lines, IDs — e.g. `CopierEnginePage.tsx`).

### Type scale (as used in the app)

| Role | Class | Use |
|---|---|---|
| Display / hero | `text-3xl`–`text-5xl font-semibold tracking-tight` | Landing hero only |
| Page title | `text-2xl`/`text-3xl font-semibold` | Dashboard page headers |
| Section | `text-lg`/`text-xl font-semibold` | Card groups, modal titles |
| Card title | `text-sm`/`text-base font-semibold` | Cards, rows |
| Body | `text-sm` (dark: `text-neutral-900 dark:text-neutral-50`) | Default UI text |
| Caption / label | `text-xs` (`text-neutral-500 dark:text-neutral-400`) | Helpers, timestamps, column labels |
| Numbers in place | `font-mono tabular-nums` (or repo number formatting) | Balances, P&L, counters |

## Gradients (as-built, in use)

Defined as reusable classes in `src/index.css`:

- **Dark cards:** `bg-linear-to-br from-neutral-900 via-teal-950/20 to-primary-950/40` — deep slate card with a forest-green glow (because `teal-*` = green, this is green-on-slate, not cyan).
- **Light cards:** `from-white via-teal-50/40 to-primary-50/30` — white card with a faint green wash.

**Use for:** hero/feature/dashboard highlight cards and page headers.
**Do not use for:** body text backgrounds, form fields, or stacking multiple gradients on one screen.

## Tone and voice

**Words to use:** plain professional English, metric-led and concrete — `under 50ms`, `99.99% uptime`, `no VPS`, `no EA`, `up to 100 connections`, `5-day free trial`. Benefit-first comparisons ("copy signals without the manual work"), trust and compliance language (`Trading involves risk. UniCopier is a copy tool — not financial advice.`), and calm operational reassurance (`cloud`, `automatic`, `transparent logs`).

**Words to avoid:** internal jargon (worker, shard, edge function, migration), unverifiable superlatives beyond the established `#1` hero claim, hype words (`moon`, `guaranteed`, `risk-free`), and anything that sounds like financial advice or profit promises.

**Voice example (from the landing hero):**

> Copy trades from Telegram, WhatsApp, Discord, TradingView, or a Master Account to 8+ broker platforms in under 50ms. No VPS required.

## Usage dos and don'ts

**Do:**

- Use Tailwind color utilities from the config scales (`bg-green-400`, `text-neutral-900 dark:text-neutral-50`, `border-neutral-200 dark:border-neutral-700`) — new components should default to these, as `SymbolMappingEditor` does.
- For page/surface-level backgrounds and text, use the `--tsc-*` variables or the established `neutral` utilities — never new hex values in components.
- Use `ring-green-400` for focus states (the pattern across buttons and inputs).
- Keep the near-black-on-green button pairing (`text-neutral-950` on `bg-green-400`) — it is the brand's CTA signature.
- Test every component in **both** light and dark mode (class toggled via `ThemeContext`).
- Follow the 4px spacing grid (`gap-2`, `p-4`) and the existing `rounded-lg`/`rounded-xl` radius scale; shadows `shadow-card`/`shadow-card-lg` from the config.

**Don't:**

- Hardcode hex colors in component files (the only sanctioned hex lives in `tailwind.config.js` and the `--tsc-*` block in `src/index.css`).
- Treat `teal-*` utilities as cyan/blue — they are pinned to green on purpose; do not "fix" them.
- Use alarm-red for destructive UI — the system's `error-500` (`#737373`) and the soft red ramp keep destructive states restrained; reserve saturated red (`error-600+`) for small accents (delete icons, negative P&L).
- Introduce a second display font or a webfont for Latin text — SF Pro system stack is the identity.
- Use `transition: all`; specify `transition-colors`/`transition-transform`.

## How the rest of the toolchain uses this file

- `frontend-design-guidelines` reads this file before generating or reviewing UI; new components should match these scales, button pairings, and voice.
- Rebrand requires editing `tailwind.config.js` + `src/index.css` first, then updating this file in the same change.
- If a color decision is wrong, change the scale/variable at its source — never per-component overrides.

---

_Last updated: 2026-10-21, documented from code (sources: `tailwind.config.js`, `src/index.css`, `src/context/ThemeContext.tsx`, `src/components/ui/Button.tsx`, `src/i18n/locales/landing/en.ts`, `index.html`)._
