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

  await supabase
    .from("backtest_channel_signals")
    .delete()
    .eq("user_id", userId)
    .in("channel_id", channelIds)
    .eq("source", "telegram_import")
    .gte("signal_at", fromIso)
    .lte("signal_at", toIso)

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
  const parseUrl = `${supabaseUrl}/functions/v1/parse-signal`

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
        errors.push(data.error ?? `Telegram fetch failed (${res.status})`)
        continue
      }
      messages = data.messages ?? []
      messagesScanned += Number(data.messages_scanned ?? messages.length)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
      continue
    }

    for (const msg of messages) {
      if (!msg.raw_message?.trim() || !msg.telegram_message_id) continue

      try {
        const parseRes = await fetch(parseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: env.get("SUPABASE_ANON_KEY") ?? serviceKey,
          },
          body: JSON.stringify({
            parse_only: true,
            channel_id: channelRowId,
            raw_message: msg.raw_message,
          }),
        })
        const parseBody = await parseRes.json().catch(() => ({})) as {
          parsed?: Record<string, unknown>
          status?: string
          error?: string
        }
        if (!parseRes.ok) {
          errors.push(parseBody.error ?? `parse failed (${parseRes.status})`)
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
          errors.push(upsertErr.message)
          continue
        }
        imported++
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
  }

  return { imported, messages_scanned: messagesScanned, errors }
}
