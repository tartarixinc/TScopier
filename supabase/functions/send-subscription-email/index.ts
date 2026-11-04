import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import {
  buildSubscriptionCampaignHtml,
  getEmailUnsubscribeUrl,
  isSubscriptionCampaignType,
  SUBSCRIPTION_CAMPAIGN_SUBJECTS,
  type EmailRecipient,
} from "../_shared/subscriptionCampaignEmails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
  Deno.env.get("RESEND_CAMPAIGN_FROM") || "UniCopier <noreply@tscopier.ai>";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { user_id, campaign } = await req.json();

    if (!user_id || !campaign) {
      return new Response(
        JSON.stringify({ error: "user_id and campaign are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!isSubscriptionCampaignType(campaign)) {
      return new Response(
        JSON.stringify({
          error:
            `Unknown campaign: ${campaign}. Valid: no_subscription_nudge, trial_expired`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: authUser, error: authErr } = await supabase.auth.admin
      .getUserById(user_id);
    if (authErr || !authUser?.user?.email) {
      return new Response(
        JSON.stringify({
          error: "Could not find user email",
          details: authErr?.message,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const email = authUser.user.email;

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("display_name, first_name")
      .eq("user_id", user_id)
      .maybeSingle();

    const recipient: EmailRecipient = {
      user_id,
      email,
      display_name: profile?.display_name ?? null,
      first_name: profile?.first_name ?? null,
    };

    const { data: unsub } = await supabase
      .from("email_unsubscribes")
      .select("id")
      .eq("user_id", user_id)
      .maybeSingle();

    if (unsub) {
      return new Response(
        JSON.stringify({ error: "User has unsubscribed from emails" }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const unsubUrl = getEmailUnsubscribeUrl(
      APP_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      user_id,
    );
    const html = buildSubscriptionCampaignHtml(
      campaign,
      recipient,
      unsubUrl,
      APP_URL,
      LOGO_URL,
    );

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: SUBSCRIPTION_CAMPAIGN_SUBJECTS[campaign],
        html,
      }),
    });

    const resData = await res.json();

    if (!res.ok) {
      return new Response(
        JSON.stringify({
          error: "Resend API error",
          status: res.status,
          details: resData,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    await supabase.from("email_campaign_log").insert({
      user_id,
      campaign_type: campaign,
      email_address: email,
      metadata: { triggered_by: "admin_manual", resend_id: resData.id },
    });

    return new Response(
      JSON.stringify({ success: true, email, campaign, resend_id: resData.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
