import { supabase } from './supabase'

export type ForceCloseTradesRequest = {
  broker_account_id: string
  channel_id?: string | null
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
    })
  } catch {
    throw new Error('Could not reach force-close-trades. Deploy the edge function first.')
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
  return data as T
}

export const forceCloseTradesApi = {
  close(body: ForceCloseTradesRequest): Promise<ForceCloseTradesResponse> {
    return call<ForceCloseTradesResponse>(body)
  },
}
