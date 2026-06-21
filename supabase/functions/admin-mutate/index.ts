import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, corsHeaders, requireAuthedAdmin } from "../_shared/adminAuth.ts";
import { writeAdminAudit } from "../_shared/adminAudit.ts";

function bad(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

function requireReason(body: Record<string, unknown>): string | null {
  const reason = String(body.reason ?? "").trim();
  return reason.length > 0 ? reason : null;
}

async function snapshotById(
  supabase: ReturnType<typeof adminClient>,
  table: string,
  idColumn: string,
  idValue: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from(table).select("*").eq(idColumn, idValue).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return bad(405, "Method not allowed");

  const supabase = adminClient();
  const adminCheck = await requireAuthedAdmin(req, supabase);
  if ("error" in adminCheck) return adminCheck.error;
  const adminUser = adminCheck.user;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? "").trim();
  const correlationId = crypto.randomUUID();

  if (!action) return bad(400, "action is required");

  const requireReasonActions = new Set([
    "close_trade",
    "ban_user",
    "unban_user",
    "force_disconnect_broker",
    "force_reconnect_broker",
    "toggle_channel",
    "toggle_broker",
    "override_broker_config",
    "set_admin_access",
  ]);
  const reason = requireReasonActions.has(action) ? requireReason(body) : String(body.reason ?? "").trim() || null;
  if (requireReasonActions.has(action) && !reason) {
    return bad(400, "reason is required for this mutation");
  }

  if (action === "set_admin_access") {
    const userId = String(body.target_user_id ?? "").trim();
    if (!userId) return bad(400, "target_user_id is required");
    const grantAdmin = Boolean(body.is_admin);
    const before = await snapshotById(supabase, "user_profiles", "user_id", userId);

    let adminUntil: string | null = null;
    if (grantAdmin) {
      const rawUntil = body.admin_until;
      if (rawUntil === null || rawUntil === undefined || rawUntil === "") {
        adminUntil = null;
      } else {
        const parsed = new Date(String(rawUntil));
        if (Number.isNaN(parsed.getTime())) {
          return bad(400, "admin_until must be a valid ISO datetime");
        }
        if (parsed.getTime() <= Date.now()) {
          return bad(400, "admin_until must be in the future when granting admin access");
        }
        adminUntil = parsed.toISOString();
      }
    }

    const { data, error } = await supabase
      .from("user_profiles")
      .update({
        is_admin: grantAdmin,
        admin_until: grantAdmin ? adminUntil : null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "User profile not found");

    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "user_profiles",
      entity_id: userId,
      reason,
      request_payload: {
        is_admin: grantAdmin,
        admin_until: grantAdmin ? adminUntil : null,
      },
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, profile: data }, { headers: corsHeaders });
  }

  if (action === "ban_user") {
    const userId = String(body.target_user_id ?? "").trim();
    if (!userId) return bad(400, "target_user_id is required");
    const durationHours = Number(body.duration_hours ?? 24 * 365);
    const bannedUntil = new Date(Date.now() + Math.max(1, durationHours) * 60 * 60 * 1000).toISOString();
    const { data: beforeAuth } = await supabase.auth.admin.getUserById(userId);
    const before = beforeAuth?.user ? { banned_until: beforeAuth.user.banned_until } : null;
    const { data: updated, error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: `${durationHours}h` });
    if (error) return bad(400, error.message);
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "auth.users",
      entity_id: userId,
      reason,
      request_payload: { duration_hours: durationHours },
      before_state: before,
      after_state: {
        banned_until: updated.user?.banned_until ?? bannedUntil,
      },
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, banned_until: updated.user?.banned_until ?? bannedUntil }, { headers: corsHeaders });
  }

  if (action === "unban_user") {
    const userId = String(body.target_user_id ?? "").trim();
    if (!userId) return bad(400, "target_user_id is required");
    const { data: beforeAuth } = await supabase.auth.admin.getUserById(userId);
    const before = beforeAuth?.user ? { banned_until: beforeAuth.user.banned_until } : null;
    const { data: updated, error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: "none" });
    if (error) return bad(400, error.message);
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "auth.users",
      entity_id: userId,
      reason,
      before_state: before,
      after_state: { banned_until: updated.user?.banned_until ?? null },
      correlation_id: correlationId,
    });
    return Response.json({ ok: true }, { headers: corsHeaders });
  }

  if (action === "close_trade") {
    const userId = String(body.target_user_id ?? "").trim();
    const tradeId = String(body.trade_id ?? "").trim();
    if (!userId || !tradeId) return bad(400, "target_user_id and trade_id are required");
    const before = await snapshotById(supabase, "trades", "id", tradeId);
    const { data, error } = await supabase
      .from("trades")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", tradeId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "Trade not found");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "trades",
      entity_id: tradeId,
      reason,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, trade: data }, { headers: corsHeaders });
  }

  if (action === "force_disconnect_broker" || action === "force_reconnect_broker") {
    const userId = String(body.target_user_id ?? "").trim();
    const brokerId = String(body.broker_id ?? "").trim();
    if (!userId || !brokerId) return bad(400, "target_user_id and broker_id are required");
    const before = await snapshotById(supabase, "broker_accounts", "id", brokerId);
    const status = action === "force_disconnect_broker" ? "error" : "pending";
    const { data, error } = await supabase
      .from("broker_accounts")
      .update({
        connection_status: status,
        connection_error_kind: action === "force_disconnect_broker" ? "admin_forced_disconnect" : null,
        connection_error_message: action === "force_disconnect_broker" ? "Disconnected by admin" : null,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", brokerId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "Broker not found");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "broker_accounts",
      entity_id: brokerId,
      reason,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, broker: data }, { headers: corsHeaders });
  }

  if (action === "toggle_channel") {
    const userId = String(body.target_user_id ?? "").trim();
    const channelId = String(body.channel_id ?? "").trim();
    const isActive = Boolean(body.is_active);
    if (!userId || !channelId) return bad(400, "target_user_id and channel_id are required");
    const before = await snapshotById(supabase, "telegram_channels", "id", channelId);
    const { data, error } = await supabase
      .from("telegram_channels")
      .update({ is_active: isActive })
      .eq("id", channelId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "Channel not found");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "telegram_channels",
      entity_id: channelId,
      reason,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, channel: data }, { headers: corsHeaders });
  }

  if (action === "toggle_broker") {
    const userId = String(body.target_user_id ?? "").trim();
    const brokerId = String(body.broker_id ?? "").trim();
    const isActive = Boolean(body.is_active);
    if (!userId || !brokerId) return bad(400, "target_user_id and broker_id are required");
    const before = await snapshotById(supabase, "broker_accounts", "id", brokerId);
    const { data, error } = await supabase
      .from("broker_accounts")
      .update({ is_active: isActive })
      .eq("id", brokerId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "Broker not found");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "broker_accounts",
      entity_id: brokerId,
      reason,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, broker: data }, { headers: corsHeaders });
  }

  if (action === "override_broker_config") {
    const userId = String(body.target_user_id ?? "").trim();
    const brokerId = String(body.broker_id ?? "").trim();
    if (!userId || !brokerId) return bad(400, "target_user_id and broker_id are required");
    const patch = (body.patch && typeof body.patch === "object" && !Array.isArray(body.patch))
      ? body.patch as Record<string, unknown>
      : null;
    if (!patch) return bad(400, "patch object is required");
    const allowedKeys = new Set(["manual_settings", "ai_settings", "channel_trading_configs", "copier_mode", "signal_channel_ids"]);
    const payload: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(patch)) {
      if (allowedKeys.has(key)) payload[key] = val;
    }
    if (Object.keys(payload).length === 0) return bad(400, "No allowed fields in patch");
    const before = await snapshotById(supabase, "broker_accounts", "id", brokerId);
    const { data, error } = await supabase
      .from("broker_accounts")
      .update(payload)
      .eq("id", brokerId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "Broker not found");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: userId,
      action,
      entity_type: "broker_accounts",
      entity_id: brokerId,
      reason,
      request_payload: payload,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, broker: data }, { headers: corsHeaders });
  }

  if (action === "affiliate_mark_paid") {
    const ledgerIds = Array.isArray(body.ledger_ids)
      ? body.ledger_ids.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (ledgerIds.length === 0) return bad(400, "ledger_ids is required");
    const periodLabel = String(body.period_label ?? "").trim() || new Date().toISOString().slice(0, 7);
    const notes = String(body.notes ?? "").trim() || null;

    const { data: rows, error: loadErr } = await supabase
      .from("commission_ledger")
      .select("*")
      .in("id", ledgerIds);
    if (loadErr) return bad(400, loadErr.message);
    const pendingRows = (rows ?? []).filter((r) =>
      r.status === "pending" || r.status === "approved"
    );
    if (pendingRows.length === 0) return bad(400, "No payable commission rows found");
    const totalCents = pendingRows.reduce((sum, row) => sum + (Number(row.commission_cents ?? 0) || 0), 0);

    const { data: batch, error: batchErr } = await supabase
      .from("payout_batches")
      .insert({
        period_label: periodLabel,
        total_cents: totalCents,
        status: "paid",
        paid_at: new Date().toISOString(),
        notes,
        created_by_admin: adminUser.id,
      })
      .select("*")
      .single();
    if (batchErr) return bad(400, batchErr.message);

    const { error: upErr } = await supabase
      .from("commission_ledger")
      .update({ status: "paid", payout_batch_id: batch.id })
      .in("id", pendingRows.map((r) => String(r.id)));
    if (upErr) return bad(400, upErr.message);

    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      target_user_id: null,
      action,
      entity_type: "commission_ledger",
      entity_id: String(batch.id),
      reason,
      request_payload: { ledger_ids: ledgerIds, period_label: periodLabel, notes },
      before_state: { count: pendingRows.length, total_cents: totalCents },
      after_state: { payout_batch_id: batch.id, status: "paid" },
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, payout_batch: batch }, { headers: corsHeaders });
  }

  return bad(400, "Unknown action");
});
