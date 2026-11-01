import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe link tokens are HMAC-SHA256(service_role_key, user_id) in hex.
 *
 * The token is minted by the campaign sender and verified by the
 * `email-unsubscribe` function. Both sides must hold the same service-role
 * key string; when they do not (key rotation, sender running in another
 * project), verification fails and the user sees "Link expired". The
 * `email-unsubscribe` recovery flow re-mints a fresh token with the
 * verifier's own key so users are never stuck on a dead link.
 */

export function mintUnsubscribeToken(
  serviceRoleKey: string,
  userId: string,
): string {
  return createHmac("sha256", serviceRoleKey).update(userId).digest("hex");
}

export function verifyUnsubscribeToken(
  serviceRoleKey: string,
  userId: string,
  token: string,
): boolean {
  const expected = mintUnsubscribeToken(serviceRoleKey, userId);
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(token, "utf-8"),
      Buffer.from(expected, "utf-8"),
    );
  } catch {
    return false;
  }
}
