import type Stripe from "npm:stripe@17";

export type SubscriptionPlan = "basic" | "advanced";

export function stripePriceIdsFromEnv(env: { get(name: string): string | undefined }): {
  basic: Set<string>;
  advanced: Set<string>;
  extraAccount: Set<string>;
} {
  const ids = (key: string) => String(env.get(key) ?? "").trim();
  const basic = new Set(
    [ids("STRIPE_BASIC_PRICE_ID"), ids("STRIPE_BASIC_ANNUAL_PRICE_ID")].filter(Boolean),
  );
  const advanced = new Set(
    [ids("STRIPE_ADVANCED_PRICE_ID"), ids("STRIPE_ADVANCED_ANNUAL_PRICE_ID")].filter(Boolean),
  );
  const extraAccount = new Set(
    [ids("STRIPE_EXTRA_ACCOUNT_PRICE_ID"), ids("STRIPE_EXTRA_ACCOUNT_ANNUAL_PRICE_ID")].filter(
      Boolean,
    ),
  );
  return { basic, advanced, extraAccount };
}

/** Derive plan + extra account quantity from Stripe subscription line items. */
export function parsePlanFromStripeSubscription(
  subscription: Stripe.Subscription,
  priceIds: ReturnType<typeof stripePriceIdsFromEnv>,
): { plan: SubscriptionPlan; extraAccounts: number } {
  let plan: SubscriptionPlan = "basic";
  let extraAccounts = 0;
  let sawKnownPlanPrice = false;

  for (const item of subscription.items?.data ?? []) {
    const priceId = typeof item.price === "string" ? item.price : item.price?.id ?? "";
    const qty = Math.max(0, Number(item.quantity ?? 0) || 0);
    if (priceIds.advanced.has(priceId)) {
      plan = "advanced";
      sawKnownPlanPrice = true;
      continue;
    }
    if (priceIds.basic.has(priceId)) {
      // Never downgrade an Advanced line item already seen on this subscription.
      if (plan !== "advanced") plan = "basic";
      sawKnownPlanPrice = true;
      continue;
    }
    if (priceIds.extraAccount.has(priceId)) {
      extraAccounts += qty;
    }
  }

  const metaPlan = String(subscription.metadata?.plan ?? "").toLowerCase();
  // Metadata may be stale/wrong across overlapping checkouts. Prefer line items when present.
  // Only allow metadata to *upgrade* to advanced, never to downgrade away from line-item Advanced.
  if (!sawKnownPlanPrice) {
    if (metaPlan === "advanced" || metaPlan === "basic") plan = metaPlan;
  } else if (metaPlan === "advanced") {
    plan = "advanced";
  }

  const metaExtra = Number(subscription.metadata?.extra_accounts ?? NaN);
  if (Number.isFinite(metaExtra) && metaExtra >= 0) {
    // Prefer the higher of line-item qty vs metadata (checkout often sets metadata).
    extraAccounts = Math.min(95, Math.max(extraAccounts, Math.floor(metaExtra)));
  }

  return { plan, extraAccounts };
}

export function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status): string {
  const statusMap: Record<string, string> = {
    active: "active",
    trialing: "trialing",
    canceled: "canceled",
    past_due: "past_due",
    incomplete: "incomplete",
    incomplete_expired: "canceled",
    unpaid: "past_due",
    paused: "canceled",
  };
  return statusMap[status] || "incomplete";
}

export function subscriptionRowFromStripe(
  subscription: Stripe.Subscription,
  userId: string,
  customerId: string,
  priceIds: ReturnType<typeof stripePriceIdsFromEnv>,
) {
  const { plan, extraAccounts } = parsePlanFromStripeSubscription(subscription, priceIds);
  return {
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan,
    status: mapStripeSubscriptionStatus(subscription.status),
    extra_accounts: extraAccounts,
    trial_ends_at: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
}

const ENTITLEMENT_STATUSES = new Set(["active", "trialing", "past_due"]);

function planRank(plan: SubscriptionPlan): number {
  return plan === "advanced" ? 2 : 1;
}

function statusRank(status: string): number {
  if (status === "active" || status === "trialing") return 2;
  if (status === "past_due") return 1;
  return 0;
}

/**
 * When a Stripe customer has multiple subscriptions (e.g. leftover Basic + Advanced),
 * pick the one that should drive our single local entitlement row.
 */
export function pickBestStripeSubscription(
  subscriptions: Stripe.Subscription[],
  priceIds: ReturnType<typeof stripePriceIdsFromEnv>,
): Stripe.Subscription | null {
  const candidates = subscriptions.filter((sub) => {
    const mapped = mapStripeSubscriptionStatus(sub.status);
    return ENTITLEMENT_STATUSES.has(mapped);
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aParsed = parsePlanFromStripeSubscription(a, priceIds);
    const bParsed = parsePlanFromStripeSubscription(b, priceIds);
    const planDiff = planRank(bParsed.plan) - planRank(aParsed.plan);
    if (planDiff !== 0) return planDiff;
    const extraDiff = bParsed.extraAccounts - aParsed.extraAccounts;
    if (extraDiff !== 0) return extraDiff;
    const statusDiff =
      statusRank(mapStripeSubscriptionStatus(b.status)) -
      statusRank(mapStripeSubscriptionStatus(a.status));
    if (statusDiff !== 0) return statusDiff;
    return (b.created ?? 0) - (a.created ?? 0);
  });

  return candidates[0] ?? null;
}

export type SubscriptionEntitlementRow = ReturnType<typeof subscriptionRowFromStripe>;

/**
 * List all Stripe subscriptions for a customer and build the local entitlement row
 * from the best active/trialing/past_due subscription. Returns null when none qualify
 * (caller should mark the local row canceled).
 */
export async function entitlementRowFromStripeCustomer(
  stripe: Stripe,
  userId: string,
  customerId: string,
  priceIds: ReturnType<typeof stripePriceIdsFromEnv>,
): Promise<SubscriptionEntitlementRow | null> {
  const listed = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price"],
  });
  const best = pickBestStripeSubscription(listed.data, priceIds);
  if (!best) return null;
  return subscriptionRowFromStripe(best, userId, customerId, priceIds);
}
