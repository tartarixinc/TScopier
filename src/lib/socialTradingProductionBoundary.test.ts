import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../pages/dashboard/SocialTradingPage.tsx", import.meta.url),
  "utf8",
);
const directory = readFileSync(
  new URL("../components/social/SocialFollowDirectory.tsx", import.meta.url),
  "utf8",
);
const history = readFileSync(
  new URL("../components/social/SocialTradeHistoryPanel.tsx", import.meta.url),
  "utf8",
);
const copyPanel = readFileSync(
  new URL("../components/social/SocialCopyPanel.tsx", import.meta.url),
  "utf8",
);
const previewHook = readFileSync(
  new URL("../hooks/useSocialTradingPreview.ts", import.meta.url),
  "utf8",
);
const copyModal = readFileSync(
  new URL("../components/social/CopyTraderModal.tsx", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20261021130000_social_profile_links_and_demo_guard.sql",
    import.meta.url,
  ),
  "utf8",
);
const fullFlowMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20261027110000_social_full_flow_preview.sql",
    import.meta.url,
  ),
  "utf8",
);
const demoSeed = readFileSync(
  new URL("../../scripts/seed-social-trading-demo.ts", import.meta.url),
  "utf8",
);

test("the approved preview is the single production Social Trading UI", () => {
  assert.match(page, /useSocialTradingPreview\(\)/);
  assert.match(page, /\{traders\.map\(trader => \{/);
  assert.match(page, /MonthlyProfitChart/);
  assert.match(page, /PnlCalendar/);
  assert.match(page, /TraderReviews/);
  assert.match(page, /SocialProfileLinks/);
  assert.doesNotMatch(page, /<SocialFollowDirectory|<SocialFollowProfile/);
  assert.doesNotMatch(page, /SOCIAL_TRADERS|socialTraderById/);
});

test("approved preview metrics and calendar load through consent-aware source history", () => {
  assert.match(previewHook, /fetchSocialTradeHistoryAccess/);
  assert.match(previewHook, /fetchSocialProviderPerformance/);
  assert.match(previewHook, /fetchSocialTradeHistory/);
  assert.match(previewHook, /realizedProfit/);
  assert.match(previewHook, /returnPercentage \?\? null/);
  assert.match(previewHook, /maximumDrawdown \?\? null/);
});

test("production social UI retains the approved directory and profile information architecture", () => {
  assert.match(directory, /Realized P\/L/);
  assert.match(directory, /Closed trades/);
  assert.match(directory, /AccountModeBadge/);
  assert.match(directory, /fetchSocialCopySources/);
  assert.match(history, /Performance/);
  assert.match(history, /Trading/);
  assert.match(history, /Portfolio/);
  assert.match(history, /Recent realized performance/);
  assert.match(history, /P\/L calendar/);
  assert.match(history, /DEMO DATA/);
  assert.match(history, /Maximum drawdown[^]*—/);
  assert.match(history, /Destination-side copy executions are excluded/);
  assert.doesNotMatch(
    history,
    /SOCIAL_TRADERS|previewBalance|monthlyCopyPriceCents/,
  );
});

test("production directory keeps compact ratings in the Name column and copy controls reject demo data", () => {
  const nameCell = directory.slice(
    directory.indexOf("<tbody>"),
    directory.indexOf("<PerformanceCells"),
  );
  assert.match(nameCell, /<TraderReviews compact/);

  const actionsStart = directory.indexOf(
    '<td className="px-4 py-3 text-end">',
    directory.indexOf("<tbody>"),
  );
  const actionsEnd = directory.indexOf("</td></tr>", actionsStart);
  const actionsCell = directory.slice(actionsStart, actionsEnd);
  assert.match(actionsCell, /FollowButton/);
  assert.doesNotMatch(actionsCell, /TraderReviews/);

  assert.match(copyPanel, /selectedSource\?\.isSynthetic \? <Alert/);
  assert.match(copyPanel, /!selectedSource\?\.isCopyEligible/);
});

test("real Copy Trader flow persists through the existing subscription RPC", () => {
  assert.match(copyModal, /createSocialCopySubscription\(supabase/);
  assert.match(copyModal, /destinationBrokerAccountId: selectedBroker\.id/);
  assert.match(copyModal, /selectedSource\?\.isCopyEligible/);
  assert.match(
    copyModal,
    /const createdSubscriptionId = await createSocialCopySubscription/,
  );
  assert.match(copyModal, /maxLot,/);
  assert.match(
    copyModal,
    /changeSocialCopySubscription\(supabase, subscriptionId, action\)/,
  );
  assert.match(copyModal, /Pending worker acknowledgement/);
  assert.match(
    copyModal,
    /A current subscription already exists|Unable to create the copy subscription/,
  );
  assert.doesNotMatch(copyModal, /copiedLot == null \|\| copiedLot <= 0/);
  assert.doesNotMatch(copyModal, /<SettingToggle/);
});

test("synthetic demo flow persists through the guarded subscription RPC", () => {
  assert.match(copyModal, /const isSyntheticSimulation = selectedSource\?\.isSynthetic === true/);
  assert.match(copyModal, /await createSocialCopySubscription/);
  assert.doesNotMatch(copyModal, /if \(trader\.syntheticDemo\).*return/s);
  assert.match(copyModal, /SIMULATED DEMO \\u2014 NO BROKER ORDERS/);
  assert.match(copyModal, /persisted lifecycle state/);
  assert.match(copyModal, /without creating broker orders/);
  assert.match(page, /canOpenCopyTrader\(trader\)/);
  assert.match(
    copyModal,
    /trader\.syntheticDemo \? 'fixed_lot' : 'proportional'/,
  );
});
test.skip("historical synthetic rejection remains documented by its original migration", () => {
  assert.match(migration, /is_synthetic_demo boolean not null default false/);
  assert.match(
    migration,
    /eligibility\.eligible and not sp\.is_synthetic_demo/,
  );
  assert.match(
    migration,
    /before insert or update of source_id on public\.social_copy_subscriptions/,
  );
  assert.match(migration, /Synthetic demo traders cannot be copied/);
  assert.match(demoSeed, /is_synthetic_demo: true/);
  assert.match(demoSeed, /is_synthetic: true/);
});

test("synthetic participation is default-off and permanently routed away from brokers", () => {
  assert.match(fullFlowMigration, /allow_synthetic_participants boolean not null default false/);
  assert.match(fullFlowMigration, /execution_path.*synthetic_simulation/s);
  assert.match(fullFlowMigration, /Synthetic Social Trading participants are disabled in this environment/);
  assert.match(demoSeed, /is_synthetic_demo: true/);
  assert.match(demoSeed, /is_synthetic: true/);
  assert.match(demoSeed, /SOCIAL_COPY_PREVIEW_SYNTHETIC_ENABLED/);
});

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const wizard = readFileSync(
  new URL("../pages/dashboard/ProviderApplyPage.tsx", import.meta.url),
  "utf8",
);

test("provider onboarding is wired into routes, the directory and the account snapshot", () => {
  assert.match(app, /path="\/p\/:slug"/);
  assert.match(app, /path="\/social-trading\/provider"/);
  assert.match(app, /path="\/social-trading\/:traderId"/);
  // The directory lists approved providers and shows the server snapshot, not browser state.
  assert.match(page, /trader\.providerStatus !== 'approved'/);
  assert.match(page, /AccountKindBadge/);
  assert.match(page, /formatAccountAmount\(trader\.previewBalance, trader\.accountCurrency\)/);
  assert.match(previewHook, /previewBalance: profile\.balance/);
  assert.doesNotMatch(page, /localStorage|COPY_PRICE_STORAGE_KEY/);
});

test("the provider wizard persists drafts server-side and submits for admin review", () => {
  assert.match(wizard, /useProviderApplication\(\)/);
  assert.match(wizard, /validateProviderStep/);
  assert.match(wizard, /Submit application/);
  assert.doesNotMatch(wizard, /localStorage|sessionStorage/);
  const hook = readFileSync(new URL("../hooks/useProviderApplication.ts", import.meta.url), "utf8");
  assert.match(hook, /saveProviderDraft\(supabase/);
  assert.match(hook, /submitProviderApplication\(supabase/);
});

test("the public provider page reads only the slug-gated public RPCs and carries the visitor into the copy flow", () => {
  const publicPage = readFileSync(new URL("../pages/social/ProviderPublicProfilePage.tsx", import.meta.url), "utf8");
  const publicLib = readFileSync(new URL("../lib/providerPublicProfile.ts", import.meta.url), "utf8");
  assert.match(publicLib, /rpc\('get_provider_public_performance'/);
  assert.match(publicLib, /rpc\('get_provider_public_trade_history'/);
  assert.doesNotMatch(publicLib + publicPage, /get_social_provider_performance|get_social_source_trade_history|get_social_trade_history\b/);
  assert.match(publicPage, /stashPostAuthRedirect\(landing\)/);
  assert.match(publicPage, /providerCopyLandingPath\(profile\.profileUserId\)/);
  assert.match(publicPage, /Sign up to copy/);
  assert.match(page, /profileParams\.get\('copy'\) === '1'/);
  assert.match(page, /consumePostAuthRedirect\(\)/);
});

test("the marketing host serves /p/:slug and hands auth off to the app with a next path", () => {
  const marketing = readFileSync(new URL("../MarketingApp.tsx", import.meta.url), "utf8");
  assert.match(marketing, /path="\/p\/:slug" element=\{<ProviderPublicProfilePage \/>\}/);
  const publicPage = readFileSync(new URL("../pages/social/ProviderPublicProfilePage.tsx", import.meta.url), "utf8");
  assert.match(publicPage, /withQuery\(appUrl\(path\), \{ next: landing \}\)/);
  for (const file of ["AuthPage", "SignupPage"]) {
    const auth = readFileSync(new URL(`../pages/auth/${file}.tsx`, import.meta.url), "utf8");
    assert.match(auth, /capturePostAuthRedirectFromUrl\(/);
  }
});

test("deposits come from server-written account totals, never from browser-supplied values", () => {
  const edge = readFileSync(new URL("../../supabase/functions/mtapi-broker/index.ts", import.meta.url), "utf8");
  assert.match(edge, /fetchCashflowTotals\(/);
  assert.match(edge, /cashflowSyncDue\(/);
  const ownView = readFileSync(new URL("../hooks/useOwnSocialAccountView.ts", import.meta.url), "utf8");
  assert.match(ownView, /account\.total_deposits \?\? account\.performance_baseline_balance/);
  const select = readFileSync(new URL("../lib/brokerAccountSelect.ts", import.meta.url), "utf8");
  assert.match(select, /'total_deposits'/);
});
