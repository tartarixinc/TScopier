/**
 * alert-evaluator — server-side alert rules, evaluated once a minute.
 *
 * Trigger: pg_cron (see migration 20261012120400_prune_monitoring_tables.sql)
 * POSTs to this function with the service-role key. The schedule must keep
 * firing even when nothing else is running: this function is the only thing
 * that can turn a broken system into an email, so it reports its own liveness
 * (system_probe_state target 'alert_evaluator' + Sentry cron check-in).
 * PRODUCTION SECRET REQUIREMENT: SENTRY_AUTH_TOKEN and
 * ALERT_EVALUATOR_CRON_MONITOR_SLUG must both be set in Supabase — when the
 * evaluator is dead no rule runs, so an external cron monitor is the only
 * thing that can page about its death. The probe_stale rule additionally
 * watches the evaluator's own probe row, so a recovery after an outage pages.
 *
 * Rule lifecycle (alert_events):
 *   - firing     : condition met, email retried with exponential backoff
 *                  (1m, 2m, 4m ... capped at 30m) until delivered — no attempt
 *                  cap, so a Resend outage can never permanently swallow a page
 *   - acknowledged: an admin muted it (admin-mutate); re-fire is suppressed until it clears
 *   - resolved   : condition cleared (or the rule was disabled); delivery state is
 *                  reset so a recovery email can go out (that one gives up after
 *                  5 attempts — a stale recovery notice is worse than none)
 * Exactly one firing row per rule is guaranteed by the partial unique index
 * alert_events_open_firing_idx; a losing insert (23505) means a concurrent tick
 * already fired and this run sends nothing.
 * Cooldown: after a resolve, the same rule will not re-fire for
 * cooldown_seconds — flap protection.
 *
 * Threshold keys (alert_rules.threshold), documented here as the migration
 * comment promises. window_minutes on the rule bounds windowed counters:
 *   bridge_down            { grace_seconds: number, targets: string[] }
 *   probe_stale            { max_stale_minutes: number, targets: string[] }
 *   mtapi_accounts_error   { max_error_pct: number, min_accounts: number }
 *   mtapi_reconnect_storm  { max_events: number }            // windowed
 *   workers_offline        { }                               // zero leases sustained for window_minutes
 *   trade_workers_offline  { max_stale_minutes: number }      // worker_trade heartbeat
 *   queue_stuck            { max_oldest_minutes: number, max_pending: number }
 *   executions_failing     { max_failed: number }            // windowed; distinct failing signals, order_close_audit excluded
 *   dead_letters_high      { max_open: number }
 *   telegram_gap           { max_not_listening: number }     // paying subscribers only (active/trialing)
 *
 * Principles: never treat unknown as healthy (a stale probe row fires), never
 * invent an outage from an unreadable table (skip and log instead), and keep
 * thresholds in the database so the admin editor and this evaluator cannot
 * drift apart.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("ALERT_RESEND_FROM") || "TScopier <alerts@tscopier.ai>";
const ADMIN_ALERTS_URL = (Deno.env.get("ADMIN_ALERTS_URL") || "http://panel.tscopier.cloud/monitoring/alerts").replace(/\/$/, "");

const EMAIL_BATCH_LIMIT = 25;
const EMAIL_MAX_ATTEMPTS = 5; // recovery (resolved) emails only; firing retries are uncapped
const EMAIL_RETRY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// 3x the cron interval: a slow send pass must still own its claim when the
// next tick starts, or two runs could send the same event to everyone.
const EMAIL_CLAIM_LEASE_MS = 180_000;
const EMAIL_MISSING_KEY_RETRY_MS = 30 * 60_000;
const MESSAGE_MAX = 500;

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

interface RuleRow {
  code: string;
  name: string;
  description: string;
  severity: string;
  enabled: boolean;
  threshold: Record<string, unknown>;
  window_minutes: number;
  cooldown_seconds: number;
}

interface EventRow {
  id: string;
  rule_code: string;
  state: "firing" | "resolved" | "acknowledged";
  severity: string;
  email_sent_at: string | null;
  email_attempts: number;
  email_next_attempt_at: string | null;
  created_at: string;
}

type EvalOutcome =
  | { kind: "skip"; reason: string }
  | { kind: "ok"; fired: boolean; value: number | null; message: string };

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function strList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : fallback;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function minutesSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / 60_000);
}

async function headCount(
  sb: ReturnType<typeof createClient>,
  table: string,
  apply: (q: any) => any,
): Promise<number | null> {
  // select("*") — not "id": worker_session_leases has no id column, and a
  // bad column would make PostgREST error the whole count (silent skip).
  let q = sb.from(table).select("*", { count: "exact", head: true });
  q = apply(q);
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Evaluators — one per seeded rule. Return {kind:"skip"} when the underlying
// data cannot be read (unknown must never become a page, and must never become
// "healthy" either — staleness rules below cover the silent case).
// ---------------------------------------------------------------------------

async function evalBridgeDown(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const targets = strList(rule.threshold.targets, ["bridge_mt5", "bridge_mt4"]);
  const graceMs = num(rule.threshold.grace_seconds, 120) * 1000;
  const { data, error } = await sb
    .from("system_probe_state")
    .select("target, state, down_since, detail")
    .in("target", targets);
  if (error) return { kind: "skip", reason: error.message };
  const down = (data ?? []).filter((r: any) => {
    if (r.state !== "down" || !r.down_since) return false;
    const since = Date.parse(r.down_since);
    return Number.isFinite(since) && nowMs - since >= graceMs;
  });
  if (down.length === 0) return { kind: "ok", fired: false, value: null, message: "" };
  const worst = down.reduce((max: number, r: any) => {
    const sec = Math.round((nowMs - Date.parse(r.down_since)) / 1000);
    return sec > max ? sec : max;
  }, 0);
  const detail = down
    .map((r: any) => `${r.target} down ${Math.round((nowMs - Date.parse(r.down_since)) / 1000)}s (${r.detail ?? "no detail"})`)
    .join("; ");
  return { kind: "ok", fired: true, value: worst, message: detail };
}

async function evalProbeStale(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const targets = strList(rule.threshold.targets, ["bridge_mt5", "bridge_mt4"]);
  const maxStaleMs = num(rule.threshold.max_stale_minutes, 5) * 60_000;
  const { data, error } = await sb
    .from("system_probe_state")
    .select("target, updated_at")
    .in("target", targets);
  if (error) return { kind: "skip", reason: error.message };
  // Rows that do not exist at all are skipped: the target is not deployed
  // (e.g. MTAPI_BASE_URL unset) and must not page forever.
  const stale = (data ?? []).filter((r: any) => {
    const age = minutesSince(r.updated_at, nowMs);
    return age != null && age * 60_000 > maxStaleMs;
  });
  if (stale.length === 0) return { kind: "ok", fired: false, value: null, message: "" };
  const worstMin = Math.max(...stale.map((r: any) => minutesSince(r.updated_at, nowMs) ?? 0));
  return {
    kind: "ok",
    fired: true,
    value: Math.round(worstMin),
    message: stale.map((r: any) => `${r.target} last report ${Math.round(minutesSince(r.updated_at, nowMs) ?? 0)}m ago`).join("; "),
  };
}

async function evalMtapiAccountsError(sb: any, rule: RuleRow): Promise<EvalOutcome> {
  const maxPct = num(rule.threshold.max_error_pct, 20);
  const minAccounts = num(rule.threshold.min_accounts, 3);
  const total = await headCount(sb, "broker_accounts", q => q.eq("provider", "mtapi"));
  if (total == null) return { kind: "skip", reason: "broker_accounts unreadable" };
  if (total < minAccounts) return { kind: "ok", fired: false, value: 0, message: "" };
  const errored = await headCount(sb, "broker_accounts", q =>
    q.eq("provider", "mtapi").eq("connection_status", "error"));
  if (errored == null) return { kind: "skip", reason: "broker_accounts error count unreadable" };
  const pct = total > 0 ? (errored / total) * 100 : 0;
  return {
    kind: "ok",
    fired: pct > maxPct,
    value: round1(pct),
    message: `${errored} of ${total} MTAPI accounts in error (${round1(pct)}%)`,
  };
}

async function evalReconnectStorm(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const maxEvents = num(rule.threshold.max_events, 10);
  const since = new Date(nowMs - rule.window_minutes * 60_000).toISOString();
  const count = await headCount(sb, "broker_connection_events", q =>
    q.eq("provider", "mtapi").gte("created_at", since));
  if (count == null) return { kind: "skip", reason: "broker_connection_events unreadable" };
  return {
    kind: "ok",
    fired: count > maxEvents,
    value: count,
    message: `${count} connection transitions in ${rule.window_minutes}m (max ${maxEvents})`,
  };
}

async function evalWorkersOffline(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const active = await headCount(sb, "worker_session_leases", q =>
    q.gte("expires_at", new Date(nowMs).toISOString()));
  if (active == null) return { kind: "skip", reason: "worker_session_leases unreadable" };
  if (active > 0) return { kind: "ok", fired: false, value: active, message: "" };

  // Zero active leases right now. Lease rows are deleted on graceful
  // shutdown, so a single-replica rollout leaves the table EMPTY for tens of
  // seconds — and an empty table also occurs when leases were never
  // acquired. Treat that as unknown, not as an outage; real listener
  // outages are covered by telegram_gap (empty leases ⇒ every linked
  // account counts as not listening) and by trade_workers_offline.
  // With rows present, require no renewal within the rule window so
  // deploy blips stay quiet and a real outage pages after window_minutes.
  const { data: latest, error } = await sb
    .from("worker_session_leases")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) return { kind: "skip", reason: error.message };
  const lastRenewal = latest?.[0]?.updated_at;
  if (!lastRenewal) {
    return { kind: "skip", reason: "no lease rows (released on shutdown or never acquired)" };
  }
  const t = Date.parse(lastRenewal);
  if (!Number.isFinite(t)) return { kind: "skip", reason: "worker_session_leases updated_at unreadable" };
  if (nowMs - t < rule.window_minutes * 60_000) {
    return { kind: "ok", fired: false, value: 0, message: "" };
  }
  return {
    kind: "ok",
    fired: true,
    value: 0,
    message: `no worker holds an unexpired session lease and none has renewed for ${rule.window_minutes}m — nothing is listening`,
  };
}

async function evalTradeWorkersOffline(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const maxStaleMs = num(rule.threshold.max_stale_minutes, 3) * 60_000;
  const { data, error } = await sb
    .from("system_probe_state")
    .select("updated_at, detail")
    .eq("target", "worker_trade")
    .maybeSingle();
  if (error) return { kind: "skip", reason: error.message };
  // No row yet (liveness tick not deployed or never ran): unknown, not firing.
  if (!data) return { kind: "ok", fired: false, value: null, message: "" };
  const ageMs = nowMs - Date.parse(data.updated_at ?? 0);
  if (!Number.isFinite(ageMs) || ageMs <= maxStaleMs) {
    return { kind: "ok", fired: false, value: 0, message: "" };
  }
  return {
    kind: "ok",
    fired: true,
    value: Math.round(ageMs / 60_000),
    message: `no trade worker heartbeat for ${Math.round(ageMs / 60_000)}m (last: ${data.detail ?? "unknown"})`,
  };
}

async function evalQueueStuck(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const maxOldest = num(rule.threshold.max_oldest_minutes, 60);
  const maxPending = num(rule.threshold.max_pending, 10);
  const pending = await headCount(sb, "signals", q => q.eq("status", "pending"));
  if (pending == null) return { kind: "skip", reason: "signals unreadable" };
  const { data: oldestRows, error } = await sb
    .from("signals")
    .select("created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) return { kind: "skip", reason: error.message };
  const oldestMin = minutesSince(oldestRows?.[0]?.created_at, nowMs);
  const fired = pending > maxPending || (oldestMin != null && oldestMin > maxOldest);
  return {
    kind: "ok",
    fired,
    value: oldestMin != null ? Math.round(oldestMin) : pending,
    message: `${pending} pending, oldest ${oldestMin != null ? Math.round(oldestMin) : "?"}m (limits: ${maxPending} / ${maxOldest}m)`,
  };
}

/**
 * Failed executions.
 *
 * Three noise corrections, all learned from the 2026-10-23 incident review:
 *
 *  1. `order_close_audit` rows are the audit trail of broker close *attempts*
 *     (the stuck-pending retry loop wrote one every few minutes — 215 in 24h).
 *     They describe an attempt, not an execution outcome, so they never count.
 *  2. Distinct failing signals, not raw rows: one chronic failure retried every
 *     cycle must not look like twenty different failing executions.
 *  3. A raw-row storm still fires on its own at 3x `max_failed`, so a
 *     systematic single-account failure (one broker down, every execution for
 *     it retrying) cannot hide under the distinct count.
 */
