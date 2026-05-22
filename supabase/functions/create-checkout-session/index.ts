import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      return new Response(
        JSON.stringify({ error: "Stripe not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { plan, interval, extraAccounts, successUrl, cancelUrl } = await req.json();

    if (!plan || !["basic", "advanced"].includes(plan)) {
      return new Response(
        JSON.stringify({ error: "Invalid plan" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const billingInterval = interval === "annual" ? "annual" : "monthly";

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

    // Monthly price IDs
    const basicPriceId = Deno.env.get("STRIPE_BASIC_PRICE_ID")!;
    const advancedPriceId = Deno.env.get("STRIPE_ADVANCED_PRICE_ID")!;
    const extraAccountPriceId = Deno.env.get("STRIPE_EXTRA_ACCOUNT_PRICE_ID")!;

    // Annual price IDs (20% discount)
    const basicAnnualPriceId = Deno.env.get("STRIPE_BASIC_ANNUAL_PRICE_ID")!;
    const advancedAnnualPriceId = Deno.env.get("STRIPE_ADVANCED_ANNUAL_PRICE_ID")!;
    const extraAccountAnnualPriceId = Deno.env.get("STRIPE_EXTRA_ACCOUNT_ANNUAL_PRICE_ID")!;

    // Find or create Stripe customer
    const { data: existingSub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = existingSub?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    // Build line items based on plan and interval
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    if (plan === "basic") {
      lineItems.push({
        price: billingInterval === "annual" ? basicAnnualPriceId : basicPriceId,
        quantity: 1,
      });
    } else {
      lineItems.push({
        price: billingInterval === "annual" ? advancedAnnualPriceId : advancedPriceId,
        quantity: 1,
      });
      const extra = Math.max(0, Math.min(95, Number(extraAccounts) || 0));
      if (extra > 0) {
        lineItems.push({
          price: billingInterval === "annual" ? extraAccountAnnualPriceId : extraAccountPriceId,
          quantity: extra,
        });
      }
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: "subscription",
      line_items: lineItems,
      success_url: successUrl || `${req.headers.get("origin")}/dashboard?checkout=success`,
      cancel_url: cancelUrl || `${req.headers.get("origin")}/pricing`,
      metadata: {
        supabase_user_id: user.id,
        plan,
        interval: billingInterval,
        extra_accounts: String(extraAccounts || 0),
      },
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
          plan,
          interval: billingInterval,
          extra_accounts: String(extraAccounts || 0),
        },
      },
    };

    // Advanced plan gets a 10-day free trial
    if (plan === "advanced") {
      sessionParams.subscription_data!.trial_period_days = 10;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
