import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import {
  stripePriceIdsFromEnv,
  mapStripeSubscriptionStatus,
  entitlementRowFromStripeCustomer,
} from "../_shared/stripeSubscriptionSync.ts";

/** Sync local one-row entitlement from *all* Stripe subscriptions on the customer. */
async function upsertEntitlementFromCustomer(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  userId: string,
  customerId: string,
  priceIds: ReturnType<typeof stripePriceIdsFromEnv>,
): Promise<{ plan: string; status: string; extra_accounts: number; trial_ends_at: string | null } | null> {
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
    return null;
  }
  await supabase
    .from("subscriptions")
    .upsert(row, { onConflict: "user_id", ignoreDuplicates: false });
  if (isSubscriptionActive(row.status, row.trial_ends_at)) {
    await restoreCopierAccessOnSubscriptionActive(supabase, userId);
  } else {
    await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
  }
  return row;
}
import {
  isSubscriptionActive,
  revokeCopierAccessOnSubscriptionEnd,
  restoreCopierAccessOnSubscriptionActive,
} from "../_shared/subscriptionAccess.ts";
import { DEFAULT_AFFILIATE_COMMISSION_RATE } from "../_shared/affiliate.ts";
import {
  handleInvoiceDue,
  handleInvoicePaymentIssue,
} from "../_shared/billingPaymentNotification.ts";
import {
  resolveInvoiceServicePeriod,
  upsertInvoicePaymentFromStripe,
  markInvoicePaymentRefunded,
} from "../_shared/invoicePayments.ts";

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

