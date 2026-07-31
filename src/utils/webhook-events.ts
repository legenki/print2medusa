import { createHash, timingSafeEqual } from "crypto"

/**
 * Constant-time comparison of the configured secret against the token supplied
 * in the request path. Both sides are hashed first so differing lengths cannot
 * throw and cannot leak length through timing.
 */
export function verifyWebhookToken(
  configured: string | null | undefined,
  provided: string | null | undefined
): boolean {
  if (!configured || !provided) {
    return false
  }
  const a = createHash("sha256").update(configured).digest()
  const b = createHash("sha256").update(provided).digest()
  return timingSafeEqual(a, b)
}