const EXECUTIONS_FAILING_MAX_ROWS = 5000;
const EXECUTIONS_FAILING_STORM_MULTIPLIER = 3;

export function countDistinctFailingSignals(rows: Array<{ signal_id?: string | null }>): number {
  const signals = new Set<string>();
  for (const row of rows) {
    const id = String(row.signal_id ?? "").trim();
    if (id) signals.add(id);
  }
  return signals.size;
}

async function evalExecutionsFailing(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const maxFailed = num(rule.threshold.max_failed, 20);
  const stormCap = maxFailed * EXECUTIONS_FAILING_STORM_MULTIPLIER;
  const since = new Date(nowMs - rule.window_minutes * 60_000).toISOString();
  const { data, error } = await sb
    .from("trade_execution_logs")
    .select("signal_id")
    .eq("status", "failed")
    .neq("action", "order_close_audit")
    .gte("created_at", since)
    .limit(EXECUTIONS_FAILING_MAX_ROWS);
  if (error) return { kind: "skip", reason: "trade_execution_logs unreadable" };
  const rows = (data ?? []) as Array<{ signal_id?: string | null }>;
  const distinct = countDistinctFailingSignals(rows);
  const rowsFailed = rows.length;
  const fired = distinct > maxFailed || rowsFailed > stormCap;
  return {
    kind: "ok",
    fired,
    value: fired ? Math.max(distinct, rowsFailed) : distinct,
    message: `${distinct} distinct signal(s) with failed executions in ${rule.window_minutes}m`
      + ` (${rowsFailed} failure rows; limits ${maxFailed} signals / ${stormCap} rows)`,
  };
}