async function accrueInvoiceCommission(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  invoice: Stripe.Invoice,
): Promise<void> {
  if (!invoice.id) return;
  const amountPaid = Number(invoice.amount_paid ?? 0);
  if (amountPaid <= 0) return;
  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  if (!subscriptionId) return;

  const { data: existingRow } = await supabase
    .from("commission_ledger")
    .select("id")
    .eq("stripe_invoice_id", invoice.id)
    .maybeSingle();
  if (existingRow) return;

  const { data: subRow } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  const referredUserId = subRow?.user_id ?? null;
  if (!referredUserId) return;

  const { data: attribution } = await supabase
    .from("referral_attributions")
    .select("affiliate_user_id")
    .eq("referred_user_id", referredUserId)
    .maybeSingle();
  const affiliateUserId = attribution?.affiliate_user_id ?? null;
  if (!affiliateUserId) return;
  const { data: affiliateProfile } = await supabase
    .from("affiliate_profiles")
    .select("stripe_connect_account_id")
    .eq("user_id", affiliateUserId)
    .maybeSingle();

  const commissionCents = Math.round(amountPaid * DEFAULT_AFFILIATE_COMMISSION_RATE);
  if (commissionCents <= 0) return;
  const shouldAutoPayout = Deno.env.get("AFFILIATE_CONNECT_AUTOPAYOUT") === "true" &&
    Boolean(affiliateProfile?.stripe_connect_account_id);
  let status: "pending" | "paid" = "pending";

  if (shouldAutoPayout) {
    try {
      await stripe.transfers.create({
        amount: commissionCents,
        currency: String(invoice.currency ?? "usd"),
        destination: String(affiliateProfile?.stripe_connect_account_id),
        transfer_group: subscriptionId,
        description: `Affiliate commission for invoice ${invoice.id}`,
        metadata: {
          stripe_invoice_id: invoice.id,
          affiliate_user_id: affiliateUserId,
          referred_user_id: referredUserId,
        },
      });
      status = "paid";
    } catch (err) {
      console.warn(
        `[stripe-webhook] affiliate transfer failed for invoice ${invoice.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const period = resolveInvoiceServicePeriod(invoice);
  await supabase
    .from("commission_ledger")
    .insert({
      affiliate_user_id: affiliateUserId,
      referred_user_id: referredUserId,
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      invoice_amount_cents: amountPaid,
      commission_rate: DEFAULT_AFFILIATE_COMMISSION_RATE,
      commission_cents: commissionCents,
      currency: invoice.currency ?? "usd",
      status,
      period_start: period.periodStart,
      period_end: period.periodEnd,
    });
}

async function reverseInvoiceCommission(
  supabase: ReturnType<typeof createClient>,
  invoiceId: string | null,
): Promise<void> {
  if (!invoiceId) return;
  await supabase
    .from("commission_ledger")
    .update({ status: "reversed" })
    .eq("stripe_invoice_id", invoiceId)
    .in("status", ["pending", "approved", "paid"]);
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
            { expand: ["items.data.price", "default_payment_method"] },
          );

          // Checkout Session subscription_data does not accept payment_settings; set it here
          // so Stripe keeps default_payment_method current for off-session trial renewal.
          const subUpdate: Stripe.SubscriptionUpdateParams = {
            payment_settings: { save_default_payment_method: "on_subscription" },
          };
          if (!subscription.default_payment_method && session.setup_intent) {
            const setupIntentId =
              typeof session.setup_intent === "string"
                ? session.setup_intent
                : session.setup_intent.id;
            const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
            const pm = setupIntent.payment_method;
            const pmId = typeof pm === "string" ? pm : pm?.id;
            if (pmId) subUpdate.default_payment_method = pmId;
          }
          await stripe.subscriptions.update(subscription.id, subUpdate);

          // Reconcile across ALL customer subscriptions so a new Basic checkout
          // cannot overwrite an existing active Advanced entitlement.
          await upsertEntitlementFromCustomer(
            stripe,
            supabase,
            userId,
            customerId,
            priceIds,
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
          await upsertEntitlementFromCustomer(
            stripe,
            supabase,
            userId,
            customerId,
            priceIds,
          );
        } else if (userId) {
          // Fallback when customer id missing: only update this subscription id's mapped fields
          // if it is the one currently stored for the user.
          const mappedStatus = mapStripeSubscriptionStatus(subscription.status);
          const trialEndsAt = subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString()
            : null;
          const { data: current } = await supabase
            .from("subscriptions")
            .select("stripe_subscription_id")
            .eq("user_id", userId)
            .maybeSingle();
          if (current?.stripe_subscription_id === subscription.id) {
            await supabase
              .from("subscriptions")
              .update({
                status: mappedStatus,
                canceled_at: subscription.canceled_at
                  ? new Date(subscription.canceled_at * 1000).toISOString()
                  : null,
                current_period_end: new Date(
                  subscription.current_period_end * 1000,
                ).toISOString(),
                trial_ends_at: trialEndsAt,
                updated_at: new Date().toISOString(),
              })
              .eq("user_id", userId);
            if (!isSubscriptionActive(mappedStatus, trialEndsAt)) {
              await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
            } else {
              await restoreCopierAccessOnSubscriptionActive(supabase, userId);
            }
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = await resolveUserIdFromSubscription(stripe, subscription, supabase);
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id ?? null;

        if (userId && customerId) {
          // Do not cancel local entitlement just because one of several Stripe
          // subscriptions ended — recompute from whatever is still active.
          await upsertEntitlementFromCustomer(
            stripe,
            supabase,
            userId,
            customerId,
            priceIds,
          );
        } else if (userId) {
          const { data: current } = await supabase
            .from("subscriptions")
            .select("stripe_subscription_id")
            .eq("user_id", userId)
            .maybeSingle();
          if (!current?.stripe_subscription_id || current.stripe_subscription_id === subscription.id) {
            await supabase
              .from("subscriptions")
              .update({
                status: "canceled",
                canceled_at: subscription.canceled_at
                  ? new Date(subscription.canceled_at * 1000).toISOString()
                  : new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("user_id", userId);
            await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
          }
        }
        break;
      }

      case "invoice.finalized": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoiceDue(stripe, supabase, invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentIssue(stripe, supabase, invoice, "failed");
        break;
      }

      case "invoice.payment_action_required": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentIssue(stripe, supabase, invoice, "action_required");
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id ?? null;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price"],
          });
          const userId = await resolveUserIdFromSubscription(
            stripe,
            subscription,
            supabase,
          );
          const customerId =
            typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer?.id ?? null;
          if (userId) {
            await upsertInvoicePaymentFromStripe(supabase, invoice, userId);
          }
          if (userId && customerId) {
            await upsertEntitlementFromCustomer(
              stripe,
              supabase,
              userId,
              customerId,
              priceIds,
            );
          } else {
            await supabase
              .from("subscriptions")
              .update({
                status: "active",
                canceled_at: null,
                updated_at: new Date().toISOString(),
              })
              .eq("stripe_subscription_id", subscriptionId);
          }
        }
        await accrueInvoiceCommission(stripe, supabase, invoice);
        break;
      }

      case "invoice.voided": {
        const invoice = event.data.object as Stripe.Invoice;
        await reverseInvoiceCommission(supabase, invoice.id ?? null);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const invoiceId = typeof charge.invoice === "string"
          ? charge.invoice
          : charge.invoice?.id ?? null;
        await reverseInvoiceCommission(supabase, invoiceId);
        await markInvoicePaymentRefunded(supabase, invoiceId, charge);
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
