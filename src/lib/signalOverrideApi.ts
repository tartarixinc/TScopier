import { supabase } from './supabase'

export type SignalOverrideSaveRequest = {
  signal_id: string
  sl: number | null
  tp_levels: number[]
}

export type SignalOverrideSaveResponse = {
  ok: true
  applied_legs: number
  failed_legs?: number
  open: boolean
  errors?: string[]
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/signal-override`
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
    throw new Error('Could not reach signal-override. Deploy the edge function first.')
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

export const signalOverrideApi = {
  save(body: SignalOverrideSaveRequest): Promise<SignalOverrideSaveResponse> {
    return call<SignalOverrideSaveResponse>(body)
  },
}
