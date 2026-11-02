import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildAuthEmailHtml } from "./authEmailLayout.ts";
import { resolveEmailLogoUrl } from "./brandEmailAssets.ts";
import { revokeCopierAccessOnSubscriptionEnd } from "./subscriptionAccess.ts";

export type InvoicePaymentIssueKind = "failed" | "action_required";

const COPY: Record<
  InvoicePaymentIssueKind,
  { subject: string; title: string; body: string; button: string; footer: string }
> = {
  action_required: {
    subject: "Action required — confirm your UniCopier subscription payment",
    title: "Confirm your payment",
    body:
      "Your bank requires additional verification to complete your UniCopier subscription payment. Signal copying is paused until payment is confirmed.",
    button: "Complete payment",
    footer:
      "If you did not expect this charge, contact your bank or reply to this email. You can also update your payment method from Billing in the app.",
  },
  failed: {
    subject: "Payment failed — update your UniCopier subscription",
    title: "Payment failed",
    body:
      "We could not process your latest UniCopier subscription payment. Signal copying is paused until your billing is updated.",
    button: "Pay invoice",
    footer:
      "Update your card from the link above or open Billing in the app. Reply to this email if you need help.",
  },
};

function planDisplayName(plan: string | null | undefined): string {
  const normalized = String(plan ?? "").trim().toLowerCase();
  if (normalized === "advanced") return "Advanced";
  if (normalized === "basic") return "Basic";
  return "Subscription";
}

function planFromInvoice(invoice: Stripe.Invoice): string | null {
  for (const line of invoice.lines?.data ?? []) {
    const nickname = line.price?.nickname?.toLowerCase() ?? "";
    const productName = typeof line.price?.product === "object" && line.price.product &&
        "name" in line.price.product
      ? String((line.price.product as Stripe.Product).name ?? "").toLowerCase()
      : "";
    const description = String(line.description ?? "").toLowerCase();
    const haystack = `${nickname} ${productName} ${description}`;
    if (haystack.includes("advanced")) return "advanced";
    if (haystack.includes("basic")) return "basic";
  }
  return null;
}

/**
 * Open invoices that still need the customer to pay (invoice collection),
 * not card auto-charge renewals which would otherwise spam every cycle.
 */
export function shouldSendInvoiceDueEmail(invoice: Stripe.Invoice): boolean {
  if (!invoice.id) return false;
  if (invoice.status !== "open") return false;
  if (Number(invoice.amount_due ?? 0) <= 0) return false;
  return invoice.collection_method === "send_invoice";
}

export async function handleInvoicePaymentIssue(
  stripe: Stripe,
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  kind: InvoicePaymentIssueKind,
): Promise<void> {
  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  if (!subscriptionId) return;

  await supabase
    .from("subscriptions")
    .update({
      status: "past_due",
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId);

  const { data: subRow } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  const userId = subRow?.user_id as string | undefined;
  if (!userId) return;

  await revokeCopierAccessOnSubscriptionEnd(supabase, userId);
  await sendPaymentIssueEmail(stripe, supabase, invoice, userId, kind);
}

export async function handleInvoiceDue(
  stripe: Stripe,
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
): Promise<void> {
  if (!shouldSendInvoiceDueEmail(invoice)) return;

  const userId = await resolveUserIdForInvoice(stripe, supabase, invoice);
  if (!userId) return;

  await sendInvoiceDueEmail(stripe, supabase, invoice, userId);
}

async function resolveUserIdForInvoice(
  stripe: Stripe,
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
): Promise<string | null> {
  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;

  if (subscriptionId) {
    const { data: subRow } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (subRow?.user_id) return subRow.user_id as string;
  }

  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : invoice.customer?.id ?? null;
  if (!customerId) return null;

  const { data: byCustomer } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (byCustomer?.user_id) return byCustomer.user_id as string;

  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    const metaUserId = customer.metadata?.supabase_user_id?.trim();
    return metaUserId || null;
  } catch {
    return null;
  }
}

