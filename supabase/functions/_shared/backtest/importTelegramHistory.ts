/**
 * Pull Telegram channel history for the backtest date window via the worker,
 * then sync into backtest_channel_signals.
 */
export async function importTelegramHistoryForBacktest(
  env: { get(name: string): string | undefined },
  userId: string,
  channelIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<{ imported: number; errors: string[] }> {
  const workerUrl = (env.get("WORKER_URL") ?? "").trim().replace(/\/+$/, "")
  const token = env.get("WORKER_INTERNAL_TOKEN") ?? ""
  if (!workerUrl || !token) {
    return {
      imported: 0,
      errors: ["WORKER_URL not configured — using copier signals only"],
    }
  }

  const base = /^https?:\/\//i.test(workerUrl) ? workerUrl : `https://${workerUrl}`
  const errors: string[] = []
  let imported = 0

  for (const channelRowId of channelIds) {
    try {
      const res = await fetch(`${base}/auth/import_backtest_history`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": token,
        },
        body: JSON.stringify({
          user_id: userId,
          channel_row_id: channelRowId,
          from: dateFrom,
          to: dateTo,
        }),
      })
      const data = await res.json().catch(() => ({})) as { imported?: number; error?: string }
      if (!res.ok) {
        errors.push(data.error ?? `Import failed for channel ${channelRowId} (${res.status})`)
        continue
      }
      imported += Number(data.imported ?? 0)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  return { imported, errors }
}
