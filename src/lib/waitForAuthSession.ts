import { supabase } from './supabase'

/** Wait for Supabase to parse magic-link / OAuth tokens from the URL hash. */
export async function waitForAuthSession(opts?: {
  maxAttempts?: number
  delayMs?: number
}): Promise<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']> {
  const maxAttempts = opts?.maxAttempts ?? 24
  const delayMs = opts?.delayMs ?? 250

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) return session
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  return null
}