async function resolveInvoicePlanLabel(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  userId: string,
): Promise<string> {
  const fromInvoice = planFromInvoice(invoice);
  if (fromInvoice) return planDisplayName(fromInvoice);

  const { data: subRow } = await supabase
    .from("subscriptions")
    .select("plan")
    .eq("user_id", userId)
    .maybeSingle();

  return planDisplayName(subRow?.plan as string | undefined);
}

async function resolveInvoicePaymentUrl(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<string> {
  let hostedUrl = invoice.hosted_invoice_url ?? null;
  if (!hostedUrl && invoice.id) {
    try {
      const full = await stripe.invoices.retrieve(invoice.id);
      hostedUrl = full.hosted_invoice_url ?? null;
    } catch (err) {
      console.warn(
        `[billingPaymentNotification] invoice retrieve failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const appUrl = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(
    /\/$/,
    "",
  );
  return hostedUrl || `${appUrl}/billing`;
}

async function resolveRecipient(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  userId: string,
): Promise<{ email: string; firstName: string } | null> {
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email ?? invoice.customer_email ?? null;
  if (!email) return null;

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("first_name, display_name")
    .eq("user_id", userId)
    .maybeSingle();

  const firstName = profile?.first_name?.trim()
    || profile?.display_name?.trim()?.split(/\s+/)[0]
    || "there";

  return { email, firstName };
}

async function sendResendEmail(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) {
    console.warn("[billingPaymentNotification] RESEND_API_KEY missing; skipping email");
    return;
  }

  const from = Deno.env.get("RESEND_BILLING_FROM")
    || Deno.env.get("RESEND_CAMPAIGN_FROM")
    || "UniCopier <noreply@tscopier.ai>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        html: args.html,
      }),
    });
    if (!res.ok) {
      console.warn(
        "[billingPaymentNotification] Resend error:",
        await res.text(),
      );
    }
  } catch (err) {
    console.warn(
      `[billingPaymentNotification] send failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function sendPaymentIssueEmail(
  stripe: Stripe,
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  userId: string,
  kind: InvoicePaymentIssueKind,
): Promise<void> {
  const recipient = await resolveRecipient(supabase, invoice, userId);
  if (!recipient) return;

  const paymentUrl = await resolveInvoicePaymentUrl(stripe, invoice);
  const copy = COPY[kind];
  const appUrl = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(
    /\/$/,
    "",
  );
  const logoUrl = resolveEmailLogoUrl({
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    appUrl,
    variant: "light",
    explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
  });

  const html = buildAuthEmailHtml({
    title: copy.title,
    greeting: `Hello ${recipient.firstName},`,
    bodyHtml: `<p style="margin:0;">${copy.body}</p>`,
    buttonLabel: copy.button,
    buttonUrl: paymentUrl,
    footerNote: copy.footer,
    logoUrl,
  });

  await sendResendEmail({
    to: recipient.email,
    subject: copy.subject,
    html,
  });
}

async function sendInvoiceDueEmail(
  stripe: Stripe,
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
  userId: string,
): Promise<void> {
  const recipient = await resolveRecipient(supabase, invoice, userId);
  if (!recipient) return;

  const planLabel = await resolveInvoicePlanLabel(supabase, invoice, userId);
  const paymentUrl = await resolveInvoicePaymentUrl(stripe, invoice);
  const appUrl = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(
    /\/$/,
    "",
  );
  const logoUrl = resolveEmailLogoUrl({
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    appUrl,
    variant: "light",
    explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
  });

  const subject = `Invoice Due for UniCopier ${planLabel} Plan`;
  const html = buildAuthEmailHtml({
    title: "Invoice Due",
    greeting: `Hi ${recipient.firstName},`,
    bodyHtml: `
      <p style="margin:0 0 16px 0;">We're letting you know that an invoice is due for UniCopier.</p>
      <p style="margin:0;">Please take a look at your invoice and pay your outstanding balance to avoid service disruption.</p>
    `,
    buttonLabel: "Invoice",
    buttonUrl: paymentUrl,
    footerNote:
      "If you have some questions about this invoice, please reply to this email.<br><br>Regards,<br>The UniCopier Team",
    logoUrl,
  });

  await sendResendEmail({
    to: recipient.email,
    subject,
    html,
  });
}
