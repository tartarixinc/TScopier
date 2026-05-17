import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { tradeableFromParsed } from "./parsedToUpsert.ts"

export interface BacktestImportResult {
  imported: number
  messages_scanned: number
  errors: string[]
}

type WorkerMessage = {
  telegram_message_id: string
  raw_message: string
  signal_at: string
}

/**
 * Fetch Telegram history via worker, parse without touching `signals`,
 * store tradeable rows in `backtest_channel_signals` only.
 */
export async function importTelegramHistoryForBacktest(
  supabase: SupabaseClient,
  env: { get(name: string): string | undefined },
  userId: string,
  channelIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<BacktestImportResult> {
  const fromIso = new Date(dateFrom).toISOString()
  const toIso = new Date(dateTo + "T23:59:59.999Z").toISOString()
  const errors: string[] = []
  let imported = 0
  let messagesScanned = 0

  if (channelIds.length === 0) {
    return { imported: 0, messages_scanned: 0, errors: [] }
  }

  const workerUrl = (env.get("WORKER_URL") ?? "").trim().replace(/\/+$/, "")
  const workerToken = env.get("WORKER_INTERNAL_TOKEN") ?? ""
  const supabaseUrl = (env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")
  const serviceKey = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

  if (!workerUrl || !workerToken) {
    return {
      imported: 0,
      messages_scanned: 0,
      errors: ["WORKER_URL not configured — cannot import Telegram history"],
    }
  }

  const workerBase = /^https?:\/\//i.test(workerUrl) ? workerUrl : `https://${workerUrl}`

  const pushImportError = (errors: string[], msg: string) => {
    if (errors.length < 5) {
      errors.push(msg)
      return
    }
    const last = errors[errors.length - 1]
    if (!last?.startsWith("(+")) {
      errors.push("(+more errors; fix parse auth and redeploy backtest-run + parse-signal)")
    }
  }

  for (const channelRowId of channelIds) {
    let messages: WorkerMessage[] = []
    try {
      const res = await fetch(`${workerBase}/auth/import_backtest_history`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": workerToken,
        },
        body: JSON.stringify({
          user_id: userId,
          channel_row_id: channelRowId,
          from: dateFrom,
          to: dateTo,
        }),
      })
      const data = await res.json().catch(() => ({})) as {
        messages?: WorkerMessage[]
        messages_scanned?: number
        error?: string
      }
      if (!res.ok) {
        pushImportError(errors, data.error ?? `Telegram fetch failed (${res.status})`)
        continue
      }
      messages = data.messages ?? []
      messagesScanned += Number(data.messages_scanned ?? messages.length)
    } catch (e) {
      pushImportError(errors, e instanceof Error ? e.message : String(e))
      continue
    }

    if (messages.length === 0) continue

    // Replace prior import rows for this channel/range only after a successful Telegram fetch.
    const { error: delErr } = await supabase
      .from("backtest_channel_signals")
      .delete()
      .eq("user_id", userId)
      .eq("channel_id", channelRowId)
      .eq("source", "telegram_import")
      .gte("signal_at", fromIso)
      .lte("signal_at", toIso)
    if (delErr) {
      pushImportError(errors, `clear prior import: ${delErr.message}`)
      continue
    }

    for (const msg of messages) {
      if (!msg.raw_message?.trim() || !msg.telegram_message_id) continue

      try {
        const parseBody = await invokeParseSignal(supabase, serviceKey, supabaseUrl, {
          parse_only: true,
          channel_id: channelRowId,
          raw_message: msg.raw_message,
        })
        if (parseBody.error) {
          pushImportError(errors, parseBody.error)
          continue
        }
        if (parseBody.status !== "parsed" || !parseBody.parsed) continue

        const tradeable = tradeableFromParsed(parseBody.parsed)
        if (!tradeable) continue

        const { error: upsertErr } = await supabase.rpc("upsert_backtest_channel_signal", {
          p_user_id: userId,
          p_channel_id: channelRowId,
          p_signal_id: null,
          p_telegram_message_id: msg.telegram_message_id,
          p_source: "telegram_import",
          p_direction: tradeable.direction,
          p_symbol: tradeable.symbol,
          p_entry_price: tradeable.entry_price,
          p_sl: tradeable.sl,
          p_tp_levels: tradeable.tp_levels,
          p_lot_size: tradeable.lot_size,
          p_raw_message: msg.raw_message,
          p_parsed_data: parseBody.parsed,
          p_signal_at: msg.signal_at,
        })
        if (upsertErr) {
          pushImportError(errors, upsertErr.message)
          continue
        }
        imported++
      } catch (e) {
        pushImportError(errors, e instanceof Error ? e.message : String(e))
      }
    }
  }

  return { imported, messages_scanned: messagesScanned, errors }
}

type ParseSignalBody = {
  parse_only: true
  channel_id: string
  raw_message: string
}

type ParseSignalResult = {
  parsed?: Record<string, unknown>
  status?: string
  error?: string
}

/** Invoke parse-signal with service-role auth (anon apikey + service bearer caused 401). */
async function invokeParseSignal(
  supabase: SupabaseClient,
  serviceKey: string,
  supabaseUrl: string,
  body: ParseSignalBody,
): Promise<ParseSignalResult> {
  const { data, error } = await supabase.functions.invoke("parse-signal", { body })
  if (!error && data && typeof data === "object") {
    const row = data as ParseSignalResult & { error?: string }
    if (row.error) return { error: row.error }
    return row
  }

  if (serviceKey && supabaseUrl) {
    const parseUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/parse-signal`
    const parseRes = await fetch(parseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify(body),
    })
    const parseBody = await parseRes.json().catch(() => ({})) as ParseSignalResult
    if (!parseRes.ok) {
      return {
        error: parseBody.error
          ?? `parse failed (${parseRes.status}) — redeploy parse-signal with verify_jwt=false`,
      }
    }
    return parseBody
  }

  return {
    error: error?.message ?? "parse-signal invoke failed (check SUPABASE_SERVICE_ROLE_KEY)",
  }
}
