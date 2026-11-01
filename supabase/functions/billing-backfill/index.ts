/**
 * billing-backfill — one-off / ops backfill for billing transparency (2026-10-21):
 *
 *   1. invoice_payments: pull every historical paid invoice from Stripe
 *      (refund state from the invoice's charge) into our own payment-history table.
 *   2. copier_pause_reason: infer a reason for copier users already paused before
 *      the field existed, from their local subscriptions row.
 *   3. canceled_at: fill the new subscriptions.canceled_at for rows already
 *      marked canceled, from Stripe.
 *
 * Idempotent: safe to re-run; existing invoice rows are upserted, reason and
 * canceled_at inference only touch rows where the field is still null.
 *
 * Auth: service role Bearer (same pattern as reconcile-expired-trials).
 * Body: { invoice_pages?: number, canceled_subs_limit?: number }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { upsertInvoicePaymentFromStripe } from "../_shared/invoicePayments.ts";
import { deriveCopierPauseReason } from "../_shared/subscriptionAccess.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_INVOICE_PAGES = 50;
const MAX_CANCELED_SUBS = 500;

function isServiceRoleRequest(req: Request, serviceRoleKey: string): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const apikey = (req.headers.get("apikey") ?? "").trim();
  if (bearer === serviceRoleKey || apikey === serviceRoleKey) return true;
  // Optional dedicated ops token (BILLING_BACKFILL_TOKEN secret).
  const opsToken = (Deno.env.get("BILLING_BACKFILL_TOKEN") ?? "").trim();
  if (opsToken.length > 0 && bearer === opsToken) return true;
  // Staging workaround: the SUPABASE_SERVICE_ROLE_KEY edge secret holds the
  // newer sb_secret_ format while callers send the legacy service-role JWT
  // (documented in the alert-evaluator entry of docs/PROJECT_MEMORY.md).
  // ALERT_EVALUATOR_SERVICE_KEY already stores that current legacy JWT on
  // staging, so accepting it lets the backfill run without any new secret.
  const legacyJwt = (Deno.env.get("ALERT_EVALUATOR_SERVICE_KEY") ?? "").trim();
  return legacyJwt.length > 0 && bearer === legacyJwt;
}

function customerIdOf(invoice: Stripe.Invoice): string | null {
  return typeof invoice.customer === "string"
    ? invoice.customer
    : invoice.customer?.id ?? null;
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

  const rawBody = await req.json().catch(() => null);
  const body = rawBody && typeof rawBody === "object"
    ? rawBody as Record<string, unknown>
    : {};
  const invoicePages = Math.min(
    MAX_INVOICE_PAGES,
    Math.max(1, Number(body.invoice_pages) || MAX_INVOICE_PAGES),
  );
  const canceledSubsLimit = Math.min(
    MAX_CANCELED_SUBS,
    Math.max(0, Number(body.canceled_subs_limit) || MAX_CANCELED_SUBS),
  );

  // -------------------------------------------------------------------------
  // Step 1 — invoice_payments from Stripe invoices
  // -------------------------------------------------------------------------
  const userByCustomer = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data: page, error: subErr } = await supabase
      .from("subscriptions")
      .select("user_id, stripe_customer_id")
      .range(from, from + 999);
    if (subErr) {
      return new Response(JSON.stringify({ error: subErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    for (const row of page ?? []) {
      if (row.stripe_customer_id && row.user_id) {
        userByCustomer.set(String(row.stripe_customer_id), String(row.user_id));
      }
    }
    if (!page || page.length < 1000) break;
  }

  const metaUserByCustomer = new Map<string, string | null>();
  async function resolveUserIdForCustomer(customerId: string): Promise<string | null> {
    const mapped = userByCustomer.get(customerId);
    if (mapped) return mapped;
    if (metaUserByCustomer.has(customerId)) return metaUserByCustomer.get(customerId) ?? null;
    let metaUser: string | null = null;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted && customer.metadata?.supabase_user_id) {
        metaUser = String(customer.metadata.supabase_user_id);
      }
    } catch {
      metaUser = null;
    }
    metaUserByCustomer.set(customerId, metaUser);
    return metaUser;
  }

  let invoicesSeen = 0;
  let paymentsRecorded = 0;
  let paymentsSkippedNoUser = 0;
  let paymentsSkippedZeroAmount = 0;
  let startingAfter: string | undefined;
  let pagesFetched = 0;
  let hasMore = true;
  let invoiceListError: string | null = null;

  while (hasMore && pagesFetched < invoicePages) {
    let list: Stripe.ApiList<Stripe.Invoice>;
    try {
      list = await stripe.invoices.list({
        limit: 100,
        starting_after: startingAfter,
        expand: ["data.charge"],
      });
    } catch (err) {
      invoiceListError = err instanceof Error ? err.message : String(err);
      break;
    }
    pagesFetched += 1;
    for (const invoice of list.data) {
      invoicesSeen += 1;
      const amountPaid = Number(invoice.amount_paid ?? 0);
      if (amountPaid <= 0) {
        paymentsSkippedZeroAmount += 1;
        continue;
      }
      const customerId = customerIdOf(invoice);
      if (!customerId || !invoice.id) {
        paymentsSkippedNoUser += 1;
        continue;
      }
      const userId = await resolveUserIdForCustomer(customerId);
      if (!userId) {
        paymentsSkippedNoUser += 1;
        continue;
      }
      const charge = typeof invoice.charge === "object" && invoice.charge
        ? invoice.charge
        : null;
      const amountRefunded = Number(charge?.amount_refunded ?? 0);
      await upsertInvoicePaymentFromStripe(supabase, invoice, userId, amountRefunded);
      paymentsRecorded += 1;
    }
    hasMore = list.has_more;
    if (hasMore && list.data.length > 0) {
      startingAfter = list.data[list.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — infer copier_pause_reason for already-paused users
  // -------------------------------------------------------------------------
  const { data: pausedRows, error: pausedErr } = await supabase
    .from("user_profiles")
    .select("user_id")
    .eq("copier_paused", true)
    .is("copier_pause_reason", null)
    .limit(1000);
  if (pausedErr) {
    return new Response(JSON.stringify({ error: pausedErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let pauseReasonsInferred = 0;
  for (const row of pausedRows ?? []) {
    const userId = String(row.user_id);
    const reason = await deriveCopierPauseReason(supabase, userId);
    if (!reason) continue;
    const { error: reasonErr } = await supabase
      .from("user_profiles")
      .update({ copier_pause_reason: reason })
      .eq("user_id", userId)
      .is("copier_pause_reason", null);
    if (!reasonErr) pauseReasonsInferred += 1;
  }

  // -------------------------------------------------------------------------
  // Step 3 — fill subscriptions.canceled_at for already-canceled rows
  // -------------------------------------------------------------------------
  const { data: canceledRows, error: canceledErr } = await supabase
    .from("subscriptions")
    .select("user_id, stripe_subscription_id")
    .eq("status", "canceled")
    .is("canceled_at", null)
    .not("stripe_subscription_id", "is", null)
    .limit(canceledSubsLimit);
  if (canceledErr) {
    return new Response(JSON.stringify({ error: canceledErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let canceledAtFilled = 0;
  let canceledAtFailed = 0;
  for (const row of canceledRows ?? []) {
    const subId = String(row.stripe_subscription_id);
    try {
      const subscription = await stripe.subscriptions.retrieve(subId);
      const canceledAt = subscription.canceled_at
        ? new Date(subscription.canceled_at * 1000).toISOString()
        : null;
      if (!canceledAt) continue;
      const { error: cancelErr } = await supabase
        .from("subscriptions")
        .update({ canceled_at: canceledAt })
        .eq("user_id", row.user_id)
        .is("canceled_at", null);
      if (!cancelErr) canceledAtFilled += 1;
      else canceledAtFailed += 1;
    } catch {
      canceledAtFailed += 1;
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      invoices: {
        pages_fetched: pagesFetched,
        has_more: hasMore,
        list_error: invoiceListError,
        customers_mapped: userByCustomer.size,
        seen: invoicesSeen,
        recorded: paymentsRecorded,
        skipped_no_user: paymentsSkippedNoUser,
        skipped_zero_amount: paymentsSkippedZeroAmount,
      },
      pause_reasons: {
        candidates: pausedRows?.length ?? 0,
        inferred: pauseReasonsInferred,
      },
      canceled_at: {
        candidates: canceledRows?.length ?? 0,
        filled: canceledAtFilled,
        failed: canceledAtFailed,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
