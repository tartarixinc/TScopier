import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { affiliateCorsHeaders, requireAuthedUser } from "../_shared/affiliate.ts";

function bad(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: affiliateCorsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: affiliateCorsHeaders });
  }
  if (req.method !== "POST") return bad(405, "Method not allowed");

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return bad(500, "Stripe not configured");
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const auth = await requireAuthedUser(req, supabase);
    if ("error" in auth) return auth.error;
    const user = auth.user;

    const { data: profile, error: profileError } = await supabase
      .from("social_profiles")
      .select("provider_status, stripe_connect_account_id, stripe_connect_charges_enabled")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profileError) return bad(400, profileError.message);
    if (!profile || profile.provider_status !== "approved") {
      return bad(403, "Only approved providers can connect payouts");
    }

    let accountId = profile.stripe_connect_account_id ?? null;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: user.email ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          supabase_user_id: user.id,
          kind: "social_copy_provider",
        },
      });
      accountId = account.id;
      await supabase
        .from("social_profiles")
        .update({
          stripe_connect_account_id: accountId,
          stripe_connect_charges_enabled: Boolean(account.charges_enabled),
        })
        .eq("user_id", user.id);
    } else {
      const account = await stripe.accounts.retrieve(accountId);
      const chargesEnabled = Boolean(account.charges_enabled);
      if (chargesEnabled !== Boolean(profile.stripe_connect_charges_enabled)) {
        await supabase
          .from("social_profiles")
          .update({ stripe_connect_charges_enabled: chargesEnabled })
          .eq("user_id", user.id);
      }
      if (chargesEnabled) {
        return Response.json(
          { url: null, charges_enabled: true, account_id: accountId },
          { headers: affiliateCorsHeaders },
        );
      }
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const origin = req.headers.get("origin") || Deno.env.get("APP_URL") || "https://app.tscopier.ai";
    const refreshUrl = String(body.refresh_url ?? `${origin}/provider/apply`).trim();
    const returnUrl = String(body.return_url ?? `${origin}/provider/apply`).trim();

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: refreshUrl,
      return_url: returnUrl,
    });
    return Response.json(
      { url: link.url, charges_enabled: false, account_id: accountId },
      { headers: affiliateCorsHeaders },
    );
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : "Unknown error");
  }
});
