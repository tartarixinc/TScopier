import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17";

export function mapSocialCopyBillingStatus(
  status: Stripe.Subscription.Status,
): "incomplete" | "active" | "past_due" | "canceled" {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "incomplete";
  }
}

export function isSocialCopyKind(meta: Record<string, string> | null | undefined): boolean {
  return meta?.kind === "social_copy";
}

export async function upsertSocialCopyBillingFromSubscription(
  supabase: SupabaseClient,
  subscription: Stripe.Subscription,
  overrides?: {
    payerUserId?: string | null;
    providerUserId?: string | null;
    walletLedgerId?: string | null;
    customerId?: string | null;
  },
): Promise<{ payerUserId: string; providerUserId: string; status: string } | null> {
  const payerUserId = overrides?.payerUserId ??
    subscription.metadata?.payer_user_id ??
    null;
  const providerUserId = overrides?.providerUserId ??
    subscription.metadata?.provider_user_id ??
    null;
  if (!payerUserId || !providerUserId) return null;

  const priceId = subscription.items.data[0]?.price?.id ?? null;
  const customerId = overrides?.customerId ??
    (typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id ?? null);
  const walletLedgerId = overrides?.walletLedgerId ??
    (subscription.metadata?.wallet_ledger_id || null);
  const status = mapSocialCopyBillingStatus(subscription.status);
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  await supabase.from("social_copy_billing").upsert(
    {
      payer_user_id: payerUserId,
      provider_user_id: providerUserId,
      status,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      wallet_ledger_id: walletLedgerId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "payer_user_id,provider_user_id" },
  );

  return { payerUserId, providerUserId, status };
}

export async function settleSocialCopyLedgerFromInvoice(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  payerUserId: string,
  providerUserId: string,
): Promise<void> {
  if (!invoice.id) return;
  const amountPaid = Number(invoice.amount_paid ?? 0);
  if (amountPaid <= 0) return;

  const paymentIntentId = typeof invoice.payment_intent === "string"
    ? invoice.payment_intent
    : invoice.payment_intent?.id ?? null;

  const { data: byInvoice } = await supabase
    .from("wallet_ledger")
    .select("id, status")
    .eq("stripe_invoice_id", invoice.id)
    .maybeSingle();
  if (byInvoice?.status === "paid") return;

  let ledgerId = byInvoice?.id ?? null;
  if (!ledgerId) {
    const { data: pending } = await supabase
      .from("wallet_ledger")
      .select("id")
      .eq("payer_user_id", payerUserId)
      .eq("provider_user_id", providerUserId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    ledgerId = pending?.id ?? null;
  }

  if (!ledgerId) {
    const { data: inserted, error } = await supabase
      .from("wallet_ledger")
      .insert({
        payer_user_id: payerUserId,
        provider_user_id: providerUserId,
        amount_cents: amountPaid,
        currency: String(invoice.currency ?? "usd"),
        status: "paid",
        description: `Copy subscription · invoice ${invoice.id}`,
        stripe_invoice_id: invoice.id,
        stripe_payment_intent_id: paymentIntentId,
      })
      .select("id")
      .single();
    if (error) {
      console.warn(`[stripe-webhook] social copy ledger insert failed: ${error.message}`);
      return;
    }
    ledgerId = inserted.id;
  } else {
    await supabase
      .from("wallet_ledger")
      .update({
        status: "paid",
        amount_cents: amountPaid,
        stripe_invoice_id: invoice.id,
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq("id", ledgerId)
      .eq("status", "pending");
  }

  await supabase.from("user_wallets").upsert(
    { user_id: providerUserId },
    { onConflict: "user_id", ignoreDuplicates: true },
  );

  const { data: wallet } = await supabase
    .from("user_wallets")
    .select("pending_cents")
    .eq("user_id", providerUserId)
    .maybeSingle();
  const nextPending = Number(wallet?.pending_cents ?? 0) + amountPaid;
  await supabase
    .from("user_wallets")
    .update({ pending_cents: nextPending })
    .eq("user_id", providerUserId);

  await supabase
    .from("social_copy_billing")
    .update({
      wallet_ledger_id: ledgerId,
      updated_at: new Date().toISOString(),
    })
    .eq("payer_user_id", payerUserId)
    .eq("provider_user_id", providerUserId);
}

export async function pauseSocialCopyForBillingFailure(
  supabase: SupabaseClient,
  payerUserId: string,
  providerUserId: string,
  action: "pause" | "stop" = "pause",
): Promise<void> {
  await supabase.rpc("pause_social_copy_subscriptions_for_billing", {
    p_payer_user_id: payerUserId,
    p_provider_user_id: providerUserId,
    p_action: action,
  });
}
