import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, corsHeaders, requireAuthedAdmin } from "../_shared/adminAuth.ts";
import { isAdminAccessActive } from "../_shared/adminAccess.ts";

function bad(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

async function optionalRows(
  query: Promise<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<unknown[]> {
  const { data, error } = await query;
  if (error) return [];
  return data ?? [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return bad(405, "Method not allowed");

  const supabase = adminClient();
  const adminCheck = await requireAuthedAdmin(req, supabase);
  if ("error" in adminCheck) return adminCheck.error;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? "");

  if (action === "overview") {
    const { todayStart, tomorrowStart } = (() => {
      const now = new Date();
      const s = new Date(now);
      s.setHours(0, 0, 0, 0);
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      return { todayStart: s.toISOString(), tomorrowStart: e.toISOString() };
    })();

    const [
      usersRes,
      brokersRes,
      openTradesRes,
      closedTodayRes,
      channelsRes,
      subsRes,
    ] = await Promise.all([
      supabase.from("user_profiles").select("user_id", { count: "exact", head: true }),
      supabase.from("broker_accounts").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("trades").select("id", { count: "exact", head: true }).eq("status", "open"),
      supabase.from("trades").select("id", { count: "exact", head: true })
        .eq("status", "closed")
        .gte("closed_at", todayStart)
        .lt("closed_at", tomorrowStart),
      supabase.from("telegram_channels").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "active"),
    ]);

    return Response.json({
      stats: {
        total_users: usersRes.count ?? 0,
        active_brokers: brokersRes.count ?? 0,
        open_trades: openTradesRes.count ?? 0,
        closed_trades_today: closedTodayRes.count ?? 0,
        active_channels: channelsRes.count ?? 0,
        active_subscriptions: subsRes.count ?? 0,
      },
    }, { headers: corsHeaders });
  }

  if (action === "users_list") {
    const search = String(body.search ?? "").trim().toLowerCase();
    const rows = await optionalRows(
      supabase.from("user_profiles")
        .select("user_id,display_name,first_name,last_name,subscription_status,is_admin,admin_until,created_at,base_currency")
        .order("created_at", { ascending: false })
        .limit(200),
    ) as Array<Record<string, unknown>>;
    const userIds = rows.map((r) => String(r.user_id ?? "")).filter(Boolean);

    const brokers = userIds.length
      ? await optionalRows(
        supabase.from("broker_accounts")
          .select("user_id,last_balance,last_equity")
          .in("user_id", userIds),
      ) as Array<Record<string, unknown>>
      : [];

    const balanceByUser = new Map<string, number>();
    for (const broker of brokers) {
      const uid = String(broker.user_id ?? "");
      const bal = Number(broker.last_balance ?? broker.last_equity ?? 0);
      if (!uid || !Number.isFinite(bal)) continue;
      balanceByUser.set(uid, (balanceByUser.get(uid) ?? 0) + bal);
    }

    const emailByUser = new Map<string, string>();
    if (userIds.length > 0) {
      const wanted = new Set(userIds);
      let page = 1;
      const perPage = 1000;
      while (wanted.size > emailByUser.size && page <= 10) {
        const { data: authPage } = await supabase.auth.admin.listUsers({ page, perPage });
        const authUsers = authPage?.users ?? [];
        for (const authUser of authUsers) {
          if (wanted.has(authUser.id)) {
            emailByUser.set(authUser.id, authUser.email ?? "");
          }
        }
        if (authUsers.length < perPage) break;
        page += 1;
      }
    }

    const users = rows.map((r) => {
      const uid = String(r.user_id ?? "");
      const first = String(r.first_name ?? "").trim();
      const last = String(r.last_name ?? "").trim();
      const name = [first, last].filter(Boolean).join(" ")
        || String(r.display_name ?? "").trim()
        || "Unnamed user";
      return {
        user_id: uid,
        name,
        email: emailByUser.get(uid) ?? "",
        created_at: r.created_at,
        total_balance: balanceByUser.get(uid) ?? 0,
        base_currency: String(r.base_currency ?? "USD"),
        subscription_status: r.subscription_status ?? null,
        is_admin: r.is_admin === true,
        admin_until: r.admin_until ?? null,
        admin_active: isAdminAccessActive({
          is_admin: r.is_admin === true,
          admin_until: r.admin_until as string | null | undefined,
        }),
      };
    });

    const filtered = search
      ? users.filter((u) =>
        u.user_id.toLowerCase().includes(search) ||
        u.name.toLowerCase().includes(search) ||
        u.email.toLowerCase().includes(search)
      )
      : users;
    return Response.json({ users: filtered }, { headers: corsHeaders });
  }

  if (action === "user_360") {
    const userId = String(body.target_user_id ?? "").trim();
    if (!userId) return bad(400, "target_user_id is required");

    const [
      profileRes,
      brokersRes,
      channelsRes,
      tradesRes,
      subRes,
      backtests,
      copierLogs,
    ] = await Promise.all([
      supabase.from("user_profiles").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("broker_accounts").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
      supabase.from("telegram_channels").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
      supabase.from("trades").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      supabase.from("subscriptions").select("*").eq("user_id", userId).maybeSingle(),
      optionalRows(
        supabase.from("backtest_runs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      ),
      optionalRows(
        supabase.from("trade_execution_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
      ),
    ]);

    const trades = (tradesRes.data ?? []) as Array<Record<string, unknown>>;
    const totalBalance = (brokersRes.data ?? []).reduce((sum, b) => {
      const n = Number((b as Record<string, unknown>).last_balance ?? 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    const openPnl = trades.filter((t) => t.status === "open").reduce((sum, t) => {
      const n = Number(t.profit ?? 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tradesToday = trades.filter((t) => {
      const openedAt = new Date(String(t.opened_at ?? t.created_at ?? "")).getTime();
      return Number.isFinite(openedAt) && openedAt >= todayStart.getTime();
    });
    const todayProfit = tradesToday.reduce((sum, t) => sum + (Number(t.profit ?? 0) || 0), 0);

    return Response.json({
      profile: profileRes.data ?? null,
      subscription: subRes.data ?? null,
      stats: {
        total_balance: totalBalance,
        today_profit: todayProfit,
        trades_taken_today: tradesToday.length,
        open_pnl: openPnl,
        connected_accounts: brokersRes.data?.length ?? 0,
        telegram_channels: channelsRes.data?.length ?? 0,
      },
      brokers: brokersRes.data ?? [],
      channels: channelsRes.data ?? [],
      backtests,
      copier_logs: copierLogs,
    }, { headers: corsHeaders });
  }

  if (action === "user_trades") {
    const userId = String(body.target_user_id ?? "").trim();
    if (!userId) return bad(400, "target_user_id is required");
    const pageRaw = Number(body.page ?? 1);
    const pageSizeRaw = Number(body.page_size ?? 20);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(Math.floor(pageSizeRaw), 100)
      : 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await supabase
      .from("trades")
      .select("id,symbol,status,profit,opened_at,created_at", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) return bad(400, error.message);
    const total = count ?? 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    return Response.json({
      trades: data ?? [],
      total,
      page,
      page_size: pageSize,
      total_pages: totalPages,
    }, { headers: corsHeaders });
  }

  if (action === "trades_recent") {
    const trades = await optionalRows(
      supabase.from("trades").select("id,user_id,symbol,status,profit,created_at").order("created_at", { ascending: false }).limit(500),
    );
    return Response.json({ trades }, { headers: corsHeaders });
  }

  if (action === "channels_recent") {
    const channels = await optionalRows(
      supabase.from("telegram_channels").select("id,user_id,display_name,is_active").order("created_at", { ascending: false }).limit(300),
    );
    return Response.json({ channels }, { headers: corsHeaders });
  }

  if (action === "backtests_recent") {
    const backtests = await optionalRows(
      supabase.from("backtest_runs").select("id,user_id,status,created_at").order("created_at", { ascending: false }).limit(200),
    );
    return Response.json({ backtests }, { headers: corsHeaders });
  }

  if (action === "copier_logs_recent") {
    const logs = await optionalRows(
      supabase.from("trade_execution_logs")
        .select("id,user_id,channel_id,action,status,error_message,created_at")
        .order("created_at", { ascending: false })
        .limit(300),
    );
    return Response.json({ logs }, { headers: corsHeaders });
  }

  if (action === "affiliate_payouts_overview") {
    const status = String(body.status ?? "pending");
    const ledger = await optionalRows(
      supabase
        .from("commission_ledger")
        .select("*")
        .eq("status", status)
        .order("created_at", { ascending: true })
        .limit(500),
    ) as Array<Record<string, unknown>>;

    const affiliateIds = [...new Set(ledger.map((r) => String(r.affiliate_user_id ?? "")).filter(Boolean))];
    const referredIds = [...new Set(ledger.map((r) => String(r.referred_user_id ?? "")).filter(Boolean))];
    const allUserIds = [...new Set([...affiliateIds, ...referredIds])];

    const profiles = allUserIds.length > 0
      ? await optionalRows(
        supabase
          .from("user_profiles")
          .select("user_id,display_name,first_name,last_name")
          .in("user_id", allUserIds),
      ) as Array<Record<string, unknown>>
      : [];

    const profileName = new Map<string, string>();
    for (const p of profiles) {
      const id = String(p.user_id ?? "");
      if (!id) continue;
      const first = String(p.first_name ?? "").trim();
      const last = String(p.last_name ?? "").trim();
      const display = String(p.display_name ?? "").trim();
      const name = [first, last].filter(Boolean).join(" ").trim() || display || "User";
      profileName.set(id, name);
    }

    const payouts = ledger.map((row) => ({
      ...row,
      affiliate_name: profileName.get(String(row.affiliate_user_id ?? "")) ?? "User",
      referred_name: profileName.get(String(row.referred_user_id ?? "")) ?? "User",
    }));
    const totalPendingCents = payouts.reduce((sum, row) => sum + (Number(row.commission_cents ?? 0) || 0), 0);

    return Response.json(
      {
        payouts,
        totals: {
          count: payouts.length,
          total_pending_cents: totalPendingCents,
        },
      },
      { headers: corsHeaders },
    );
  }

  return bad(400, "Unknown action");
});
