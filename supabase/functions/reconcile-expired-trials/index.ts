/**
 * reconcile-expired-trials — sync Stripe for DB rows stuck as trialing after trial_ends_at.
 *
 * Cron (hourly) + manual invoke with service-role Authorization.
 * Upserts subscription from Stripe and revokes copier access when no longer active.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import {
  stripePriceIdsFromEnv,
  subscriptionRowFromStripe,
} from "../_shared/stripeSubscriptionSync.ts";
import {
  isSubscriptionActive,
  revokeCopierAccessOnSubscriptionEnd,
} from "../_shared/subscriptionAccess.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_ROWS = 50;

function isServiceRoleRequest(req: Request, serviceRoleKey: string): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const apikey = (req.headers.get("apikey") ?? "").trim();
  return bearer === serviceRoleKey || apikey === serviceRoleKey;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!isServiceRoleRequest(req, serviceRoleKey)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
  const priceIds = stripePriceIdsFromEnv(Deno.env);

  const { data: stuck, error: stuckErr } = await supabase
    .from("subscriptions")
    .select(
      "user_id,stripe_subscription_id,stripe_customer_id,status,trial_ends_at",
    )
    .eq("status", "trialing")
    .not("trial_ends_at", "is", null)
    .lt("trial_ends_at", new Date().toISOString())
    .not("stripe_subscription_id", "is", null)
    .limit(MAX_ROWS);

  if (stuckErr) {
    return new Response(JSON.stringify({ error: stuckErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results: Array<Record<string, unknown>> = [];
  let synced = 0;
  let revoked = 0;
  let failed = 0;

  for (const row of stuck ?? []) {
    const userId = String(row.user_id ?? "");
    const subId = String(row.stripe_subscription_id ?? "");
    if (!userId || !subId) {
      failed += 1;
      results.push({ user_id: userId, ok: false, reason: "missing_ids" });
      continue;
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subId, {
        expand: ["items.data.price"],
      });
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id ?? row.stripe_customer_id ?? null;
      if (!customerId) {
        failed += 1;
        results.push({ user_id: userId, ok: false, reason: "no_customer" });
        continue;
      }

      const dbRow = subscriptionRowFromStripe(
        subscription,
        userId,
        customerId,
        priceIds,
      );
      const { error: upsertErr } = await supabase
        .from("subscriptions")
        .upsert(dbRow, { onConflict: "user_id", ignoreDuplicates: false });
      if (upsertErr) {
        failed += 1;
        results.push({
          user_id: userId,
          ok: false,
          reason: upsertErr.message,
          stripe_status: subscription.status,
        });
        continue;
      }

      synced += 1;
      const active = isSubscriptionActive(dbRow.status, dbRow.trial_ends_at);
      if (!active) {
        await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
        revoked += 1;
      }
      results.push({
        user_id: userId,
        ok: true,
        stripe_status: subscription.status,
        db_status: dbRow.status,
        trial_ends_at: dbRow.trial_ends_at,
        revoked: !active,
      });
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      // Subscription deleted in Stripe — mark canceled locally.
      if (/No such subscription/i.test(msg) || /resource_missing/i.test(msg)) {
        const { error: updateErr } = await supabase
          .from("subscriptions")
          .update({
            status: "canceled",
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
        if (!updateErr) {
          await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
          synced += 1;
          revoked += 1;
          failed -= 1;
          results.push({
            user_id: userId,
            ok: true,
            stripe_status: "missing",
            db_status: "canceled",
            revoked: true,
          });
          continue;
        }
      }
      results.push({ user_id: userId, ok: false, reason: msg });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      candidates: stuck?.length ?? 0,
      synced,
      revoked,
      failed,
      results,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
