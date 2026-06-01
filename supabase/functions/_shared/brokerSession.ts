import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import {
  classifyBrokerConnectError,
  friendlyBrokerConnectError,
} from "./brokerConnectError.ts"
import {
  decryptMtPassword,
  encryptMtPassword,
  isBrokerCredentialsCryptoConfigured,
} from "./brokerCredentialsCrypto.ts"
import {
  makeClientFromEnv,
  MetatraderApiClient,
  MetatraderApiError,
  MT_SESSION_EXPIRED_HINT,
  type MtPlatform,
} from "./metatraderapi.ts"
import { withMtServerSessionLock } from "./mtServerSessionLock.ts"

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
  connection_error_kind?: string
  summary?: Awaited<ReturnType<MetatraderApiClient["accountSummary"]>> | null
}

export function stripBrokerSecretFields<T extends Record<string, unknown>>(row: T): Omit<T, "mt_password_encrypted"> {
  const { mt_password_encrypted: _omit, ...rest } = row
  return rest
}

export async function resolveStoredMtPassword(
  broker: {
    auto_reconnect_enabled?: boolean | null
    mt_password_encrypted?: string | null
  },
  opts: { password?: string },
  env: { get(name: string): string | undefined },
): Promise<string | undefined> {
  const explicit = opts.password?.trim()
  if (explicit) return explicit
  if (!broker.auto_reconnect_enabled || !broker.mt_password_encrypted) return undefined
  const decrypted = await decryptMtPassword(broker.mt_password_encrypted, env)
  return decrypted?.trim() || undefined
}

export async function persistMtPasswordIfRequested(
  supabase: SupabaseClient,
  brokerId: string,
  userId: string,
  password: string | undefined,
  remember: boolean | undefined,
  env: { get(name: string): string | undefined },
): Promise<"saved" | "cleared" | "skipped" | "missing_key" | "encrypt_failed"> {
  if (remember === false) {
    await supabase
      .from("broker_accounts")
      .update({
        mt_password_encrypted: null,
        auto_reconnect_enabled: false,
        password_updated_at: null,
      })
      .eq("id", brokerId)
      .eq("user_id", userId)
    return "cleared"
  }
  if (!remember || !password?.trim()) return "skipped"
  if (!isBrokerCredentialsCryptoConfigured(env)) return "missing_key"
  const enc = await encryptMtPassword(password.trim(), env)
  if (!enc) return "encrypt_failed"
  await supabase
    .from("broker_accounts")
    .update({
      mt_password_encrypted: enc,
      auto_reconnect_enabled: true,
      password_updated_at: new Date().toISOString(),
    })
    .eq("id", brokerId)
    .eq("user_id", userId)
  return "saved"
}

export async function clearStoredMtPassword(
  supabase: SupabaseClient,
  brokerId: string,
  userId: string,
): Promise<void> {
  await supabase
    .from("broker_accounts")
    .update({
      mt_password_encrypted: null,
      auto_reconnect_enabled: false,
      password_updated_at: null,
    })
    .eq("id", brokerId)
    .eq("user_id", userId)
}

function connectionErrorFromRaw(raw: string): { kind: string; message: string } {
  const kind = classifyBrokerConnectError(raw)
  return { kind, message: friendlyBrokerConnectError(raw) }
}

export async function markBrokerConnectionError(
  supabase: SupabaseClient,
  broker: { id: string; user_id: string },
  rawMessage: string,
): Promise<{ kind: string; message: string }> {
  const { kind, message } = connectionErrorFromRaw(rawMessage)
  await supabase
    .from("broker_accounts")
    .update({
      connection_status: "error",
      connection_error_kind: kind,
      connection_error_message: message,
    })
    .eq("id", broker.id)
    .eq("user_id", broker.user_id)
  return { kind, message }
}

