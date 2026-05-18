import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

export const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0')
export const API_HASH = process.env.TELEGRAM_API_HASH ?? ''

/**
 * Construct a TelegramClient with a fingerprint that matches what an official
 * Telegram desktop client sends. Avoids the generic GramJS defaults that
 * Telegram's anti-spam system flags on cold accounts from datacenter IPs.
 *
 * Reuse a single instance for the whole lifetime of an authenticated session
 * (auth + listener) — repeated connect/disconnect from datacenter IPs is one
 * of the strongest ban signals.
 */
export function buildClient(sessionString: string = ''): TelegramClient {
  if (!API_ID || !API_HASH) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH must be set in env')
  }
  return new TelegramClient(
    new StringSession(sessionString),
    API_ID,
    API_HASH,
    {
      connectionRetries: 5,
      retryDelay: 4000,
      // Manual recovery lives in UserListener.runWatchdog / forceReconnect.
      // Leaving autoReconnect on races with explicit disconnect+connect and is a
      // common trigger for Telegram AUTH_KEY_DUPLICATED after worker restarts.
      autoReconnect: false,
      useWSS: true,
      deviceModel: 'Desktop',
      systemVersion: 'Windows 10',
      appVersion: '5.6.3',
      langCode: 'en',
      systemLangCode: 'en',
      // Auto-sleep on FLOOD_WAIT under this many seconds instead of throwing.
      floodSleepThreshold: 60,
    }
  )
}

/**
 * Wrap a raw `client.invoke(...)` call so that long FLOOD_WAIT_N errors
 * (above floodSleepThreshold) are handled with a transparent backoff
 * instead of bubbling up. Use for auth flows where we cannot afford a
 * hard error mid-handshake.
 */
export const TELEGRAM_SESSION_INVALID_CODE = 'TELEGRAM_SESSION_INVALID' as const

export class TelegramSessionInvalidError extends Error {
  readonly code = TELEGRAM_SESSION_INVALID_CODE

  constructor(message = 'Telegram session is no longer valid') {
    super(message)
    this.name = 'TelegramSessionInvalidError'
  }
}

export function isAuthKeyUnregistered(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return m.includes('AUTH_KEY_UNREGISTERED')
}

export function rethrowIfSessionInvalid(err: unknown): never {
  if (isAuthKeyUnregistered(err)) {
    throw new TelegramSessionInvalidError()
  }
  throw err
}

export async function tgInvoke<T>(client: TelegramClient, req: unknown): Promise<T> {
  try {
    return (await client.invoke(req as never)) as T
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    const flood = m.match(/FLOOD_WAIT_(\d+)/)
    if (flood) {
      const waitSec = parseInt(flood[1], 10) + 2
      console.warn(`[telegram] FLOOD_WAIT_${flood[1]} — sleeping ${waitSec}s before retry`)
      await new Promise(r => setTimeout(r, waitSec * 1000))
      return tgInvoke<T>(client, req)
    }
    throw e
  }
}
