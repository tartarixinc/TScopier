import { createClient } from '@supabase/supabase-js'
import { decryptMtPassword, encryptMtPassword } from '../brokerCredentialsCrypto'
import type { CtraderCredential } from '../ctraderProvider'

export const CTRADER_APP_CREDENTIALS_MISSING =
  'cTrader Open API app credentials are missing on the trade worker'
export const CTRADER_TOKEN_UNREADABLE = 'cTrader access token could not be read'

const ACCOUNT_COLUMNS = 'ctrader_account_id,ctrader_environment,ctrader_access_token_encrypted,ctrader_refresh_token_encrypted,ctrader_token_expires_at'
const APP_COLUMNS = 'ctrader_client_id_encrypted,ctrader_client_secret_encrypted'

function serviceClient() {
  const url = String(process.env.SUPABASE_URL ?? '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !key) return null
  return createClient(url, key)
}

function environmentOf(value: unknown): 'demo' | 'live' {
  return String(value ?? '').trim().toLowerCase() === 'live' ? 'live' : 'demo'
}

function missingAppColumn(message: string): boolean {
  return /ctrader_client_id_encrypted|ctrader_client_secret_encrypted/i.test(message)
}

/** Env credentials win. Stored ciphertext is the fallback from account link. */
export function pickCtraderAppCredentials(
  fromEnv: { clientId: string; clientSecret: string },
  stored: { clientId: string | null; clientSecret: string | null },
): { clientId: string; clientSecret: string } | null {
  const clientId = fromEnv.clientId || stored.clientId || ''
  const clientSecret = fromEnv.clientSecret || stored.clientSecret || ''
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export async function loadCtraderCredential(accountId: string): Promise<CtraderCredential | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  const withApp = await supabase
    .from('broker_accounts')
    .select(`${ACCOUNT_COLUMNS},${APP_COLUMNS}`)
    .eq('provider', 'ctrader')
    .eq('ctrader_account_id', accountId)
    .maybeSingle()
  const { data, error } = withApp.error && missingAppColumn(withApp.error.message)
    ? await supabase
      .from('broker_accounts')
      .select(ACCOUNT_COLUMNS)
      .eq('provider', 'ctrader')
      .eq('ctrader_account_id', accountId)
      .maybeSingle()
    : withApp
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as Record<string, string | null>
  const app = pickCtraderAppCredentials(
    {
      clientId: String(process.env.CTRADER_CLIENT_ID ?? '').trim(),
      clientSecret: String(process.env.CTRADER_CLIENT_SECRET ?? '').trim(),
    },
    {
      clientId: decryptMtPassword(row.ctrader_client_id_encrypted),
      clientSecret: decryptMtPassword(row.ctrader_client_secret_encrypted),
    },
  )
  if (!app) throw new Error(CTRADER_APP_CREDENTIALS_MISSING)
  const accessToken = decryptMtPassword(row.ctrader_access_token_encrypted)
  const refreshToken = decryptMtPassword(row.ctrader_refresh_token_encrypted) ?? ''
  if (!accessToken) throw new Error(CTRADER_TOKEN_UNREADABLE)
  return {
    accountId,
    environment: environmentOf(row.ctrader_environment),
    accessToken,
    refreshToken,
    expiresAt: row.ctrader_token_expires_at ?? null,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  }
}

export async function saveCtraderCredential(credential: CtraderCredential): Promise<void> {
  const supabase = serviceClient()
  if (!supabase) return
  const access = encryptMtPassword(credential.accessToken)
  const refresh = credential.refreshToken ? encryptMtPassword(credential.refreshToken) : null
  const clientId = encryptMtPassword(credential.clientId)
  const clientSecret = encryptMtPassword(credential.clientSecret)
  if (!access) return
  const patch: Record<string, string | null> = {
    ctrader_access_token_encrypted: access,
    ctrader_refresh_token_encrypted: refresh,
    ctrader_token_expires_at: credential.expiresAt,
    ctrader_status: 'connected',
  }
  if (clientId && clientSecret) {
    patch.ctrader_client_id_encrypted = clientId
    patch.ctrader_client_secret_encrypted = clientSecret
  }
  const { error } = await supabase
    .from('broker_accounts')
    .update(patch)
    .eq('provider', 'ctrader')
    .eq('ctrader_account_id', credential.accountId)
  if (error && missingAppColumn(error.message)) {
    delete patch.ctrader_client_id_encrypted
    delete patch.ctrader_client_secret_encrypted
    await supabase
      .from('broker_accounts')
      .update(patch)
      .eq('provider', 'ctrader')
      .eq('ctrader_account_id', credential.accountId)
  }
}
