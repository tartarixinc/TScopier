import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import {
  buildSubscriptionCampaignHtml,
  getEmailUnsubscribeUrl,
  SUBSCRIPTION_CAMPAIGN_SUBJECTS,
  type EmailRecipient,
} from "../_shared/subscriptionCampaignEmails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const APP_URL = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(
  /\/$/,
  "",
);
const LOGO_URL = resolveEmailLogoUrl({
  supabaseUrl: SUPABASE_URL,
  appUrl: APP_URL,
  variant: "dark",
  explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
});
const RESEND_FROM =
  Deno.env.get("RESEND_CAMPAIGN_FROM") || "UniCopier <noreply@tscopier.com>";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; resendId?: string }> {
  if (!RESEND_API_KEY) {
    console.error("[send-subscription-campaigns] RESEND_API_KEY missing");
    return { ok: false };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("[send-subscription-campaigns] Resend error:", data);
      return { ok: false };
    }
    return { ok: true, resendId: data.id };
  } catch (err) {
    console.error("[send-subscription-campaigns] send failed:", err);
    return { ok: false };
  }
}

async function processNoSubscriptionNudge(): Promise<number> {
  const { data: eligibleUsers, error } = await supabase.rpc(
    "get_no_subscription_nudge_recipients",
  );

  if (error) {
    console.error("[send-subscription-campaigns] nudge rpc:", error.message);
    return 0;
  }
  if (!eligibleUsers?.length) return 0;

  let sent = 0;
  for (const user of eligibleUsers as EmailRecipient[]) {
    const unsubscribeUrl = getEmailUnsubscribeUrl(
      APP_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      user.user_id,
    );
    const html = buildSubscriptionCampaignHtml(
      "no_subscription_nudge",
      user,
      unsubscribeUrl,
      APP_URL,
      LOGO_URL,
    );
    const result = await sendEmail(
      user.email,
      SUBSCRIPTION_CAMPAIGN_SUBJECTS.no_subscription_nudge,
      html,
    );

    if (result.ok) {
      await supabase.from("email_campaign_log").insert({
        user_id: user.user_id,
        campaign_type: "no_subscription_nudge",
        email_address: user.email,
        metadata: {
          triggered_by: "cron",
          resend_id: result.resendId ?? null,
        },
      });
      sent++;
    }
  }

  return sent;
}

async function processTrialExpired(): Promise<number> {
  const { data: eligibleUsers, error } = await supabase.rpc(
    "get_trial_expired_recipients",
  );

  if (error) {
    console.error("[send-subscription-campaigns] trial_expired rpc:", error.message);
    return 0;
  }
  if (!eligibleUsers?.length) return 0;

  let sent = 0;
  for (const user of eligibleUsers as EmailRecipient[]) {
    const unsubscribeUrl = getEmailUnsubscribeUrl(
      APP_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      user.user_id,
    );
    const html = buildSubscriptionCampaignHtml(
      "trial_expired",
      user,
      unsubscribeUrl,
      APP_URL,
      LOGO_URL,
    );
    const result = await sendEmail(
      user.email,
      SUBSCRIPTION_CAMPAIGN_SUBJECTS.trial_expired,
      html,
    );

    if (result.ok) {
      await supabase.from("email_campaign_log").insert({
        user_id: user.user_id,
        campaign_type: "trial_expired",
        email_address: user.email,
        metadata: {
          triggered_by: "cron",
          resend_id: result.resendId ?? null,
        },
      });
      sent++;
    }
  }

  return sent;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const nudgeSent = await processNoSubscriptionNudge();
    const trialSent = await processTrialExpired();

    return new Response(
      JSON.stringify({
        success: true,
        no_subscription_nudge_sent: nudgeSent,
        trial_expired_sent: trialSent,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
