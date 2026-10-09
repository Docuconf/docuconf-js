// Checks the signature on incoming payment webhooks against the key set in
// WEBHOOK_KEYS.
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Whether `signature`, the hex-encoded HMAC-SHA256 of `body`, was made with
 * any of `keys`. Accepting every key in the set is what lets a key be
 * rotated: during the overlap the old and the new key both work.
 */
export function verify(keys: readonly string[] | undefined, body: Buffer | string, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const got = Buffer.from(signature, "hex");
  let ok = false;
  for (const key of keys ?? []) {
    const want = createHmac("sha256", key).update(body).digest();
    // Check every key, so the time taken does not say which one matched.
    ok = timingSafeEqual(want, got) || ok;
  }
  return ok;
}
