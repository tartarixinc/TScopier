import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, corsHeaders, requireAuthedAdmin } from "../_shared/adminAuth.ts";
import { writeAdminAudit } from "../_shared/adminAudit.ts";
import { isSuspiciousSignupEmail } from "../_shared/emailSignupPolicy.ts";

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
    "bulk_ban_spam_users",
    "force_disconnect_broker",
    "force_reconnect_broker",
    "toggle_channel",
    "toggle_broker",
    "override_broker_config",
    "set_admin_access",
    "acknowledge_alert",
    "update_alert_rule",
    "upsert_alert_recipient",
    "delete_alert_recipient",
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

  if (action === "bulk_ban_spam_users") {
    const dryRun = body.dry_run === true;
    const matched: Array<{ user_id: string; email: string }> = [];
    let page = 1;
    const perPage = 1000;

    while (page <= 20) {
      const { data } = await supabase.auth.admin.listUsers({ page, perPage });
      const users = data?.users ?? [];
      if (users.length === 0) break;

      for (const user of users) {
        const email = user.email ?? "";
        if (!email || !isSuspiciousSignupEmail(email)) continue;
        matched.push({ user_id: user.id, email });
      }

      if (users.length < perPage) break;
      page += 1;
    }

    if (dryRun) {
      return Response.json({
        ok: true,
        dry_run: true,
        matched_count: matched.length,
        matched,
      }, { headers: corsHeaders });
    }

    let bannedCount = 0;
    const failures: Array<{ user_id: string; error: string }> = [];
    for (const row of matched) {
      const { error } = await supabase.auth.admin.updateUserById(row.user_id, {
        ban_duration: "876000h",
      });
      if (error) {
        failures.push({ user_id: row.user_id, error: error.message });
        continue;
      }
      bannedCount += 1;
      await writeAdminAudit(supabase, {
        actor_user_id: adminUser.id,
        target_user_id: row.user_id,
        action: "ban_user",
        entity_type: "auth.users",
        entity_id: row.user_id,
        reason: reason ?? "bulk_ban_spam_users",
        request_payload: { email: row.email, bulk: true },
        before_state: null,
        after_state: { banned: true },
        correlation_id: correlationId,
      });
    }

    return Response.json({
      ok: true,
      matched_count: matched.length,
      banned_count: bannedCount,
      failures,
    }, { headers: corsHeaders });
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

  if (action === "acknowledge_alert") {
    const eventId = String(body.alert_event_id ?? "").trim();
    if (!eventId) return bad(400, "alert_event_id is required");
    const before = await snapshotById(supabase, "alert_events", "id", eventId);
    if (!before) return bad(404, "Alert event not found");
    if (before.state !== "firing") return bad(409, "Only firing alerts can be acknowledged");
    const { data, error } = await supabase
      .from("alert_events")
      .update({
        state: "acknowledged",
        acknowledged_by: adminUser.id,
        acknowledged_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("state", "firing")
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(409, "Alert event changed state, reload and try again");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      action,
      entity_type: "alert_events",
      entity_id: eventId,
      reason,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, alert_event: data }, { headers: corsHeaders });
  }

  if (action === "update_alert_rule") {
    const code = String(body.code ?? "").trim();
    if (!code) return bad(400, "code is required");
    const before = await snapshotById(supabase, "alert_rules", "code", code);
    if (!before) return bad(404, "Alert rule not found");

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 120);
    if (body.description !== undefined) patch.description = String(body.description).trim().slice(0, 600);
    if (body.severity !== undefined) {
      const severity = String(body.severity);
      if (!["info", "warning", "critical"].includes(severity)) return bad(400, "severity must be info, warning or critical");
      patch.severity = severity;
    }
    if (body.threshold !== undefined) {
      if (typeof body.threshold !== "object" || body.threshold === null || Array.isArray(body.threshold)) {
        return bad(400, "threshold must be an object");
      }
      patch.threshold = body.threshold;
    }
    if (body.window_minutes !== undefined) {
      const minutes = Number(body.window_minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return bad(400, "window_minutes must be 1..1440");
      patch.window_minutes = minutes;
    }
    if (body.cooldown_seconds !== undefined) {
      const seconds = Number(body.cooldown_seconds);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) return bad(400, "cooldown_seconds must be 0..86400");
      patch.cooldown_seconds = seconds;
    }

    const { data, error } = await supabase
      .from("alert_rules")
      .update(patch)
      .eq("code", code)
      .select("*")
      .maybeSingle();
    if (error) return bad(400, error.message);
    if (!data) return bad(404, "Alert rule not found");
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      action,
      entity_type: "alert_rules",
      entity_id: code,
      reason,
      before_state: before,
      after_state: data as Record<string, unknown>,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, rule: data }, { headers: corsHeaders });
  }

  if (action === "upsert_alert_recipient") {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(400, "email is not valid");
    const minSeverity = String(body.min_severity ?? "warning");
    if (!["info", "warning", "critical"].includes(minSeverity)) return bad(400, "min_severity must be info, warning or critical");
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    const before = await snapshotById(supabase, "alert_recipients", "email", email);
    const { data, error } = await supabase
      .from("alert_recipients")
      .upsert({ email, min_severity: minSeverity, enabled }, { onConflict: "email" })
      .select("*")
      .single();
    if (error) return bad(400, error.message);
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      action,
      entity_type: "alert_recipients",
      entity_id: String(data.id),
      reason,
      before_state: before as Record<string, unknown> | null,
      after_state: data as Record<string, unknown>,
      request_payload: { email, min_severity: minSeverity, enabled },
      correlation_id: correlationId,
    });
    return Response.json({ ok: true, recipient: data }, { headers: corsHeaders });
  }

  if (action === "delete_alert_recipient") {
    const id = String(body.recipient_id ?? "").trim();
    if (!id) return bad(400, "recipient_id is required");
    const before = await snapshotById(supabase, "alert_recipients", "id", id);
    if (!before) return bad(404, "Recipient not found");
    const { error } = await supabase.from("alert_recipients").delete().eq("id", id);
    if (error) return bad(400, error.message);
    await writeAdminAudit(supabase, {
      actor_user_id: adminUser.id,
      action,
      entity_type: "alert_recipients",
      entity_id: id,
      reason,
      before_state: before,
      correlation_id: correlationId,
    });
    return Response.json({ ok: true }, { headers: corsHeaders });
  }

  return bad(400, "Unknown action");
});
