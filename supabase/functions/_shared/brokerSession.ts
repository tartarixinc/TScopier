import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import {
  makeClientFromEnv,
  MetatraderApiClient,
  MetatraderApiError,
  type MtPlatform,
} from "./metatraderapi.ts"

export function parseBrokerSessionId(metaapiAccountId: string | null | undefined): string | null {
  const uuid = String(metaapiAccountId ?? "").trim()
  if (!uuid || uuid.includes("|")) return null
  return uuid
}

export function isLegacyBrokerLink(metaapiAccountId: string | null | undefined): boolean {
  const v = String(metaapiAccountId ?? "").trim()
  return v.length > 0 && v.includes("|")
}

export interface BrokerReconnectResult {
  ok: boolean
  connection_status: "connected" | "error"
  message?: string
  summary?: Awaited<ReturnType<MetatraderApiClient["accountSummary"]>> | null
}

/** Ping session; only calls ConnectByToken when CheckConnect fails. */
export async function keepBrokerSessionAlive(
  client: MetatraderApiClient,
  uuid: string,
): Promise<boolean> {
  return client.keepSessionAlive(uuid)
}

export async function reconnectBrokerSession(
  client: MetatraderApiClient,
  supabase: SupabaseClient,
  broker: {
    id: string
    user_id: string
    metaapi_account_id: string | null
    performance_baseline_balance?: number | null
  },
): Promise<BrokerReconnectResult> {
  const uuid = parseBrokerSessionId(broker.metaapi_account_id)
  if (!uuid) {
    return {
      ok: false,
      connection_status: "error",
      message: isLegacyBrokerLink(broker.metaapi_account_id)
        ? "This account uses the legacy link format. Remove it and connect again with your MT login and password."
        : "Broker is not linked to MetatraderAPI yet",
    }
  }

  try {
    const alive = await keepBrokerSessionAlive(client, uuid)
    if (!alive) {
      await supabase
        .from("broker_accounts")
        .update({ connection_status: "error" })
        .eq("id", broker.id)
        .eq("user_id", broker.user_id)
      return { ok: false, connection_status: "error", message: "Broker session is not connected" }
    }

    let summary: Awaited<ReturnType<MetatraderApiClient["accountSummary"]>> | null = null
    let lastErr: unknown = null
    for (let i = 0; i < 4; i++) {
      try {
        const s = await client.accountSummary(uuid)
        if (s && (s.balance != null || s.equity != null || s.currency)) {
          summary = s
          break
        }
      } catch (err) {
        lastErr = err
      }
      await new Promise((r) => setTimeout(r, 400 + i * 350))
    }

    const updatePayload: Record<string, unknown> = {
      connection_status: "connected",
      last_synced_at: new Date().toISOString(),
    }
    if (summary) {
      updatePayload.last_balance = summary.balance ?? null
      updatePayload.last_equity = summary.equity ?? null
      updatePayload.last_currency = summary.currency ?? null
      if (
        broker.performance_baseline_balance == null &&
        summary.balance != null &&
        Number.isFinite(summary.balance)
      ) {
        updatePayload.performance_baseline_balance = summary.balance
      }
    }

    await supabase
      .from("broker_accounts")
      .update(updatePayload)
      .eq("id", broker.id)
      .eq("user_id", broker.user_id)

    if (!summary && lastErr) {
      const msg = lastErr instanceof Error ? lastErr.message : "AccountSummary returned no data"
      return { ok: true, connection_status: "connected", message: msg, summary: null }
    }

    return { ok: true, connection_status: "connected", summary }
  } catch (e) {
    await supabase
      .from("broker_accounts")
      .update({ connection_status: "error" })
      .eq("id", broker.id)
      .eq("user_id", broker.user_id)

    const msg = e instanceof MetatraderApiError
      ? e.message
      : e instanceof Error
      ? e.message
      : "Reconnect failed"
    return { ok: false, connection_status: "error", message: msg }
  }
}

export function makeMtClient(
  env: { get(name: string): string | undefined },
  platform: string,
): MetatraderApiClient {
  const p: MtPlatform = platform === "MT4" ? "MT4" : "MT5"
  return makeClientFromEnv(env, p)
}