async function evalDeadLettersHigh(sb: any, rule: RuleRow): Promise<EvalOutcome> {
  const maxOpen = num(rule.threshold.max_open, 20);
  const count = await headCount(sb, "signal_queue_dead_letters", q => q.is("replayed_at", null));
  if (count == null) return { kind: "skip", reason: "signal_queue_dead_letters unreadable" };
  return {
    kind: "ok",
    fired: count > maxOpen,
    value: count,
    message: `${count} unreplayed dead letters (max ${maxOpen})`,
  };
}

/**
 * Users whose subscription currently pays for copying.
 *
 * The gap alert must measure "customers whose copies stopped", and a linked
 * Telegram session with an expired/cancelled trial is not one of them. Counting
 * every session made the rule a permanent false positive (2026-10-23: 177
 * sessions vs 37 active/trialing subscribers, a reported gap of ~140 against a
 * real gap of 0). A trialing row only counts while `trial_ends_at` is in the
 * future — the same rule `planLimits.ts` applies for entitlement.
 */
export function payingSubscriberIds(
  rows: Array<{ user_id: string; status?: string | null; trial_ends_at?: string | null }>,
  nowMs: number,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const userId = String(row.user_id ?? "").trim();
    if (!userId) continue;
    const status = String(row.status ?? "").toLowerCase();
    if (status === "trialing") {
      const ends = row.trial_ends_at ? Date.parse(row.trial_ends_at) : NaN;
      if (Number.isFinite(ends) && ends <= nowMs) continue;
    }
    out.add(userId);
  }
  return out;
}

