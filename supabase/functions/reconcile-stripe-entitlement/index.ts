/**
 * reconcile-stripe-entitlement — recompute local subscriptions row from ALL
 * Stripe subscriptions on the customer (fixes Basic overwriting Advanced).
 *
 * Auth: service role Bearer OR authenticated admin.
 * Body: { user_id?: string, stripe_customer_id?: string }
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import {
  stripePriceIdsFromEnv,
  entitlementRowFromStripeCustomer,
} from "../_shared/stripeSubscriptionSync.ts";
import {
  isSubscriptionActive,
  loadUserIsAdmin,
  revokeCopierAccessOnSubscriptionEnd,
  restoreCopierAccessOnSubscriptionActive,
} from "../_shared/subscriptionAccess.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
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
  const priceIds = stripePriceIdsFromEnv(Deno.env);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return bad(401, "Unauthorized");

  const internalToken = (Deno.env.get("WORKER_INTERNAL_TOKEN") ?? "").trim();
  const isService = token === serviceKey || (internalToken.length > 0 && token === internalToken);
  if (!isService) {
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData.user) return bad(401, "Unauthorized");
    if (!(await loadUserIsAdmin(supabase, authData.user.id))) {
      return bad(403, "Admin only");
    }
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  let userId = String(body.user_id ?? "").trim();
  let customerId = String(body.stripe_customer_id ?? "").trim();

  if (!userId && !customerId) {
    return bad(400, "user_id or stripe_customer_id required");
  }

  if (!customerId || !userId) {
    let q = supabase.from("subscriptions").select("user_id, stripe_customer_id");
    if (userId) q = q.eq("user_id", userId);
    else q = q.eq("stripe_customer_id", customerId);
    const { data, error } = await q.maybeSingle();
    if (error) return bad(500, error.message);
    if (!data) return bad(404, "No local subscription row found");
    userId = data.user_id;
    customerId = data.stripe_customer_id;
  }

  const row = await entitlementRowFromStripeCustomer(stripe, userId, customerId, priceIds);
  if (!row) {
    await supabase
      .from("subscriptions")
      .update({
        status: "canceled",
        canceled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
    return Response.json(
      { ok: true, entitlement: null, note: "No active Stripe subscriptions; marked canceled" },
      { headers: corsHeaders },
    );
  }

  const { error: upErr } = await supabase
    .from("subscriptions")
    .upsert(row, { onConflict: "user_id", ignoreDuplicates: false });
  if (upErr) return bad(500, upErr.message);

  if (isSubscriptionActive(row.status, row.trial_ends_at)) {
    await restoreCopierAccessOnSubscriptionActive(supabase, userId);
  } else {
    await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
  }

  return Response.json({ ok: true, entitlement: row }, { headers: corsHeaders });
});
