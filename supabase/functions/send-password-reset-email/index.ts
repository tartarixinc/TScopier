import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildAuthEmailHtml } from "../_shared/authEmailLayout.ts";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import { evaluateSignupEmail } from "../_shared/emailSignupPolicy.ts";
import {
  AUTH_EMAIL_MAX_PER_HOUR_GLOBAL,
  AUTH_EMAIL_MAX_PER_HOUR_IP,
  enforceGlobalRateLimit,
  enforceIpRateLimit,
  extractClientIp,
  verifyTurnstileToken,
} from "../_shared/signupAbuseGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

async function resolveFirstName(
  supabase: ReturnType<typeof createClient>,
  email: string,
): Promise<string> {
  const { data: listed } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 50,
  });
  const match = listed?.users?.find((u) => u.email?.toLowerCase() === email);
  const first = match?.user_metadata?.first_name;
  return typeof first === "string" && first.trim() ? first.trim() : "there";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const resendFrom = "UniCopier <verification@tscopier.ai>";

    if (!resendApiKey) {
      return json({ error: "RESEND_API_KEY not configured on the server" }, 500);
    }

    const body = await req.json().catch(() => ({})) as {
      email?: string;
      redirectTo?: string;
      captchaToken?: string;
    };

    const clientIp = extractClientIp(req);
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const globalLimitResponse = await enforceGlobalRateLimit(
      supabase,
      "password_reset_email",
      AUTH_EMAIL_MAX_PER_HOUR_GLOBAL,
      corsHeaders,
    );
    if (globalLimitResponse) return globalLimitResponse;

    const ipLimitResponse = await enforceIpRateLimit(
      req,
      supabase,
      "password_reset_email",
      AUTH_EMAIL_MAX_PER_HOUR_IP,
      corsHeaders,
    );
    if (ipLimitResponse) return ipLimitResponse;

    const captchaOk = await verifyTurnstileToken(body.captchaToken, clientIp);
    if (!captchaOk) {
      return json({ error: "Captcha verification failed", code: "captcha_failed" }, 403);
    }

    const targetEmail = normalizeEmail(body.email);
    if (!targetEmail) {
      return json({ error: "Missing email" }, 400);
    }

    const redirectTo =
      typeof body.redirectTo === "string" && body.redirectTo.trim()
        ? body.redirectTo.trim()
        : `${req.headers.get("origin") ?? "https://app.tscopier.ai"}/reset-password`;

    const emailPolicy = evaluateSignupEmail(targetEmail);
    if (!emailPolicy.allowed) {
      if (emailPolicy.code === "invalid_email") {
        return json({ error: "Missing email" }, 400);
      }
      return json({ success: true, sent: false }, 200);
    }

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email: targetEmail,
      options: { redirectTo },
    });

    if (linkError || !linkData?.properties?.action_link) {
      console.warn(
        "[send-password-reset-email] generateLink skipped:",
        linkError?.message ?? "no action_link",
      );
      return json({ success: true, sent: false }, 200);
    }

    const meta = linkData.user?.user_metadata as Record<string, unknown> | undefined;
    const fromMeta = typeof meta?.first_name === "string" ? meta.first_name.trim() : "";
    const firstName = fromMeta || await resolveFirstName(supabase, targetEmail);
    const resetUrl = linkData.properties.action_link;
    const logoUrl = resolveEmailLogoUrl({
      supabaseUrl,
      appUrl: Deno.env.get("VITE_APP_URL"),
      variant: "light",
      explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
    });
    const html = buildAuthEmailHtml({
      title: "Reset your password",
      greeting: `Hello ${firstName},`,
      bodyHtml: `<p style="margin:0;">We received a request to reset the password for your UniCopier account. Click the button below to choose a new password.</p>`,
      buttonLabel: "Reset password",
      buttonUrl: resetUrl,
      footerNote:
        "If you did not request this, you can ignore this email. This link expires after a short time.",
      logoUrl,
    });

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [targetEmail],
        subject: "Reset your UniCopier password",
        html,
      }),
    });

    if (!resendRes.ok) {
      const resendError = await resendRes.text();
      console.error("[send-password-reset-email] Resend error:", resendError);
      return json(
        {
          error: "Failed to send email via Resend",
          details: resendError,
        },
        502,
      );
    }

    const resendData = await resendRes.json();
    return json({ success: true, sent: true, id: resendData.id }, 200);
  } catch (err) {
    console.error("[send-password-reset-email]", err);
    return json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});
