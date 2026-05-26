import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import {
  stripePriceIdsFromEnv,
  subscriptionRowFromStripe,
  mapStripeSubscriptionStatus,
} from "../_shared/stripeSubscriptionSync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function resolveUserIdFromSubscription(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const metaUserId = subscription.metadata?.supabase_user_id;
  if (metaUserId) return metaUserId;

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id ?? null;
  if (!customerId) return null;

  const customer =
    typeof subscription.customer === "object" && subscription.customer
      ? subscription.customer
      : await stripe.customers.retrieve(customerId);
  if (!customer.deleted && customer.metadata?.supabase_user_id) {
    return customer.metadata.supabase_user_id;
  }

  const { data } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();
  return data?.user_id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY")!;
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const priceIds = stripePriceIdsFromEnv(Deno.env);

    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return new Response(
        JSON.stringify({ error: "Missing stripe-signature header" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Webhook signature verification failed: ${err instanceof Error ? err.message : "unknown"}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: existingEvent } = await supabase
      .from("stripe_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();

    if (existingEvent) {
      return new Response(
        JSON.stringify({ received: true, duplicate: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase
      .from("stripe_events")
      .insert({ event_id: event.id, event_type: event.type });

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.supabase_user_id;
        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

        if (userId && session.subscription && customerId) {
          const subscription = await stripe.subscriptions.retrieve(
            session.subscription as string,
            { expand: ["items.data.price"] },
          );

          await supabase
            .from("subscriptions")
            .upsert(
              subscriptionRowFromStripe(subscription, userId, customerId, priceIds),
              { onConflict: "user_id", ignoreDuplicates: false },
            );
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = await resolveUserIdFromSubscription(stripe, subscription, supabase);
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id ?? null;

        if (userId && customerId) {
          await supabase
            .from("subscriptions")
            .upsert(
              subscriptionRowFromStripe(subscription, userId, customerId, priceIds),
              { onConflict: "user_id", ignoreDuplicates: false },
            );
        } else if (userId) {
          await supabase
            .from("subscriptions")
            .update({
              status: mapStripeSubscriptionStatus(subscription.status),
              current_period_end: new Date(
                subscription.current_period_end * 1000,
              ).toISOString(),
              trial_ends_at: subscription.trial_end
                ? new Date(subscription.trial_end * 1000).toISOString()
                : null,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = await resolveUserIdFromSubscription(stripe, subscription, supabase);

        if (userId) {
          await supabase
            .from("subscriptions")
            .update({
              status: "canceled",
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | null;

        if (subscriptionId) {
          await supabase
            .from("subscriptions")
            .update({
              status: "past_due",
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subscriptionId);
        }
        break;
      }
    }

    return new Response(
      JSON.stringify({ received: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
