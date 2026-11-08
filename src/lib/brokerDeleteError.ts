/**
 * Plain-English text for a failed broker-account delete.
 *
 * Postgres reports a blocked delete as a raw constraint error, which is useless
 * to a customer. Only two tables point at `broker_accounts` with ON DELETE
 * RESTRICT, so each gets its own instruction; any other foreign-key failure gets
 * a generic "still linked" message. Non-constraint errors pass through unchanged.
 */

const PROVIDER_SOURCE =
  'This account is your published provider account, so it can’t be deleted yet. Remove it from your provider profile first, then delete it.'
const COPYING_PROVIDER =
  'This account is currently copying a provider. Stop copying that provider first, then delete this account.'
const STILL_LINKED =
  'This account is still linked to another feature, so it can’t be deleted yet. Remove those links first, then try again.'

export function friendlyBrokerDeleteError(message: string): string {
  if (!/violates foreign key constraint|foreign key/i.test(message)) return message
  if (/social_copy_sources/i.test(message)) return PROVIDER_SOURCE
  if (/social_copy_subscriptions/i.test(message)) return COPYING_PROVIDER
  return STILL_LINKED
}
