import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function bad(status: number, message: string, code?: string): Response {
  return Response.json(
    { error: message, ...(code ? { code } : {}) },
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return bad(405, "Method not allowed");

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return bad(500, "Stripe not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return bad(401, "Missing authorization");
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return bad(401, "Unauthorized");

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const providerUserId = String(body.provider_user_id ?? "").trim();
    if (!providerUserId) return bad(400, "provider_user_id is required");
    if (providerUserId === user.id) {
      return bad(400, "You cannot subscribe to your own provider profile");
    }

    const { data: provider, error: providerError } = await supabase
      .from("social_profiles")
      .select(
        "user_id, is_listed, provider_status, monthly_copy_price_cents, stripe_connect_account_id, stripe_connect_charges_enabled",
      )
      .eq("user_id", providerUserId)
      .maybeSingle();
    if (providerError) return bad(400, providerError.message);
    if (
      !provider ||
      provider.provider_status !== "approved" ||
      provider.is_listed !== true
    ) {
      return bad(404, "Provider profile is not available", "provider_unavailable");
    }

    const priceCents = Number(provider.monthly_copy_price_cents ?? 0);
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      return bad(400, "This provider is free to copy", "provider_free");
    }
    if (
      !provider.stripe_connect_account_id ||
      provider.stripe_connect_charges_enabled !== true
    ) {
      return bad(
        409,
        "This provider has not finished payout setup yet",
        "provider_payouts_not_ready",
      );
    }

    const { data: existingBilling } = await supabase
      .from("social_copy_billing")
      .select("id, status, stripe_customer_id, stripe_subscription_id, current_period_end")
      .eq("payer_user_id", user.id)
      .eq("provider_user_id", providerUserId)
      .maybeSingle();

    if (
      existingBilling?.status === "active" &&
      existingBilling.current_period_end &&
      new Date(existingBilling.current_period_end).getTime() > Date.now()
    ) {
      return bad(409, "You already have an active copy subscription for this provider", "already_active");
    }

    const { data: nameRow } = await supabase
      .from("user_profiles")
      .select("display_name, username")
      .eq("user_id", providerUserId)
      .maybeSingle();
    const providerName = String(
      nameRow?.display_name?.trim() ||
        nameRow?.username?.trim() ||
        "Provider",
    ).slice(0, 80);

    // Ensure a pending ledger row exists for webhook settlement.
    let walletLedgerId: string | null = null;
    const { data: pendingLedger } = await supabase
      .from("wallet_ledger")
      .select("id")
      .eq("payer_user_id", user.id)
      .eq("provider_user_id", providerUserId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendingLedger?.id) {
      walletLedgerId = pendingLedger.id;
    } else {
      await supabase.from("user_wallets").upsert(
        { user_id: user.id },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
      const { data: inserted, error: ledgerError } = await supabase
        .from("wallet_ledger")
        .insert({
          payer_user_id: user.id,
          provider_user_id: providerUserId,
          amount_cents: priceCents,
          currency: "usd",
          status: "pending",
          description: `Copy subscription · ${providerName}`,
        })
        .select("id")
        .single();
      if (ledgerError) return bad(400, ledgerError.message);
      walletLedgerId = inserted.id;
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    // Prefer an existing social-copy customer, then membership customer, else create.
    let customerId = existingBilling?.stripe_customer_id ?? null;
    if (!customerId) {
      const { data: membership } = await supabase
        .from("subscriptions")
        .select("stripe_customer_id")
        .eq("user_id", user.id)
        .maybeSingle();
      customerId = membership?.stripe_customer_id ?? null;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: {
          supabase_user_id: user.id,
          kind: "social_copy",
        },
      });
      customerId = customer.id;
    }

    await supabase.from("social_copy_billing").upsert(
      {
        payer_user_id: user.id,
        provider_user_id: providerUserId,
        status: existingBilling?.status === "active" ? "active" : "incomplete",
        stripe_customer_id: customerId,
        wallet_ledger_id: walletLedgerId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "payer_user_id,provider_user_id" },
    );

    const origin = req.headers.get("origin") || Deno.env.get("APP_URL") || "https://app.tscopier.ai";
    const successUrl = String(
      body.success_url ??
        `${origin}/social-trading?site=app&social_copy_checkout=success&provider=${providerUserId}&session_id={CHECKOUT_SESSION_ID}`,
    ).trim();
    const cancelUrl = String(
      body.cancel_url ??
        `${origin}/social-trading?site=app&social_copy_checkout=cancel&provider=${providerUserId}`,
    ).trim();
    const successWithSession = successUrl.includes("{CHECKOUT_SESSION_ID}")
      ? successUrl
      : `${successUrl}${successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;

    const feePercentRaw = Number(Deno.env.get("SOCIAL_COPY_APPLICATION_FEE_PERCENT") ?? "0");
    const applicationFeePercent = Number.isFinite(feePercentRaw)
      ? Math.max(0, Math.min(99, feePercentRaw))
      : 0;

    const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: {
        kind: "social_copy",
        payer_user_id: user.id,
        provider_user_id: providerUserId,
        wallet_ledger_id: walletLedgerId ?? "",
      },
      transfer_data: {
        destination: provider.stripe_connect_account_id,
      },
    };
    if (applicationFeePercent > 0) {
      subscriptionData.application_fee_percent = applicationFeePercent;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: priceCents,
            recurring: { interval: "month" },
            product_data: {
              name: `Copy ${providerName}`,
              metadata: {
                kind: "social_copy",
                provider_user_id: providerUserId,
              },
            },
          },
        },
      ],
      success_url: successWithSession,
      cancel_url: cancelUrl,
      metadata: {
        kind: "social_copy",
        payer_user_id: user.id,
        provider_user_id: providerUserId,
        wallet_ledger_id: walletLedgerId ?? "",
      },
      subscription_data: subscriptionData,
    });

    if (!session.url) return bad(500, "Checkout session URL missing");

    return Response.json(
      { url: session.url, wallet_ledger_id: walletLedgerId },
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : "Unknown error");
  }
});
