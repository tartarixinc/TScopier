import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword, encryptMtPassword } from '../brokerCredentialsCrypto'
import type { CtraderCredential } from '../ctraderProvider'

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

function environmentOf(value: unknown): 'demo' | 'live' {
  return String(value ?? '').trim().toLowerCase() === 'live' ? 'live' : 'demo'
}

export async function loadCtraderCredential(accountId: string): Promise<CtraderCredential | null> {
  const supabase = serviceClient()
  const clientId = String(process.env.CTRADER_CLIENT_ID ?? '').trim()
  const clientSecret = String(process.env.CTRADER_CLIENT_SECRET ?? '').trim()
  if (!supabase || !clientId || !clientSecret) return null
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('ctrader_account_id,ctrader_environment,ctrader_access_token_encrypted,ctrader_refresh_token_encrypted,ctrader_token_expires_at')
    .eq('provider', 'ctrader')
    .eq('ctrader_account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  const accessToken = decryptMtPassword(data.ctrader_access_token_encrypted)
  const refreshToken = decryptMtPassword(data.ctrader_refresh_token_encrypted) ?? ''
  if (!accessToken) return null
  return {
    accountId,
    environment: environmentOf(data.ctrader_environment),
    accessToken,
    refreshToken,
    expiresAt: data.ctrader_token_expires_at ?? null,
    clientId,
    clientSecret,
  }
}

export async function saveCtraderCredential(credential: CtraderCredential): Promise<void> {
  const supabase = serviceClient()
  if (!supabase) return
  const access = encryptMtPassword(credential.accessToken)
  const refresh = credential.refreshToken ? encryptMtPassword(credential.refreshToken) : null
  if (!access) return
  await supabase
    .from('broker_accounts')
    .update({
      ctrader_access_token_encrypted: access,
      ctrader_refresh_token_encrypted: refresh,
      ctrader_token_expires_at: credential.expiresAt,
      ctrader_status: 'connected',
    })
    .eq('provider', 'ctrader')
    .eq('ctrader_account_id', credential.accountId)
}