/**
 * Telegram listening gap — mirrors tscopier-admin systemHealth.ts: prefer the
 * copier_listener_health truth table when it has fresh reporting rows, fall
 * back to session leases otherwise, and never count an unreadable health table
 * as an outage.
 *
 * Scope: users with an active/trialing subscription. An unreadable
 * `subscriptions` table falls back to every linked session (over-counting is
 * the safe direction — a broken read must not hide a real gap).
 */
async function evalTelegramGap(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  const maxGap = num(rule.threshold.max_not_listening, 2);
  const nowIso = new Date(nowMs).toISOString();

  const sessionsRes = await sb.from("telegram_sessions").select("user_id").limit(10_000);
  if (sessionsRes.error) return { kind: "skip", reason: "telegram_sessions unreadable" };
  const linked = new Set<string>((sessionsRes.data ?? []).map((r: any) => r.user_id));
  if (linked.size === 0) return { kind: "ok", fired: false, value: 0, message: "" };

  // Set when the scope was narrowed to paying subscribers (null = all linked).
  let payingTotal: number | null = null;
  const subsRes = await sb
    .from("subscriptions")
    .select("user_id,status,trial_ends_at")
    .in("status", ["active", "trialing"]);
  if (!subsRes.error && Array.isArray(subsRes.data)) {
    const paying = payingSubscriberIds(subsRes.data as any[], nowMs);
    if (paying.size > 0) {
      for (const userId of [...linked]) {
        if (!paying.has(userId)) linked.delete(userId);
      }
      payingTotal = paying.size;
    }
    // paying.size === 0: keep every linked session — no entitled user must
    // silently fall out of the gap calculation.
  }

  const leasesRes = await sb.from("worker_session_leases").select("user_id").gte("expires_at", nowIso);
  const leaseListening = new Set<string>(
    ((leasesRes.data ?? []) as any[]).map((r: any) => r.user_id),
  );

  const healthRes = await sb
    .from("copier_listener_health")
    .select("user_id, listener_status, mtproto_connected, updated_at, last_successful_probe_at, freshness_threshold_ms");
  const healthLive = new Set<string>();
  let healthReporting = 0;
  if (!healthRes.error) {
    for (const h of healthRes.data ?? []) {
      const thresholdMs = Math.max(1_000, Math.min(10 * 60_000, num(h.freshness_threshold_ms, 90_000)));
      const updatedFresh = h.updated_at ? nowMs - Date.parse(h.updated_at) <= thresholdMs : false;
      if (updatedFresh) healthReporting += 1;
      const probeFresh = h.last_successful_probe_at ? nowMs - Date.parse(h.last_successful_probe_at) <= thresholdMs : false;
      if (h.listener_status === "connected" && h.mtproto_connected === true && updatedFresh && probeFresh) {
        healthLive.add(h.user_id);
      }
    }
  }
  const useHealth = !healthRes.error && healthReporting > 0;
  // Both listening signals unreadable: unknown, never a page.
  if (!useHealth && leasesRes.error) return { kind: "skip", reason: "neither copier_listener_health nor leases readable" };
  const listening = new Set<string>();
  for (const userId of linked) {
    if (useHealth ? healthLive.has(userId) : leaseListening.has(userId)) listening.add(userId);
  }
  const gap = linked.size - listening.size;
  const message = payingTotal != null
    ? `${gap} of ${linked.size} paying-subscriber session(s) not listening`
      + ` (${payingTotal} paying subscribers total; max ${maxGap})`
    : `${gap} of ${linked.size} linked session(s) not listening (max ${maxGap})`;
  return {
    kind: "ok",
    fired: gap > maxGap,
    value: gap,
    message,
  };
}

