import { supabase } from './supabase'

export type RetryActivityRequest = {
  log_id?: string
  log_ids?: string[]
}

export type RetryActivityItemResult = {
  log_id: string
  ok: boolean
  reason?: string
  error?: string
}

export type RetryActivityResponse = {
  ok: boolean
  retried: number
  failed: number
  results: RetryActivityItemResult[]
}

async function call<T>(body: RetryActivityRequest): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/retry-activity`
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
    throw new Error('Could not reach retry-activity. Deploy the edge function first.')
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

export const retryActivityApi = {
  retry(body: RetryActivityRequest): Promise<RetryActivityResponse> {
    return call<RetryActivityResponse>(body)
  },
}
