import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  effectivePlan,
  isSubscriptionActive,
  BACKTEST_QUOTA_RUN_MODE,
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
  trial_ends_at: string | null;
}

export async function loadUserSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserSubscriptionRow | null> {
  const { data } = await supabase
    .from("subscriptions")
    .select("plan,status,extra_accounts,trial_ends_at")
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

export type PlanLimitCountOptions = {
  /** How many additional active slots this action needs (default 1). */
  slotsNeeded?: number;
  /** Existing row ids that will be reactivated / updated and must not count twice. */
  excludeRowIds?: string[];
};

export async function assertBrokerAccountLimit(
  supabase: SupabaseClient,
  userId: string,
  sub: UserSubscriptionRow | null,
  options: PlanLimitCountOptions = {},
): Promise<Response | null> {
  if (await loadUserIsAdmin(supabase, userId)) return null;

  const plan = effectivePlan(sub?.plan, sub?.status, sub?.trial_ends_at);
  if (!plan) {
    return subscriptionAccessDenied(
      "An active subscription is required to connect broker accounts.",
      "subscription_required",
    );
  }
  const limit = maxBrokerAccounts(plan, sub?.extra_accounts ?? 0);
  const slotsNeeded = options.slotsNeeded ?? 1;
  if (slotsNeeded <= 0) return null;
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error || !data) {
    console.warn(
      `[subscriptionAccess] broker limit count failed for ${userId}: ${error?.message ?? "null data"}`,
    );
    return subscriptionAccessDenied(
      "Unable to verify broker account limits. Try again.",
      "limit_check_failed",
      503,
    );
  }
  const exclude = new Set((options.excludeRowIds ?? []).filter(Boolean));
  const count = data.reduce((n, row) => n + (exclude.has(row.id) ? 0 : 1), 0);
  if (count + slotsNeeded > limit) {
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

  const plan = effectivePlan(sub?.plan, sub?.status, sub?.trial_ends_at);
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
  const { count, error } = await supabase
    .from("backtest_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("config->>runMode", BACKTEST_QUOTA_RUN_MODE)
    .gte("created_at", monthStart.toISOString());
  if (error || count == null) {
    console.warn(
      `[subscriptionAccess] backtest limit count failed for ${userId}: ${error?.message ?? "null count"}`,
    );
    return subscriptionAccessDenied(
      "Unable to verify backtest limits. Try again.",
      "limit_check_failed",
      503,
    );
  }
  if (count >= limit) {
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
  options: PlanLimitCountOptions = {},
): Promise<Response | null> {
  if (await loadUserIsAdmin(supabase, userId)) return null;

  const plan = effectivePlan(sub?.plan, sub?.status, sub?.trial_ends_at);
  if (!plan) {
    return subscriptionAccessDenied(
      "An active subscription is required to add Telegram channels.",
      "subscription_required",
    );
  }
  const limit = maxTelegramChannels(plan);
  if (limit == null) return null;
  const slotsNeeded = options.slotsNeeded ?? 1;
  if (slotsNeeded <= 0) return null;
  const { data, error } = await supabase
    .from("telegram_channels")
    .select("id, source_kind")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error || !data) {
    console.warn(
      `[subscriptionAccess] channel limit count failed for ${userId}: ${error?.message ?? "null data"}`,
    );
    return subscriptionAccessDenied(
      "Unable to verify Telegram channel limits. Try again.",
      "limit_check_failed",
      503,
    );
  }
  const exclude = new Set((options.excludeRowIds ?? []).filter(Boolean));
  const count = data.reduce((n, row) => {
    if (exclude.has(row.id)) return n;
    if ((row as { source_kind?: string | null }).source_kind === "tradingview") return n;
    return n + 1;
  }, 0);
  if (count + slotsNeeded > limit) {
    return subscriptionAccessDenied(
      `Basic plan includes ${limit} Telegram channels. Upgrade to Advanced for unlimited channels.`,
      "channel_limit",
    );
  }
  return null;
}

export { isSubscriptionActive, effectivePlan };

/** Pause copier and drop listener lease when subscription is no longer active. */
export async function revokeCopierAccessOnSubscriptionEnd(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  if (await loadUserIsAdmin(supabase, userId)) return

  const { error: pauseErr } = await supabase
    .from("user_profiles")
    .update({ copier_paused: true })
    .eq("user_id", userId)
  if (pauseErr) {
    console.warn(
      `[subscriptionAccess] copier_paused update failed for ${userId}: ${pauseErr.message}`,
    )
  }

  const { error: leaseErr } = await supabase
    .from("worker_session_leases")
    .delete()
    .eq("user_id", userId)
  if (leaseErr) {
    console.warn(
      `[subscriptionAccess] lease delete failed for ${userId}: ${leaseErr.message}`,
    )
  }
}

/** Clear subscription-induced pause when billing is active again. */
export async function restoreCopierAccessOnSubscriptionActive(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  if (await loadUserIsAdmin(supabase, userId)) return

  const { error } = await supabase
    .from("user_profiles")
    .update({ copier_paused: false })
    .eq("user_id", userId)
  if (error) {
    console.warn(
      `[subscriptionAccess] copier_paused restore failed for ${userId}: ${error.message}`,
    )
    return
  }
  console.log(`[subscriptionAccess] restored copier access for ${userId}`)
}