async function evaluate(sb: any, rule: RuleRow, nowMs: number): Promise<EvalOutcome> {
  switch (rule.code) {
    case "bridge_down": return evalBridgeDown(sb, rule, nowMs);
    case "probe_stale": return evalProbeStale(sb, rule, nowMs);
    case "mtapi_accounts_error": return evalMtapiAccountsError(sb, rule);
    case "mtapi_reconnect_storm": return evalReconnectStorm(sb, rule, nowMs);
    case "workers_offline": return evalWorkersOffline(sb, rule, nowMs);
    case "trade_workers_offline": return evalTradeWorkersOffline(sb, rule, nowMs);
    case "queue_stuck": return evalQueueStuck(sb, rule, nowMs);
    case "executions_failing": return evalExecutionsFailing(sb, rule, nowMs);
    case "dead_letters_high": return evalDeadLettersHigh(sb, rule);
    case "telegram_gap": return evalTelegramGap(sb, rule, nowMs);
    default:
      return { kind: "skip", reason: `no evaluator for rule ${rule.code}` };
  }
}

// ---------------------------------------------------------------------------
// Email delivery (Resend).
// ---------------------------------------------------------------------------

interface RecipientRow {
  email: string;
  min_severity: string;
}

function alertEmailHtml(opts: {
  rule: RuleRow;
  event: EventRow & { message?: string; value?: number | null; resolved_at?: string | null };
  kind: "firing" | "resolved";
}): string {
  const { rule, event, kind } = opts;
  const isFiring = kind === "firing";
  const accent = isFiring ? (rule.severity === "critical" ? "#dc2626" : "#d97706") : "#059669";
  const label = isFiring ? (rule.severity === "critical" ? "CRITICAL ALERT" : "ALERT") : "RESOLVED";
  const valueLine = event.value != null ? `<p style="margin:0 0 8px 0;font-size:14px;color:#404040;">Measured value: <strong>${esc(event.value)}</strong></p>` : "";
  const resolvedNote = !isFiring
    ? `<p style="margin:0 0 12px 0;font-size:14px;color:#404040;">The condition cleared at ${esc(event.resolved_at ?? "")}.</p>`
    : "";
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Helvetica Neue,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;padding:24px;">
      <p style="margin:0 0 4px 0;font-size:13px;font-weight:700;letter-spacing:0.06em;color:#71717a;">TSCOPIER SYSTEMS</p>
      <span style="display:inline-block;background:${accent};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.08em;padding:3px 8px;border-radius:999px;">${label}</span>
      <h1 style="margin:12px 0 4px 0;font-size:20px;color:#18181b;">${esc(rule.name)}</h1>
      <p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;color:#404040;">${esc(event.message ?? "")}</p>
      ${valueLine}
      <p style="margin:0 0 16px 0;font-size:13px;line-height:1.5;color:#71717a;">${esc(rule.description)}</p>
      ${resolvedNote}
      <p style="margin:0 0 20px 0;"><a href="${esc(ADMIN_ALERTS_URL)}" style="font-size:14px;font-weight:600;color:${accent};text-decoration:none;">Open the Alerts console &rarr;</a></p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#a3a3a3;">Rule <code style="background:#f4f4f5;padding:1px 5px;border-radius:4px;">${esc(rule.code)}</code> · severity ${esc(rule.severity)} · raised ${esc(event.created_at)}</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendAlertEmail(
  rule: RuleRow,
  event: EventRow & { message?: string; value?: number | null; resolved_at?: string | null },
  recipients: RecipientRow[],
  kind: "firing" | "resolved",
): Promise<{ ok: boolean; error?: string; sent: number }> {
  const eligible = recipients.filter(
    r => (SEVERITY_RANK[r.min_severity] ?? 1) <= (SEVERITY_RANK[event.severity] ?? 1),
  );
  // Nothing configured to notify: treat as delivered so the retry loop stops.
  if (eligible.length === 0) return { ok: true, sent: 0 };

  const html = alertEmailHtml({ rule, event, kind });
  const subject = kind === "firing"
    ? `TScopier alert: ${rule.name}`
    : `TScopier recovered: ${rule.name}`;

  let sent = 0;
  let lastError = "";
  for (const recipient of eligible) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [recipient.email],
          subject,
          html,
          categories: ["alert"],
        }),
      });
      if (res.ok) {
        sent += 1;
      } else {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        lastError = `HTTP_${res.status} ${JSON.stringify(body).slice(0, 200)}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: lastError === "", error: lastError || undefined, sent };
}

// ---------------------------------------------------------------------------
// Evaluator self-liveness.
// ---------------------------------------------------------------------------

async function sentryCheckIn(status: "ok" | "error"): Promise<void> {
  const token = Deno.env.get("SENTRY_AUTH_TOKEN");
  const slug = Deno.env.get("ALERT_EVALUATOR_CRON_MONITOR_SLUG");
  if (!token || !slug) return;
  try {
    await fetch(`https://sentry.io/api/0/monitors/${encodeURIComponent(slug)}/check-ins/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ monitor_slug: slug, status }),
    });
  } catch (err) {
    console.warn(`[alert-evaluator] sentry check-in failed status=${status} err=${err instanceof Error ? err.message : "UNKNOWN"}`);
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function authorized(req: Request): boolean {
  if (!SERVICE_ROLE_KEY) return false;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token && token === SERVICE_ROLE_KEY) return true;
  return (req.headers.get("apikey") ?? "").trim() === SERVICE_ROLE_KEY;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST" || !authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }

  const startedAt = Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const summary = {
    ok: false,
    rules: 0,
    evaluated: 0,
    skipped: [] as string[],
    fired: [] as string[],
    resolved: [] as string[],
    cooldown_suppressed: [] as string[],
    emails_attempted: 0,
    emails_sent: 0,
    email_errors: [] as string[],
    warnings: [] as string[],
    duration_ms: 0,
  };

  try {
    const rulesRes = await sb
      .from("alert_rules")
      .select("code, name, description, severity, enabled, threshold, window_minutes, cooldown_seconds");
    if (rulesRes.error) throw new Error(`alert_rules: ${rulesRes.error.message}`);
    const rules = (rulesRes.data ?? []) as RuleRow[];
    summary.rules = rules.length;
    const codes = rules.map(r => r.code);

    const openRes = await sb
      .from("alert_events")
      .select("id, rule_code, state, severity, email_sent_at, email_attempts, created_at")
      .in("rule_code", codes)
      .in("state", ["firing", "acknowledged"]);
    if (openRes.error) throw new Error(`alert_events open: ${openRes.error.message}`);
    const openByRule = new Map<string, EventRow>();
    for (const ev of (openRes.data ?? []) as EventRow[]) openByRule.set(ev.rule_code, ev);

    const resolvedRes = await sb
      .from("alert_events")
      .select("rule_code, resolved_at")
      .in("rule_code", codes)
      .eq("state", "resolved")
      .not("resolved_at", "is", null)
      .order("resolved_at", { ascending: false })
      .limit(500);
    if (resolvedRes.error) throw new Error(`alert_events resolved: ${resolvedRes.error.message}`);
    const lastResolvedAt = new Map<string, number>();
    for (const row of (resolvedRes.data ?? []) as any[]) {
      if (!lastResolvedAt.has(row.rule_code)) {
        const t = Date.parse(row.resolved_at);
        if (Number.isFinite(t)) lastResolvedAt.set(row.rule_code, t);
      }
    }

    for (const rule of rules) {
      const open = openByRule.get(rule.code);

      // Disabled while active: mute silently (no resolution email, no re-fire).
      if (!rule.enabled) {
        if (open) {
          const patch: Record<string, unknown> = {
            state: "resolved",
            resolved_at: nowIso,
          };
          if (!open.email_sent_at) patch.email_sent_at = nowIso; // suppress pending send
          const { error } = await sb.from("alert_events").update(patch).eq("id", open.id);
          if (error) console.warn(`[alert-evaluator] disable-resolve failed rule=${rule.code} err=${error.message}`);
          else summary.resolved.push(rule.code);
        }
        continue;
      }

      summary.evaluated += 1;
      const outcome = await evaluate(sb, rule, startedAt);
      if (outcome.kind === "skip") {
        summary.skipped.push(`${rule.code}: ${outcome.reason}`);
        console.warn(`[alert-evaluator] skip rule=${rule.code} reason=${outcome.reason}`);
        continue;
      }

      if (outcome.fired) {
        if (open) continue; // already firing/acknowledged — dedupe by open row
        const resolvedAt = lastResolvedAt.get(rule.code);
        if (resolvedAt != null && startedAt - resolvedAt < rule.cooldown_seconds * 1000) {
          summary.cooldown_suppressed.push(rule.code);
          continue;
        }
        const { data, error } = await sb
          .from("alert_events")
          .insert({
            rule_code: rule.code,
            state: "firing",
            severity: rule.severity,
            value: outcome.value,
            message: outcome.message.slice(0, MESSAGE_MAX),
          })
          .select("id")
          .single();
        if (error) {
          if (error.code === "23505") continue; // concurrent tick won the race
          summary.skipped.push(`${rule.code}: insert failed ${error.message}`);
          console.warn(`[alert-evaluator] fire insert failed rule=${rule.code} err=${error.message}`);
          continue;
        }
        if (data) summary.fired.push(rule.code);
        continue;
      }

      // Condition cleared: transition the open row to resolved and reset
      // delivery so the recovery email goes through the normal retry pass.
      if (open) {
        const { data, error } = await sb
          .from("alert_events")
          .update({
            state: "resolved",
            resolved_at: nowIso,
            email_sent_at: null,
            email_attempts: 0,
            email_last_error: null,
            email_next_attempt_at: nowIso,
          })
          .eq("id", open.id)
          .eq("state", open.state)
          .select("id")
          .maybeSingle();
        if (!error && data) summary.resolved.push(rule.code);
        if (error) console.warn(`[alert-evaluator] resolve failed rule=${rule.code} err=${error.message}`);
      }
    }

    // --- Email delivery pass: unsent events, capped per run. A claim
    // (compare-and-set on email_next_attempt_at) is taken before sending so
    // overlapping cron ticks cannot double-send; backoff lives in that same
    // field (1m, 2m, 4m ... capped at 30m). Eligibility is filtered in SQL so
    // permanently dead rows (resolved events past their cap or lookback)
    // cannot fill the batch window and starve newer firing emails.
    const recipientsRes = await sb
      .from("alert_recipients")
      .select("email, min_severity")
      .eq("enabled", true);
    const recipients: RecipientRow[] = recipientsRes.error ? [] : ((recipientsRes.data ?? []) as RecipientRow[]);
    if (recipientsRes.error) {
      console.warn(`[alert-evaluator] alert_recipients unreadable err=${recipientsRes.error.message}`);
    }

    const lookbackIso = new Date(startedAt - EMAIL_RETRY_LOOKBACK_MS).toISOString();
    const unsentRes = await sb
      .from("alert_events")
      .select("id, rule_code, state, severity, email_attempts, email_next_attempt_at, created_at, resolved_at, message, value")
      .is("email_sent_at", null)
      .or(
        `state.neq.resolved,and(state.eq.resolved,email_attempts.lt.${EMAIL_MAX_ATTEMPTS},resolved_at.gte.${lookbackIso})`,
      )
      .order("created_at", { ascending: true })
      .limit(EMAIL_BATCH_LIMIT * 3);
    if (unsentRes.error) throw new Error(`alert_events unsent: ${unsentRes.error.message}`);

    const rulesByCode = new Map(rules.map(r => [r.code, r]));
    let emailAttemptsThisRun = 0;

    for (const ev of (unsentRes.data ?? []) as any[]) {
      if (emailAttemptsThisRun >= EMAIL_BATCH_LIMIT) break;
      const rule = rulesByCode.get(ev.rule_code);
      if (!rule) continue;
      const nextAt = Date.parse(ev.email_next_attempt_at ?? nowIso);
      if (Number.isFinite(nextAt) && nextAt > startedAt) continue; // still backing off

      // Claim: move next_attempt forward under CAS; only one run wins.
      let claimQuery = sb.from("alert_events")
        .update({ email_next_attempt_at: new Date(startedAt + EMAIL_CLAIM_LEASE_MS).toISOString() })
        .eq("id", ev.id)
        .is("email_sent_at", null);
      claimQuery = ev.email_next_attempt_at == null
        ? claimQuery.is("email_next_attempt_at", null)
        : claimQuery.eq("email_next_attempt_at", ev.email_next_attempt_at);
      const claimRes = await claimQuery.select("id");
      if (claimRes.error) {
        summary.email_errors.push(`${ev.rule_code}: claim failed ${claimRes.error.message}`);
        continue;
      }
      if (!claimRes.data || claimRes.data.length === 0) continue; // another run owns this attempt

      emailAttemptsThisRun += 1;
      summary.emails_attempted += 1;

      if (RESEND_API_KEY === "") {
        summary.email_errors.push(`${ev.rule_code}: RESEND_API_KEY not configured`);
        await sb.from("alert_events").update({
          email_last_error: "RESEND_API_KEY missing",
          email_next_attempt_at: new Date(startedAt + EMAIL_MISSING_KEY_RETRY_MS).toISOString(),
        }).eq("id", ev.id);
        continue;
      }

      const result = await sendAlertEmail(
        rule,
        ev,
        recipients,
        ev.state === "resolved" ? "resolved" : "firing",
      );
      if (result.ok) {
        const { error } = await sb.from("alert_events")
          .update({
            email_sent_at: new Date(Date.now()).toISOString(),
            email_last_error: null,
            email_next_attempt_at: nowIso,
          })
          .eq("id", ev.id)
          .is("email_sent_at", null);
        if (error) summary.email_errors.push(`${ev.rule_code}: mark sent failed ${error.message}`);
        else summary.emails_sent += result.sent;
      } else {
        const attempts = ev.email_attempts + 1;
        const backoffSec = Math.min(60 * 2 ** Math.min(ev.email_attempts, 9), 1800);
        const { error } = await sb.from("alert_events")
          .update({
            email_attempts: attempts,
            email_last_error: (result.error ?? "unknown").slice(0, 300),
            email_next_attempt_at: new Date(startedAt + backoffSec * 1000).toISOString(),
          })
          .eq("id", ev.id)
          .lt("email_attempts", attempts); // CAS: do not clobber a concurrent update
        if (error) summary.email_errors.push(`${ev.rule_code}: record failure ${error.message}`);
        summary.email_errors.push(`${ev.rule_code}: ${result.error}`);
      }
    }

    // --- Self-liveness (dead-man's switch surface).
    summary.duration_ms = Date.now() - startedAt;
    summary.ok = true;
    const { error: selfErr } = await sb.rpc("record_probe_result", {
      p_target: "alert_evaluator",
      p_state: "up",
      p_latency_ms: summary.duration_ms,
      p_detail: `rules=${summary.rules} fired=${summary.fired.length} resolved=${summary.resolved.length} emailed=${summary.emails_sent}`,
    });
    if (selfErr) {
      // The one write the dead-man surface depends on — never fail silently.
      summary.warnings.push(`alert_evaluator self-probe failed: ${selfErr.message}`);
      console.warn(`[alert-evaluator] self-probe write failed err=${selfErr.message}`);
    }
    await sentryCheckIn("ok");
    return Response.json(summary, { headers: corsHeaders });
  } catch (err) {
    summary.duration_ms = Date.now() - startedAt;
    summary.ok = false;
    console.error(`[alert-evaluator] run failed: ${err instanceof Error ? err.message : String(err)}`);
    await sentryCheckIn("error");
    return Response.json(summary, { status: 500, headers: corsHeaders });
  }
});
