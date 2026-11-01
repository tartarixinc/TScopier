import type Stripe from "npm:stripe@17";
import type { createClient } from "npm:@supabase/supabase-js@2";

type SupabaseClient = ReturnType<typeof createClient>;

/** Service period the customer paid for — from subscription line items, not the invoice accrual window. */
export function resolveInvoiceServicePeriod(
  invoice: Stripe.Invoice,
): { periodStart: string | null; periodEnd: string | null } {
  const lines = invoice.lines?.data ?? [];
  const subscriptionLines = lines.filter((line) =>
    line.type === "subscription" || (line.subscription != null && line.proration !== true)
  );
  const candidates = subscriptionLines.length > 0 ? subscriptionLines : lines;

  let start: number | null = null;
  let end: number | null = null;
  for (const line of candidates) {
    const ps = line.period?.start;
    const pe = line.period?.end;
    if (ps == null || pe == null) continue;
    if (start == null || ps < start) start = ps;
    if (end == null || pe > end) end = pe;
  }
  if (start == null || end == null) {
    start = invoice.period_start ?? null;
    end = invoice.period_end ?? null;
  }
  return {
    periodStart: start != null ? new Date(start * 1000).toISOString() : null,
    periodEnd: end != null ? new Date(end * 1000).toISOString() : null,
  };
}

function paymentStatus(amountPaidCents: number, amountRefundedCents: number): "paid" | "partial_refund" | "refunded" {
  if (amountRefundedCents <= 0) return "paid";
  if (amountRefundedCents >= amountPaidCents) return "refunded";
  return "partial_refund";
}

/**
 * Insert or update the local payment-history row for one Stripe invoice.
 *
 * amountRefundedCents semantics:
 *   - omitted (webhook invoice.paid path): amount_refunded_cents and status are
 *     left OUT of the payload entirely. A fresh insert uses the column defaults
 *     (0 / 'paid'); on conflict PostgREST only sets the provided columns, so an
 *     existing refund state can never be flipped back by an out-of-order or
 *     re-delivered invoice.paid. No read-modify-write, no race.
 *   - provided (billing-backfill, from charge.amount_refunded): trusted as the
 *     source of truth from Stripe and written explicitly.
 * refunded_at is never touched here so a later re-sync cannot wipe the
 * timestamp written by a charge.refunded event.
 */
export async function upsertInvoicePaymentFromStripe(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  userId: string,
  amountRefundedCents?: number,
): Promise<void> {
  if (!invoice.id) return;
  const amountPaidCents = Number(invoice.amount_paid ?? 0);
  if (amountPaidCents <= 0) return;

  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  const paidAt = invoice.status_transitions?.paid_at ?? null;
  const period = resolveInvoiceServicePeriod(invoice);

  const payload: Record<string, unknown> = {
    user_id: userId,
    stripe_invoice_id: invoice.id,
    stripe_subscription_id: subscriptionId,
    amount_paid_cents: amountPaidCents,
    currency: String(invoice.currency ?? "usd"),
    paid_at: paidAt != null ? new Date(paidAt * 1000).toISOString() : null,
    period_start: period.periodStart,
    period_end: period.periodEnd,
    updated_at: new Date().toISOString(),
  };
  if (amountRefundedCents !== undefined) {
    payload.amount_refunded_cents = amountRefundedCents;
    payload.status = paymentStatus(amountPaidCents, amountRefundedCents);
  }

  const { error } = await supabase
    .from("invoice_payments")
    .upsert(payload, { onConflict: "stripe_invoice_id", ignoreDuplicates: false });
  if (error) {
    console.warn(
      `[invoicePayments] upsert failed for invoice ${invoice.id}: ${error.message}`,
    );
  }
}

/** Apply a charge.refunded webhook to the local payment-history row, if it exists. */
export async function markInvoicePaymentRefunded(
  supabase: SupabaseClient,
  invoiceId: string | null,
  charge: Stripe.Charge,
): Promise<void> {
  if (!invoiceId) return;

  const { data: row } = await supabase
    .from("invoice_payments")
    .select("amount_paid_cents")
    .eq("stripe_invoice_id", invoiceId)
    .maybeSingle();
  if (!row) return;

  const amountRefundedCents = Number(charge.amount_refunded ?? 0);
  const { error } = await supabase
    .from("invoice_payments")
    .update({
      status: paymentStatus(Number(row.amount_paid_cents ?? 0), amountRefundedCents),
      amount_refunded_cents: amountRefundedCents,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_invoice_id", invoiceId);
  if (error) {
    console.warn(
      `[invoicePayments] refund update failed for invoice ${invoiceId}: ${error.message}`,
    );
    return;
  }
  // Keep the first refund timestamp: later partial/full refunds do not move it.
  await supabase
    .from("invoice_payments")
    .update({ refunded_at: new Date().toISOString() })
    .eq("stripe_invoice_id", invoiceId)
    .is("refunded_at", null);
}
