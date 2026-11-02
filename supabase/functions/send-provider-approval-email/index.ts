import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, corsHeaders, requireAuthedAdmin } from "../_shared/adminAuth.ts";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import { buildProviderApprovalEmail } from "../_shared/providerDecisionEmail.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const APP_URL = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(/\/$/, "");
const LOGO_URL = resolveEmailLogoUrl({
  supabaseUrl: SUPABASE_URL,
  appUrl: APP_URL,
  variant: "dark",
  explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
});
const RESEND_FROM = Deno.env.get("PROVIDER_EMAIL_FROM") ||
  Deno.env.get("RESEND_CAMPAIGN_FROM") ||
  "UniCopier <noreply@tscopier.ai>";

/** The decision must have just been made; this blocks replaying the endpoint to spam a provider. */
const DECISION_MAX_AGE_MS = 10 * 60_000;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = adminClient();
    const adminCheck = await requireAuthedAdmin(req, supabase);
    if ("error" in adminCheck) return adminCheck.error;

    const body = await req.json().catch(() => ({}));
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    const reinstated = body.decision === "reinstate";
    if (!userId) return json({ error: "user_id is required" }, 400);

    const { data: app } = await supabase
      .from("provider_applications")
      .select("status, reviewed_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!app || app.status !== "approved" || !app.reviewed_at) {
      return json({ ok: true, skipped: true, reason: "not_approved" });
    }
    const reviewedMs = Date.parse(String(app.reviewed_at));
    if (!Number.isFinite(reviewedMs) || Date.now() - reviewedMs > DECISION_MAX_AGE_MS) {
      return json({ ok: true, skipped: true, reason: "decision_too_old" });
    }

    const { data: already } = await supabase
      .from("email_campaign_log")
      .select("id")
      .eq("user_id", userId)
      .eq("campaign_type", "provider_approved")
      .contains("metadata", { reviewed_at: app.reviewed_at })
      .limit(1);
    if (already && already.length > 0) return json({ ok: true, skipped: true, reason: "already_sent" });

    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (!email) return json({ ok: true, skipped: true, reason: "no_email_on_user" });

    const [{ data: profile }, { data: social }] = await Promise.all([
      supabase.from("user_profiles").select("first_name, display_name, username").eq("user_id", userId).maybeSingle(),
      supabase.from("social_profiles").select("slug").eq("user_id", userId).maybeSingle(),
    ]);

    const { subject, html } = buildProviderApprovalEmail({
      name: profile?.first_name || profile?.display_name || profile?.username,
      appUrl: APP_URL,
      logoUrl: LOGO_URL,
      slug: social?.slug,
      reinstated,
    });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [email], subject, html, categories: ["transactional"] }),
    });
    const resData = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: "Resend API error", status: res.status, details: resData }, 502);

    await supabase.from("email_campaign_log").insert({
      user_id: userId,
      campaign_type: "provider_approved",
      email_address: email,
      metadata: {
        reviewed_at: app.reviewed_at,
        reinstated,
        triggered_by: adminCheck.user.id,
        resend_id: resData.id,
      },
    });

    return json({ ok: true, skipped: false, resend_id: resData.id });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
