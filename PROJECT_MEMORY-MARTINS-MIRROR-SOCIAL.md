# Project memory — Martins (mirror trading and social copy)

Mirror-slave configuration and social-copy work from 2026-10-12. Longer Martins history stays in `docs/PROJECT_MEMORY-MARTINS.md`. This file does not replace it.

## Changelog

### 2026-10-12 — Slave configure modal: Simple by default, Advanced on a toggle

- **Context:** The slave account configuration modal needed two modes. Simple should follow the social trading setup modal. Advanced should reveal the full copy-risk editor.
- **Root cause:** The modal always showed every sizing mode and the limits editor. There was no simple path.
- **Solution:** `SlaveConfigureModal` opens in Simple. Simple offers three methods that write real `CopyRiskSettings`: proportional maps to `balance_ratio` (choosing it from another mode sets `balance_multiplier` to 1), fixed lot maps to `fixed_lot`, and risk multiplier maps to `lot_multiplier` with the 0.25–2 chips. Protection toggles stay visible (copy SL, copy TP, close on source exit, recovery). The Advanced toggle reveals all seven sizing modes and `CopyRiskEditor` with `omitSizing`. The modal opens already in Advanced when the saved mode is equity ratio, percent risk, cash risk, or stop distance, or when balance ratio uses a multiplier other than 1. Turning Advanced off does not rewrite a non-simple mode until the user picks a simple method. The right preview follows the mode: Simple shows the example lot, risk profile, and only protections that are on; Advanced lists every on setting. Settings still save live through `patchSlaveSettings`.
- **Affected files:** `src/components/configure/SlaveConfigureModal.tsx`, `src/i18n/locales/types.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/es.ts`, `src/i18n/locales/fr.ts`.
- **Verification:** `npx tsc -p tsconfig.app.json --noEmit` was filtered for `SlaveConfigure` and the locale files; those files reported no errors. The full typecheck log was not inspected. The modal was not opened in a browser.
- **Blockers:** None in code.
- **Follow-up:** Confirm Simple and Advanced in the browser, including an account already saved on percent risk or a non-1 balance multiplier.

### 2026-10-12 — Slave preview lists active settings and hides Off

- **Context:** The right-hand Preview setup showed only estimated lot, copy SL, copy TP, and risk profile, and number fields committed on blur.
- **Root cause:** The preview rendered a four-row list. `CopyRiskEditor` number fields updated the parent only on blur, so the preview lagged while typing.
- **Solution:** `previewGroups` lists sizing, stops, protection, exposure, filters, execution, provider, lifecycle, and advanced. Rows whose displayed value equals `labels.off` are removed, and a group with no remaining rows is omitted. English Off is "Off"; Spanish is "No"; French is "Non". Number inputs in the modal (`LiveNumber`) and in `CopyRiskEditor` commit while typing, with a focus guard so an in-progress decimal is not reset. The preview panel scrolls when the list is taller than the modal. Lot estimates use a 1.00-lot example master trade. Percent risk, cash risk, and stop distance still show the unavailable estimate because there is no live stop in the dialog.
- **Affected files:** `src/components/configure/SlaveConfigureModal.tsx`, `src/components/configure/CopyRiskEditor.tsx` (`omitSizing`, live `NumberField`).
- **Verification:** Same filtered typecheck as the entry above. Not browser-verified.
- **Blockers:** None.
- **Follow-up:** Each keystroke queues a settings save through `settingsSaveRef`. That is intentional so the preview stays current.

### 2026-10-12 — Social copy button opens setup; price is its own column

- **Context:** "Copy for $X/Month" was becoming "Following" on click. The directory needed a Price column, and every not-yet-copying action needed to be "Copy Trader".
- **Root cause:** The action button both started a copy and changed its own label. Price was not a column.
- **Solution:** Directory and profile use `CopyActionButton`. Not copying shows "Copy Trader" and opens `CopyTraderModal` (directory `setupTrader`, profile `copyModalOpen`). Already copying shows "Following"; that click calls `runCopyAction` and stops the copy. There is no second Copy Trader button beside Following. The modal is a preview only: it does not charge a card and does not persist copy settings. Stripe is not integrated. Price is a column. `0` cents is Free; otherwise `{amount}/Month` via `useFormatMoney`. The signed-in user's price is localStorage `tscopier:social-trading:copy-price-cents` (USD cents, cap `1_000_000_00`). Other traders use fixture `monthlyCopyPriceCents`: you 0, Amira Hassan 5000, Leo Berg 2500, Nora Okonkwo 0, Kenji Sato 10000. Amira and Leo fixtures start `following: true`; sessionStorage `tscopier:social-trading:following` overrides that. Access remains sessionStorage `tscopier:social-trading:access`.
- **Affected files:** `src/pages/dashboard/SocialTradingPage.tsx`, `src/components/social/CopyTraderModal.tsx`, `src/lib/socialCopyPrice.ts`, `src/lib/socialCopyPrice.test.ts`, `src/lib/socialTradingFixture.ts`, `src/lib/socialCopyPreview.ts`, social strings in `src/i18n/locales/types.ts`, `en.ts`, `es.ts`, `fr.ts`.
- **Verification:** `src/lib/socialCopyPrice.test.ts` exists. It was not re-run while writing this file. The copy modal was not opened in a browser in this pass.
- **Blockers:** Paid Copy Trader does not collect payment.
- **Follow-up:** Wire Stripe later. Do not turn the price control into the Following button.

### 2026-10-12 — Wallet page and ledger migration written, not applied

- **Context:** Copy subscriptions will later credit a wallet the way the affiliate program does. Stripe Checkout and payouts are out of this pass.
- **Root cause:** No wallet tables or page existed.
- **Solution:** `supabase/migrations/20261010180000_user_wallets.sql` adds `user_wallets` (`available_cents`, `pending_cents`, default 0, one row per user) and `wallet_ledger` (payer, provider, amount cents, status `pending` | `paid` | `reversed`). Users can SELECT their own wallet and ledger rows where they are payer or provider. No client insert. `/wallet` loads those tables and shows Available, Pending, and history. The page is in the user menu beside Affiliate Program and in the sidebar membership section. Empty balances and a load error are expected until the tables exist. Chrome overlays that replace `pages` and `userMenu` include the wallet labels.
- **Affected files:** `supabase/migrations/20261010180000_user_wallets.sql`, `src/pages/dashboard/WalletPage.tsx`, `src/pages/dashboard/SupportMembershipPages.tsx`, `src/App.tsx`, `src/components/layout/UserMenuDropdown.tsx`, `src/components/layout/AppLayout.tsx`, `src/lib/appSearch.ts`, `src/lib/appNavIcons.ts`, `src/types/database.ts`, wallet strings in `src/i18n/locales/types.ts`, `en.ts`, `es.ts`, `fr.ts`, and chrome overlays `ja`, `sv`, `ru`, `pl`, `nl`, `ar`.
- **Verification:** The SQL file is in the repo. It was not applied. MCP `apply_migration` against Migration project `supmsgcubipmmowrzoub` returned ProtocolError -32600 (no permission). It was not retried against production `sxkpcovbyaficvtkpsdo` or staging `axdcledcyhyvzrnfkwat`. `supabase db push` was not run; the CLI linked project is production.
- **Blockers:** Wallet page queries fail until `20261010180000_user_wallets.sql` is applied on the Migration branch.
- **Follow-up:** Apply that migration on Migration only, when a permitted path exists. Stripe Checkout, crediting wallets, and payouts are still not built.
