import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function bad(status: number, message: string): Response {
  return Response.json(
    { error: message },
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

    const { data: billing, error } = await supabase
      .from("social_copy_billing")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("payer_user_id", user.id)
      .eq("provider_user_id", providerUserId)
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!billing?.stripe_customer_id) {
      return bad(404, "No copy billing found for this provider");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
    const origin = req.headers.get("origin") || Deno.env.get("APP_URL") || "https://app.tscopier.ai";
    const returnUrl = String(body.return_url ?? `${origin}/wallet`).trim();

    const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
      customer: billing.stripe_customer_id,
      return_url: returnUrl,
    };

    if (billing.stripe_subscription_id?.startsWith("sub_")) {
      sessionParams.flow_data = {
        type: "subscription_cancel",
        subscription_cancel: {
          subscription: billing.stripe_subscription_id,
        },
      };
    }

    const portalSession = await stripe.billingPortal.sessions.create(sessionParams);
    return Response.json(
      { url: portalSession.url },
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : "Unknown error");
  }
});
