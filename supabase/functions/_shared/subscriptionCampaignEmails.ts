import { createHmac } from "node:crypto";
import {
  buildCampaignEmailHtml,
  recipientFirstName,
} from "./campaignEmailLayout.ts";

export type SubscriptionCampaignType =
  | "no_subscription_nudge"
  | "trial_expired";

export interface EmailRecipient {
  user_id: string;
  email: string;
  display_name: string | null;
  first_name: string | null;
}

export const SUBSCRIPTION_CAMPAIGN_SUBJECTS: Record<
  SubscriptionCampaignType,
  string
> = {
  no_subscription_nudge:
    "Activate UniCopier — start copying Telegram signals to your broker",
  trial_expired: "Your UniCopier trial ended — subscribe to resume copying",
};

export function getEmailUnsubscribeUrl(
  appUrl: string,
  serviceRoleKey: string,
  userId: string,
): string {
  const hmac = createHmac("sha256", serviceRoleKey);
  hmac.update(userId);
  const token = hmac.digest("hex");
  // Static HTML on the app host — Supabase Edge/Storage rewrite text/html → text/plain.
  const base = `${appUrl.replace(/\/$/, "")}/unsubscribe.html`;
  return `${base}?uid=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}`;
}

export function buildNoSubscriptionEmail(
  recipient: EmailRecipient,
  unsubscribeUrl: string,
  appUrl: string,
  logoUrl: string,
): string {
  const name = recipientFirstName(recipient);
  const pricingUrl = `${appUrl}/pricing`;
  const dashboardUrl = `${appUrl}/dashboard`;

  return buildCampaignEmailHtml({
    appUrl,
    logoUrl,
    preheader:
      "Activate a plan to start copying Telegram signals to your broker automatically.",
    eyebrow: "Subscription required",
    title: "Your copier is ready — activate a plan to go live",
    greeting: name,
    bodyHtml: `
      <p style="margin:0 0 16px 0;">You created your UniCopier account and finished onboarding, but <strong style="color:#0f172a;">live signal copying is still off</strong> because there is no active subscription on your account.</p>
      <p style="margin:0 0 16px 0;">Without a plan, new Telegram signals from your channels are <strong style="color:#0f172a;">not sent to your broker</strong>. Your dashboard, broker links, and channel setup remain saved — you only need a subscription to turn execution back on.</p>
      <p style="margin:0;">Choose <strong>Advanced</strong> for the full copier (unlimited channels, range trading, unlimited backtests) with a <strong>5-day free trial</strong> for first-time subscribers, or <strong>Basic</strong> to get started with one account and essential copy features.</p>
    `,
    featureList: [
      "24/7 automated copying from your Telegram signal channels",
      "Connect MT4/MT5 brokers — no VPS or Expert Advisor required",
      "Real-time execution logs and trade history in your dashboard",
      "Channel-specific risk settings, lot sizing, and SL/TP handling",
      "Economic calendar and news filters on supported plans",
    ],
    infoBox: {
      title: "Quick start (about 10 minutes)",
      bodyHtml: `
        <ol style="margin:8px 0 0 0;padding-left:20px;">
          <li style="margin-bottom:6px;">Pick a plan on the pricing page and complete checkout.</li>
          <li style="margin-bottom:6px;">Connect your trading account under <strong>Broker accounts</strong>.</li>
          <li style="margin-bottom:6px;">Link the Telegram channels you want to copy.</li>
          <li style="margin-bottom:0;">Leave the copier running — we handle listener, parsing, and execution.</li>
        </ol>
      `,
    },
    primaryCta: {
      label: "View plans & subscribe",
      url: pricingUrl,
    },
    secondaryCta: {
      label: "Open your dashboard",
      url: dashboardUrl,
    },
    closingHtml:
      `Questions about which plan fits your setup? Reply to this email or use in-app <strong>Help &amp; Support</strong> — we're happy to help you get your first signals copying.`,
    unsubscribeUrl,
  });
}

export function buildTrialExpiredEmail(
  recipient: EmailRecipient,
  unsubscribeUrl: string,
  appUrl: string,
  logoUrl: string,
): string {
  const name = recipientFirstName(recipient);
  const pricingUrl = `${appUrl}/pricing`;
  const billingUrl = `${appUrl}/billing`;

  return buildCampaignEmailHtml({
    appUrl,
    logoUrl,
    preheader:
      "Your free trial has ended. Subscribe to resume automated trade copying.",
    eyebrow: "Trial ended",
    title: "Subscribe to keep copying signals",
    greeting: name,
    bodyHtml: `
      <p style="margin:0 0 16px 0;">Your <strong style="color:#0f172a;">5-day Advanced trial has ended</strong>. Automated trade copying is now <strong style="color:#0f172a;">paused</strong> on your account until you subscribe to a paid plan.</p>
      <p style="margin:0 0 16px 0;">Nothing you configured is lost: your <strong>broker connections</strong>, <strong>Telegram channels</strong>, copier settings, and channel risk parameters are still saved and ready to use the moment you reactivate.</p>
      <p style="margin:0;">Subscribe to <strong>Advanced</strong> to restore unlimited channels, range trading, and advanced copier tools, or choose <strong>Basic</strong> if you only need a single account with core copy features. Because you already used your trial, checkout starts billing immediately — there is no second free trial.</p>
    `,
    featureList: [
      "Resume instant execution when new signals arrive in Telegram",
      "Keep using your existing broker and channel configuration",
      "Manage billing, invoices, and plan changes anytime",
      "Upgrade or add extra broker slots on Advanced as you scale",
    ],
    infoBox: {
      title: "What happens while you're unsubscribed",
      bodyHtml: `
        <ul style="margin:8px 0 0 0;padding-left:18px;">
          <li style="margin-bottom:6px;">New entry and management signals are <strong>not</strong> sent to your broker.</li>
          <li style="margin-bottom:6px;">Open trades on your broker are <strong>not</strong> closed automatically by UniCopier.</li>
          <li style="margin-bottom:0;">You can still sign in, review settings, and subscribe when you're ready.</li>
        </ul>
      `,
    },
    primaryCta: {
      label: "Purchase subscription",
      url: pricingUrl,
    },
    secondaryCta: {
      label: "Review billing & invoices",
      url: billingUrl,
    },
    closingHtml:
      `Need help choosing a plan or updating payment details? Reply to this email or visit <strong>Billing</strong> in the app. We'd love to have you back copying with UniCopier.`,
    unsubscribeUrl,
  });
}

export function buildSubscriptionCampaignHtml(
  campaign: SubscriptionCampaignType,
  recipient: EmailRecipient,
  unsubscribeUrl: string,
  appUrl: string,
  logoUrl: string,
): string {
  if (campaign === "no_subscription_nudge") {
    return buildNoSubscriptionEmail(recipient, unsubscribeUrl, appUrl, logoUrl);
  }
  return buildTrialExpiredEmail(recipient, unsubscribeUrl, appUrl, logoUrl);
}

export function isSubscriptionCampaignType(
  value: string,
): value is SubscriptionCampaignType {
  return value === "no_subscription_nudge" || value === "trial_expired";
}
