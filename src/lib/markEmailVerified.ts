import { supabase } from './supabase'

/** Client fallback when auth.users is confirmed but profile sync is slightly delayed. */
export async function markEmailVerified(): Promise<void> {
  const { error } = await supabase.rpc('mark_email_verified')
  if (error) throw new Error(error.message)
}
