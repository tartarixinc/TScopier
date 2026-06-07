import { supabase } from './supabase'

async function invokeAdmin<T>(fn: 'admin-query' | 'admin-mutate', body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) throw new Error('Not signed in')

  const res = await supabase.functions.invoke(fn, {
    body,
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.error) throw new Error(res.error.message)
  const payload = res.data as { error?: string } & T
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new Error(payload.error)
  }
  return payload as T
}

export function adminQuery<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  return invokeAdmin<T>('admin-query', { action, ...body })
}

export function adminMutate<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  return invokeAdmin<T>('admin-mutate', { action, ...body })
}
