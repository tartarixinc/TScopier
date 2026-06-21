export const TELEGRAM_ALREADY_LINKED_ERROR = 'TELEGRAM_ALREADY_LINKED'

type TelegramAuthErrorMessages = {
  telegramAlreadyLinked: string
}

export function resolveTelegramAuthError(
  error: unknown,
  fallback: string,
  messages: TelegramAuthErrorMessages,
): string {
  if (error === TELEGRAM_ALREADY_LINKED_ERROR) {
    return messages.telegramAlreadyLinked
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return fallback
}
