export interface BacktestWorkerSyncResult {
  messages_scanned: number
  candidates: number
  imported: number
  errors: string[]
}

export async function syncBacktestSignalsViaWorker(
  env: { get: (key: string) => string | undefined },
  userId: string,
  channelIds: string[],
  dateFrom: string,
  dateTo: string,
  opts?: {
    runId?: string
    onChannelStart?: (channelIndex: number, channelId: string) => Promise<void>
  },
): Promise<BacktestWorkerSyncResult> {
  const workerUrl = (env.get("WORKER_URL") ?? "").trim().replace(/\/+$/, "")
  const token = (env.get("WORKER_INTERNAL_TOKEN") ?? "").trim()

  if (!workerUrl || !token) {
    return {
      messages_scanned: 0,
      candidates: 0,
      imported: 0,
      errors: ["WORKER_URL not configured — cannot sync Telegram signals"],
    }
  }

  let messagesScanned = 0
  let candidates = 0
  let imported = 0
  const errors: string[] = []

  for (let i = 0; i < channelIds.length; i++) {
    const channelRowId = channelIds[i]
    await opts?.onChannelStart?.(i, channelRowId)

    try {
      const res = await fetch(`${workerUrl}/auth/backtest_sync_signals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": token,
        },
        body: JSON.stringify({
          user_id: userId,
          channel_row_id: channelRowId,
          from: dateFrom,
          to: dateTo,
          run_id: opts?.runId,
        }),
      })
      const data = await res.json().catch(() => ({})) as BacktestWorkerSyncResult & { error?: string }
      if (!res.ok) {
        errors.push(data.error ?? `Telegram sync failed (${res.status})`)
        continue
      }
      messagesScanned += Number(data.messages_scanned ?? 0)
      candidates += Number(data.candidates ?? 0)
      imported += Number(data.imported ?? 0)
      for (const e of data.errors ?? []) {
        if (e) errors.push(e)
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  return { messages_scanned: messagesScanned, candidates, imported, errors }
}
