import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import { sendResendEmail } from "../_shared/resendSender.ts";
import {
  enforceGlobalRateLimit,
  enforceIpRateLimit,
} from "../_shared/signupAbuseGuard.ts";
import {
  buildUnsubscribeRecoveryEmail,
  getEmailUnsubscribeUrl,
  UNSUBSCRIBE_RECOVERY_SUBJECT,
  type EmailRecipient,
} from "../_shared/subscriptionCampaignEmails.ts";
import {
  verifyUnsubscribeToken,
} from "../_shared/unsubscribeToken.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(/\/$/, "");
const UNSUBSCRIBE_PAGE_URL = (
  Deno.env.get("EMAIL_UNSUBSCRIBE_PAGE_URL")
  || `${APP_URL}/unsubscribe.html`
).replace(/\?.*$/, "");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM =
  Deno.env.get("RESEND_CAMPAIGN_FROM") || "TScopier <noreply@tscopier.com>";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function verifyToken(userId: string, token: string): boolean {
  return verifyUnsubscribeToken(SUPABASE_SERVICE_ROLE_KEY, userId, token);
}

function appUnsubscribeUrl(uid: string, token: string, extra?: Record<string, string>): string {
  const u = new URL(UNSUBSCRIBE_PAGE_URL);
  u.searchParams.set("uid", uid);
  u.searchParams.set("token", token);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  }
  return u.toString();
}

async function lookupUnsubscribed(uid: string): Promise<boolean> {
  const { data } = await supabase
    .from("email_unsubscribes")
    .select("user_id")
    .eq("user_id", uid)
    .maybeSingle();
  return Boolean(data);
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/**
 * Find a user id for an email address. Scans auth users in pages (same
 * pattern as admin-query); recovery requests are rare and rate-limited, so
 * a bounded scan is acceptable. Returns null when not found.
 */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const perPage = 200;
  const maxPages = 250; // 50k users; well above the current base and bounded
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error("[email-unsubscribe] listUsers error:", error.message);
      return null;
    }
    const users = data?.users ?? [];
    const match = users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (users.length < perPage) break;
    if (page === maxPages) {
      console.warn(
        "[email-unsubscribe] recovery scan hit page bound without a match — user base exceeds",
        maxPages * perPage,
      );
    }
  }
  return null;
}

async function profileName(userId: string): Promise<{
  display_name: string | null;
  first_name: string | null;
}> {
  const { data } = await supabase
    .from("user_profiles")
    .select("display_name, first_name")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    display_name: data?.display_name ?? null,
    first_name: data?.first_name ?? null,
  };
}

async function sendRecoveryEmail(
  recipient: EmailRecipient,
): Promise<{ ok: boolean; resendId?: string }> {
  const logoUrl = resolveEmailLogoUrl({
    supabaseUrl: SUPABASE_URL,
    appUrl: APP_URL,
    variant: "dark",
    explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
  });
  const unsubscribeUrl = getEmailUnsubscribeUrl(
    APP_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    recipient.user_id,
  );
  const html = buildUnsubscribeRecoveryEmail(
    recipient,
    unsubscribeUrl,
    APP_URL,
    logoUrl,
  );
  return await sendResendEmail({
    to: recipient.email,
    subject: UNSUBSCRIBE_RECOVERY_SUBJECT,
    html,
    from: RESEND_FROM,
    resendApiKey: RESEND_API_KEY,
    logPrefix: "[email-unsubscribe]",
  });
}

/**
 * Handles `POST { action: "send_recovery_link", email }` — sends the address
 * a fresh unsubscribe confirmation email. The fresh link is minted and later
 * verified by this same function's env key, so it works even when the
 * original email's link was signed with a different (stale) key.
 *
 * The response is deliberately generic: it never reveals whether the
 * address has an account or is already unsubscribed.
 */
