/** Base currencies available in Settings (ISO 4217). */
export const BASE_CURRENCIES: readonly { value: string; label: string }[] = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'NZD', label: 'NZD — New Zealand Dollar' },
  { value: 'SEK', label: 'SEK — Swedish Krona' },
  { value: 'NOK', label: 'NOK — Norwegian Krone' },
  { value: 'DKK', label: 'DKK — Danish Krone' },
  { value: 'PLN', label: 'PLN — Polish Złoty' },
  { value: 'CZK', label: 'CZK — Czech Koruna' },
  { value: 'HUF', label: 'HUF — Hungarian Forint' },
  { value: 'RON', label: 'RON — Romanian Leu' },
  { value: 'TRY', label: 'TRY — Turkish Lira' },
  { value: 'ZAR', label: 'ZAR — South African Rand' },
  { value: 'SGD', label: 'SGD — Singapore Dollar' },
  { value: 'HKD', label: 'HKD — Hong Kong Dollar' },
  { value: 'CNH', label: 'CNH — Chinese Yuan (offshore)' },
  { value: 'CNY', label: 'CNY — Chinese Yuan' },
  { value: 'MXN', label: 'MXN — Mexican Peso' },
  { value: 'BRL', label: 'BRL — Brazilian Real' },
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'KRW', label: 'KRW — South Korean Won' },
  { value: 'THB', label: 'THB — Thai Baht' },
  { value: 'MYR', label: 'MYR — Malaysian Ringgit' },
  { value: 'PHP', label: 'PHP — Philippine Peso' },
  { value: 'IDR', label: 'IDR — Indonesian Rupiah' },
  { value: 'TWD', label: 'TWD — New Taiwan Dollar' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'SAR', label: 'SAR — Saudi Riyal' },
  { value: 'ILS', label: 'ILS — Israeli Shekel' },
] as const

export const BASE_CURRENCY_CODES = new Set(BASE_CURRENCIES.map(c => c.value))

export function isSupportedBaseCurrency(code: string): boolean {
  return BASE_CURRENCY_CODES.has(code.toUpperCase())
}
