import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function buildEmailHtml(firstName: string, confirmUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm your account</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:40px 40px 0 40px;">
              <h1 style="margin:0 0 24px 0;font-size:22px;font-weight:600;color:#171717;line-height:1.3;">
                Confirm your account
              </h1>
              <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#404040;">
                Hello ${firstName}
              </p>
              <p style="margin:0 0 32px 0;font-size:15px;line-height:1.6;color:#404040;">
                Thank you for signing up for TScopier. To confirm your account, please click the button below.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 40px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="border-radius:8px;background-color:#0d9488;">
                    <a href="${confirmUrl}" target="_blank" style="display:inline-block;padding:12px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                      Confirm account
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px;">
              <hr style="border:none;border-top:1px solid #e5e5e5;margin:0;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 40px 40px;text-align:center;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#a3a3a3;">
                Tartarix Inc.<br>
                131 Continental Dr<br>
                Suite 305<br>
                Newark, DE 19713 US
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function json(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const resendFrom = "TScopier <verification@tscopier.ai>";

    if (!resendApiKey) {
      return json(
        { error: "RESEND_API_KEY not configured on the server" },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({})) as {
      confirmUrl?: string;
      redirectTo?: string;
      email?: string;
    };

    const redirectTo =
      body.redirectTo ||
      body.confirmUrl ||
      `${req.headers.get("origin") ?? "http://localhost:5173"}/dashboard`;

    let targetEmail: string | undefined;
    let firstName = "there";

    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authError } = await supabase.auth.getUser(
        token,
      );
      if (!authError && user?.email) {
        targetEmail = user.email;
        firstName = (user.user_metadata?.first_name as string) || firstName;
      }
    }

    if (!targetEmail && typeof body.email === "string") {
      const normalized = body.email.trim().toLowerCase();
      if (normalized.includes("@")) {
        targetEmail = normalized;
      }
    }

    if (!targetEmail) {
      return json({ error: "Missing email" }, 400);
    }

    if (firstName === "there") {
      const { data: listed } = await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 50,
      });
      const match = listed?.users?.find(
        (u) => u.email?.toLowerCase() === targetEmail,
      );
      if (match?.user_metadata?.first_name) {
        firstName = String(match.user_metadata.first_name);
      }
    }

    const { data: linkData, error: linkError } = await supabase.auth.admin
      .generateLink({
        type: "magiclink",
        email: targetEmail,
        options: { redirectTo },
      });

    if (linkError || !linkData?.properties?.action_link) {
      return json(
        {
          error: "Could not create verification link",
          details: linkError?.message ?? "no action_link returned",
        },
        500,
      );
    }

    const confirmUrl = linkData.properties.action_link;

    const html = buildEmailHtml(firstName, confirmUrl);

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [targetEmail],
        subject: "Confirm your TScopier account",
        html,
      }),
    });

    if (!resendRes.ok) {
      const resendError = await resendRes.text();
      console.error("[send-verification-email] Resend error:", resendError);
      return json(
        {
          error: "Failed to send email via Resend",
          details: resendError,
          hint:
            "Verify RESEND_API_KEY and that tscopier.ai is verified in Resend for verification@tscopier.ai.",
        },
        502,
      );
    }

    const resendData = await resendRes.json();

    return json({ success: true, id: resendData.id }, 200);
  } catch (err) {
    console.error("[send-verification-email]", err);
    return json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});
