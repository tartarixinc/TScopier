/**
 * confirm-checkout - sync local subscriptions from Stripe after Checkout success.
 * Self-contained (no shared imports) so it can be deployed as a single file.
 *
 * Auth: user JWT.
 * Body: { session_id?: string }
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

type RecordStringMap = { [k: string]: string };

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

type PriceIds = {
  basic: string[];
  advanced: string[];
  extraAccount: string[];
};

function priceIdsFromEnv(): PriceIds {
  const ids = (key: string) => String(Deno.env.get(key) ?? "").trim();
  return {
    basic: [ids("STRIPE_BASIC_PRICE_ID"), ids("STRIPE_BASIC_ANNUAL_PRICE_ID")].filter(Boolean),
    advanced: [ids("STRIPE_ADVANCED_PRICE_ID"), ids("STRIPE_ADVANCED_ANNUAL_PRICE_ID")].filter(
      Boolean,
    ),
    extraAccount: [
      ids("STRIPE_EXTRA_ACCOUNT_PRICE_ID"),
      ids("STRIPE_EXTRA_ACCOUNT_ANNUAL_PRICE_ID"),
    ].filter(Boolean),
  };
}

function parsePlan(subscription: Stripe.Subscription, priceIds: PriceIds) {
  let plan: "basic" | "advanced" = "basic";
  let extraAccounts = 0;
  let sawKnownPlanPrice = false;
  for (const item of subscription.items?.data ?? []) {
    const priceId = typeof item.price === "string" ? item.price : item.price?.id ?? "";
    const qty = Math.max(0, Number(item.quantity ?? 0) || 0);
    if (priceIds.advanced.includes(priceId)) {
      plan = "advanced";
      sawKnownPlanPrice = true;
      continue;
    }
    if (priceIds.basic.includes(priceId)) {
      if (plan !== "advanced") plan = "basic";
      sawKnownPlanPrice = true;
      continue;
    }
    if (priceIds.extraAccount.includes(priceId)) extraAccounts += qty;
  }
  const metaPlan = String(subscription.metadata?.plan ?? "").toLowerCase();
  if (!sawKnownPlanPrice) {
    if (metaPlan === "advanced" || metaPlan === "basic") plan = metaPlan;
  } else if (metaPlan === "advanced") {
    plan = "advanced";
  }
  const metaExtra = Number(subscription.metadata?.extra_accounts ?? NaN);
  if (Number.isFinite(metaExtra) && metaExtra >= 0) {
    extraAccounts = Math.min(95, Math.max(extraAccounts, Math.floor(metaExtra)));
  }
  return { plan, extraAccounts };
}

function mapStatus(status: Stripe.Subscription.Status): string {
  const statusMap: RecordStringMap = {
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

function rowFromSub(
  subscription: Stripe.Subscription,
  userId: string,
  customerId: string,
  priceIds: PriceIds,
) {
  const { plan, extraAccounts } = parsePlan(subscription, priceIds);
  return {
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan,
    status: mapStatus(subscription.status),
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

function pickBest(
  subscriptions: Stripe.Subscription[],
  priceIds: PriceIds,
): Stripe.Subscription | null {
  const ok = ["active", "trialing", "past_due"];
  const candidates = subscriptions.filter((sub) => ok.includes(mapStatus(sub.status)));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ap = parsePlan(a, priceIds);
    const bp = parsePlan(b, priceIds);
    const planDiff = (bp.plan === "advanced" ? 2 : 1) - (ap.plan === "advanced" ? 2 : 1);
    if (planDiff !== 0) return planDiff;
    const extraDiff = bp.extraAccounts - ap.extraAccounts;
    if (extraDiff !== 0) return extraDiff;
    return (b.created ?? 0) - (a.created ?? 0);
  });
  return candidates[0] ?? null;
}

async function resolveCustomerId(
  stripe: Stripe,
  user: { id: string; email?: string | null },
  sessionId: string | null,
) {
  if (sessionId) {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const metaUser = String(session.metadata?.supabase_user_id ?? "").trim();
    if (metaUser && metaUser !== user.id) {
      return { error: bad(403, "Checkout session does not belong to this user") };
    }
    if (
      session.status !== "complete" &&
      session.payment_status !== "paid" &&
      session.payment_status !== "no_payment_required"
    ) {
      return { error: bad(409, "Checkout session is not complete") };
    }
    const customerId =
      typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
    if (customerId) return { customerId };
  }

  try {
    const found = await stripe.customers.search({
      query: `metadata['supabase_user_id']:'${user.id}'`,
      limit: 5,
    });
    if (found.data[0]?.id) return { customerId: found.data[0].id };
  } catch {
    // fall through
  }

  const email = String(user.email ?? "").trim();
  if (!email) return { error: bad(404, "No Stripe customer found for this user") };
  const listed = await stripe.customers.list({ email, limit: 20 });
  const match =
    listed.data.find((c) => String(c.metadata?.supabase_user_id ?? "") === user.id) ??
    listed.data[0];
  if (!match?.id) return { error: bad(404, "No Stripe customer found for this user") };
  return { customerId: match.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return bad(405, "Method not allowed");

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return bad(500, "Stripe not configured");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
  const priceIds = priceIdsFromEnv();

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return bad(401, "Unauthorized");

  const { data: authData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !authData.user) return bad(401, "Unauthorized");
  const user = authData.user;

  const body = await req.json().catch(() => ({} as { [k: string]: unknown }));
  const sessionId = String(body.session_id ?? "").trim() || null;

  let customerId: string;
  try {
    const resolved = await resolveCustomerId(stripe, user, sessionId);
    if ("error" in resolved) return resolved.error;
    customerId = resolved.customerId;
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : "Failed to resolve Stripe customer");
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) {
      const metaUser = String(customer.metadata?.supabase_user_id ?? "").trim();
      if (metaUser !== user.id) {
        await stripe.customers.update(customerId, {
          metadata: { ...customer.metadata, supabase_user_id: user.id },
        });
      }
    }
  } catch {
    // non-fatal
  }

  const listed = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price"],
  });
  const best = pickBest(listed.data, priceIds);
  if (!best) {
    await supabase.from("subscriptions").upsert(
      {
        user_id: user.id,
        stripe_customer_id: customerId,
        plan: "basic",
        status: "incomplete",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id", ignoreDuplicates: false },
    );
    return Response.json(
      { ok: false, entitlement: null, note: "No active Stripe subscription yet" },
      { status: 202, headers: corsHeaders },
    );
  }

  const row = rowFromSub(best, user.id, customerId, priceIds);
  const { error: upErr } = await supabase
    .from("subscriptions")
    .upsert(row, { onConflict: "user_id", ignoreDuplicates: false });
  if (upErr) return bad(500, upErr.message);

  const active = row.status === "active" || row.status === "trialing";
  if (active) {
    await supabase
      .from("user_profiles")
      .update({ copier_paused: false, copier_pause_reason: null })
      .eq("user_id", user.id);
  } else {
    // pickBest only returns active/trialing/past_due, so non-active here means
    // the first payment has not gone through yet.
    await supabase
      .from("user_profiles")
      .update({ copier_paused: true, copier_pause_reason: "payment_failed" })
      .eq("user_id", user.id);
    await supabase.from("worker_session_leases").delete().eq("user_id", user.id);
  }

  return Response.json({ ok: true, entitlement: row }, { headers: corsHeaders });
});
