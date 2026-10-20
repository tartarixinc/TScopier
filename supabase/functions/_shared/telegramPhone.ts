/**
 * Normalizes a Telegram phone number to the same canonical form stored in
 * `telegram_account_claims.phone_number_normalized`.
 *
 * Kept in sync with `worker/src/telegramAccountClaims.ts` and
 * `telegram-listener/app/telegram_account_claims.py`.
 */
export function normalizeTelegramPhoneNumber(raw: string): string {
  const compact = String(raw ?? "")
    .trim()
    .replace(/[\s\-()]/g, "")
  if (compact.startsWith("00")) return `+${compact.slice(2)}`
  return compact
}
