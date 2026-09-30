import { supabase } from './supabase'

export type ForceCloseTradesRequest =
  | {
      /**
       * Signal scope: close ONLY this signal's open positions across all
       * brokers that hold them.
       */
      signal_id: string
      broker_account_id?: never
      channel_id?: never
    }
  | {
      /** Close every trade for the user on this broker (optionally one channel). */
      broker_account_id: string
      channel_id?: string | null
      signal_id?: never
    }

export type ForceCloseTradesResponse = {
  ok: boolean
  closed: number
  failed: number
  pending_cancelled: number
  virtual_legs_deleted: number
  channels_processed: number
  reason?: string
  error?: string
}

async function call<T>(body: ForceCloseTradesRequest): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/force-close-trades`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify(body),
      // A hung request must not trap the modal with every dismissal control
      // disabled; closes are sequential per leg, so allow a long but finite run.
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('The trade service timed out. Please try again.', { cause: err })
    }
    throw new Error('Could not reach force-close-trades. Deploy the edge function first.', { cause: err })
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
      ? String((data as Record<string, unknown>).error)
      : text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  // A gateway/proxy can answer 200 with a non-JSON body; never let that read
  // as a result with undefined counters.
  if (!data || typeof data !== 'object' || typeof (data as { closed?: unknown }).closed !== 'number') {
    throw new Error('Force close returned an unexpected response')
  }
  return data as T
}

export const forceCloseTradesApi = {
  close(body: ForceCloseTradesRequest): Promise<ForceCloseTradesResponse> {
    return call<ForceCloseTradesResponse>(body)
  },
}