export function brokerConnectionFailure(rawMessage: string): {
  ok: false
  connection_status: "error"
  message: string
  connection_error_kind: string
} {
  const { kind, message } = connectionErrorFromRaw(rawMessage)
  return { ok: false, connection_status: "error", message, connection_error_kind: kind }
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
    platform?: string | null
    account_login?: string | null
    broker_server?: string | null
    performance_baseline_balance?: number | null
    auto_reconnect_enabled?: boolean | null
    mt_password_encrypted?: string | null
  },
  opts?: {
    password?: string
    remember_password?: boolean
    env?: { get(name: string): string | undefined }
  },
): Promise<BrokerReconnectResult> {
  const env = opts?.env ?? Deno.env
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
    let alive = await keepBrokerSessionAlive(client, uuid)
    const password = await resolveStoredMtPassword(broker, opts ?? {}, env)
    if (!alive && password) {
      const login = String(broker.account_login ?? "").trim()
      const server = String(broker.broker_server ?? "").trim()
      if (login && server) {
        try {
          await withMtServerSessionLock(String(broker.platform ?? "MT5"), server, () =>
            client.connectEx({
              id: uuid,
              server,
              login,
              password,
            })
          )
          alive = await keepBrokerSessionAlive(client, uuid)
        } catch (e) {
          const raw = e instanceof MetatraderApiError ? e.message : e instanceof Error ? e.message : "Connect failed"
          const failure = await markBrokerConnectionError(supabase, broker, raw)
          return failure
        }
      }
    }
    if (!alive) {
      const failure = await markBrokerConnectionError(supabase, broker, MT_SESSION_EXPIRED_HINT)
      return failure
    }

    const tradingReady = await client.verifyTradingReady(uuid)
    if (!tradingReady) {
      const failure = await markBrokerConnectionError(supabase, broker, MT_SESSION_EXPIRED_HINT)
      return failure
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

    if (!summary) {
      const raw = lastErr instanceof Error ? lastErr.message : "AccountSummary returned no data"
      const failure = await markBrokerConnectionError(supabase, broker, raw)
      return failure
    }

    const updatePayload: Record<string, unknown> = {
      connection_status: "connected",
      connection_error_kind: null,
      connection_error_message: null,
      last_synced_at: new Date().toISOString(),
      last_balance: summary.balance ?? null,
      last_equity: summary.equity ?? null,
      last_currency: summary.currency ?? null,
    }
    if (
      broker.performance_baseline_balance == null &&
      summary.balance != null &&
      Number.isFinite(summary.balance)
    ) {
      updatePayload.performance_baseline_balance = summary.balance
    }

    await supabase
      .from("broker_accounts")
      .update(updatePayload)
      .eq("id", broker.id)
      .eq("user_id", broker.user_id)

    let passwordPersistStatus: Awaited<ReturnType<typeof persistMtPasswordIfRequested>> = "skipped"
    if (password && opts?.remember_password !== undefined) {
      passwordPersistStatus = await persistMtPasswordIfRequested(
        supabase,
        broker.id,
        broker.user_id,
        password,
        opts.remember_password,
        env,
      )
    } else if (password && broker.auto_reconnect_enabled && opts?.remember_password === undefined) {
      // Refresh ciphertext when auto-reconnect already enabled and user supplied a new password.
      passwordPersistStatus = await persistMtPasswordIfRequested(
        supabase,
        broker.id,
        broker.user_id,
        password,
        true,
        env,
      )
    }

    if (
      opts?.remember_password === true &&
      passwordPersistStatus !== "saved"
    ) {
      return {
        ok: true,
        connection_status: "connected",
        summary,
        message:
          "Connected, but the password could not be saved for automatic reconnect. Please verify BROKER_CREDENTIALS_ENCRYPTION_KEY (or legacy key alias) is configured in Edge Function secrets, then reconnect again.",
      }
    }

    return { ok: true, connection_status: "connected", summary }
  } catch (e) {
    const raw = e instanceof MetatraderApiError
      ? e.message
      : e instanceof Error
      ? e.message
      : "Reconnect failed"
    const failure = await markBrokerConnectionError(supabase, broker, raw)
    return failure
  }
}

export function makeMtClient(
  env: { get(name: string): string | undefined },
  platform: string,
): MetatraderApiClient {
  const p: MtPlatform = platform === "MT4" ? "MT4" : "MT5"
  return makeClientFromEnv(env, p)
}
