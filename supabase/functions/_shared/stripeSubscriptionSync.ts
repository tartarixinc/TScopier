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

  for (const item of subscription.items?.data ?? []) {
    const priceId = typeof item.price === "string" ? item.price : item.price?.id ?? "";
    const qty = Math.max(0, Number(item.quantity ?? 0) || 0);
    if (priceIds.advanced.has(priceId)) {
      plan = "advanced";
      continue;
    }
    if (priceIds.basic.has(priceId)) {
      plan = "basic";
      continue;
    }
    if (priceIds.extraAccount.has(priceId)) {
      extraAccounts += qty;
    }
  }

  const metaPlan = String(subscription.metadata?.plan ?? "").toLowerCase();
  if (metaPlan === "advanced" || metaPlan === "basic") {
    plan = metaPlan;
  }
  const metaExtra = Number(subscription.metadata?.extra_accounts ?? NaN);
  if (Number.isFinite(metaExtra) && metaExtra >= 0) {
    extraAccounts = Math.min(95, Math.floor(metaExtra));
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
    updated_at: new Date().toISOString(),
  };
}
