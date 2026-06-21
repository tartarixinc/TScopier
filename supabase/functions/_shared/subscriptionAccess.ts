import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  effectivePlan,
  isSubscriptionActive,
  maxBacktestsPerMonth,
  maxBrokerAccounts,
  maxTelegramChannels,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from "./planLimits.ts";
import { isAdminAccessActive } from "./adminAccess.ts";

export interface UserSubscriptionRow {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  extra_accounts: number;
}

export async function loadUserSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserSubscriptionRow | null> {
  const { data } = await supabase
    .from("subscriptions")
    .select("plan,status,extra_accounts")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return data as UserSubscriptionRow;
}

function adminUserIdsFromEnv(): Set<string> {
  const raw = Deno.env.get("TSCOPIER_ADMIN_USER_IDS") ?? "";
  return new Set(
    raw.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.length > 0),
  );
}

/** True when user bypasses subscription limits (DB flag, env list, or Auth app_metadata). */
export async function loadUserIsAdmin(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  if (adminUserIdsFromEnv().has(userId)) return true;

  const { data, error } = await supabase
    .from("user_profiles")
    .select("is_admin, admin_until")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn(
      `[subscriptionAccess] user_profiles.is_admin lookup failed for ${userId}: ${error.message}`,
    );
  } else if (isAdminAccessActive(data)) {
    return true;
  }

  try {
    const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(
      userId,
    );
    if (!authErr && authData?.user) {
      const meta = authData.user.app_metadata ?? {};
      if (meta.is_admin === true || meta.role === "admin") return true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[subscriptionAccess] auth admin lookup failed for ${userId}: ${msg}`);
  }

  return false;
}

export function subscriptionAccessDenied(
  message: string,
  code: string,
  status = 403,
): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function assertBrokerAccountLimit(
  supabase: SupabaseClient,
  userId: string,
  sub: UserSubscriptionRow | null,
): Promise<Response | null> {
  if (await loadUserIsAdmin(supabase, userId)) return null;

  const plan = effectivePlan(sub?.plan, sub?.status);
  if (!plan) {
    return subscriptionAccessDenied(
      "An active subscription is required to connect broker accounts.",
      "subscription_required",
    );
  }
  const limit = maxBrokerAccounts(plan, sub?.extra_accounts ?? 0);
  const { count } = await supabase
    .from("broker_accounts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_active", true);
  if ((count ?? 0) >= limit) {
    return subscriptionAccessDenied(
      plan === "basic"
        ? "Basic plan allows 1 broker account. Upgrade to Advanced for more."
        : `Your plan allows ${limit} broker accounts. Add more from Billing.`,
      "broker_account_limit",
    );
  }
  return null;
}

export async function assertBacktestMonthlyLimit(
  supabase: SupabaseClient,
  userId: string,
  sub: UserSubscriptionRow | null,
): Promise<Response | null> {
  if (await loadUserIsAdmin(supabase, userId)) return null;

  const plan = effectivePlan(sub?.plan, sub?.status);
  if (!plan) {
    return subscriptionAccessDenied(
      "An active subscription is required to run backtests.",
      "subscription_required",
    );
  }
  const limit = maxBacktestsPerMonth(plan);
  if (limit == null) return null;

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("backtest_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", monthStart.toISOString());
  if ((count ?? 0) >= limit) {
    return subscriptionAccessDenied(
      `Basic plan includes ${limit} backtests per month. Upgrade to Advanced for unlimited backtests.`,
      "backtest_monthly_limit",
    );
  }
  return null;
}

export async function assertTelegramChannelLimit(
  supabase: SupabaseClient,
  userId: string,
  sub: UserSubscriptionRow | null,
): Promise<Response | null> {
  if (await loadUserIsAdmin(supabase, userId)) return null;

  const plan = effectivePlan(sub?.plan, sub?.status);
  if (!plan) {
    return subscriptionAccessDenied(
      "An active subscription is required to add Telegram channels.",
      "subscription_required",
    );
  }
  const limit = maxTelegramChannels(plan);
  if (limit == null) return null;
  const { count } = await supabase
    .from("telegram_channels")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) >= limit) {
    return subscriptionAccessDenied(
      `Basic plan includes ${limit} Telegram channels. Upgrade to Advanced for unlimited channels.`,
      "channel_limit",
    );
  }
  return null;
}

export { isSubscriptionActive, effectivePlan };