async function handleRecoveryRequest(req: Request, rawEmail: unknown): Promise<Response> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return json({ ok: false, error: "missing_email" }, 400);
  }

  const globalLimit = await enforceGlobalRateLimit(
    supabase,
    "unsubscribe_recovery_email",
    100,
    corsHeaders,
  );
  if (globalLimit) return globalLimit;

  const ipLimit = await enforceIpRateLimit(
    req,
    supabase,
    "unsubscribe_recovery_email",
    3,
    corsHeaders,
  );
  if (ipLimit) return ipLimit;

  const userId = await findUserIdByEmail(email);
  if (userId) {
    const names = await profileName(userId);
    const result = await sendRecoveryEmail({
      user_id: userId,
      email,
      display_name: names.display_name,
      first_name: names.first_name,
    });
    if (result.ok) {
      await supabase.from("email_campaign_log").insert({
        user_id: userId,
        campaign_type: "unsubscribe_recovery_email",
        email_address: email,
        metadata: {
          triggered_by: "user_recovery_request",
          resend_id: result.resendId ?? null,
        },
      });
    }
  } else {
    console.warn("[email-unsubscribe] recovery requested for unknown email");
  }

  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const wantsJson =
      url.searchParams.get("format") === "json"
      || (req.headers.get("accept") ?? "").includes("application/json");

    if (req.method === "GET") {
      const uid = url.searchParams.get("uid");
      const token = url.searchParams.get("token");

      if (!uid || !token) {
        if (wantsJson) return json({ ok: false, error: "missing_params" }, 400);
        return Response.redirect(`${UNSUBSCRIBE_PAGE_URL}?error=invalid`, 302);
      }

      if (!verifyToken(uid, token)) {
        // Log the uid only — never the token or the key. A spike here means
        // the campaign signer and this function disagree on the service key.
        console.warn("[email-unsubscribe] token verification failed for uid:", uid);
        if (wantsJson) return json({ ok: false, error: "invalid_token" }, 403);
        return Response.redirect(appUnsubscribeUrl(uid, token, { error: "expired" }), 302);
      }

      const already = await lookupUnsubscribed(uid);
      if (wantsJson) {
        return json({ ok: true, already_unsubscribed: already });
      }

      // Supabase rewrites text/html → text/plain on GET. Serve the UI on the app host instead.
      return Response.redirect(
        appUnsubscribeUrl(uid, token, already ? { status: "already" } : undefined),
        302,
      );
    }

    if (req.method === "POST") {
      const contentType = req.headers.get("content-type") ?? "";
      let uid: string | null = null;
      let token: string | null = null;
      let reason: string | null = null;
      let action: string | null = null;
      let rawEmail: unknown = null;

      if (contentType.includes("application/json")) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        uid = typeof body.uid === "string" ? body.uid : null;
        token = typeof body.token === "string" ? body.token : null;
        reason = typeof body.reason === "string" ? body.reason : null;
        action = typeof body.action === "string" ? body.action : null;
        rawEmail = body.email;
      } else {
        const formData = await req.formData();
        uid = formData.get("uid")?.toString() ?? null;
        token = formData.get("token")?.toString() ?? null;
        reason = formData.get("reason")?.toString() ?? null;
        action = formData.get("action")?.toString() ?? null;
        rawEmail = formData.get("email");
      }

      if (action === "send_recovery_link") {
        return handleRecoveryRequest(req, rawEmail);
      }

      if (!uid || !token) {
        if (wantsJson || contentType.includes("application/json")) {
          return json({ ok: false, error: "missing_params" }, 400);
        }
        return Response.redirect(`${UNSUBSCRIBE_PAGE_URL}?error=invalid`, 302);
      }

      if (!verifyToken(uid, token)) {
        console.warn("[email-unsubscribe] token verification failed for uid:", uid);
        if (wantsJson || contentType.includes("application/json")) {
          return json({ ok: false, error: "invalid_token" }, 403);
        }
        return Response.redirect(appUnsubscribeUrl(uid, token, { error: "expired" }), 302);
      }

      const { error } = await supabase
        .from("email_unsubscribes")
        .upsert(
          {
            user_id: uid,
            unsubscribed_at: new Date().toISOString(),
            reason,
          },
          { onConflict: "user_id" },
        );

      if (error) {
        console.error("[email-unsubscribe] upsert error:", error.message);
        if (wantsJson || contentType.includes("application/json")) {
          return json({ ok: false, error: "server_error" }, 500);
        }
        return Response.redirect(appUnsubscribeUrl(uid, token, { error: "server" }), 302);
      }

      if (wantsJson || contentType.includes("application/json")) {
        return json({ ok: true });
      }
      return Response.redirect(appUnsubscribeUrl(uid, token, { status: "success" }), 302);
    }

    return json({ ok: false, error: "method_not_allowed" }, 405);
  } catch (err) {
    console.error("[email-unsubscribe] unexpected error:", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
