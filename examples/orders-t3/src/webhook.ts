// Checks the signature on incoming payment webhooks against the key set in
// WEBHOOK_KEYS.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { KeySet } from "@docuconf/t3";

/**
 * Whether `signature`, the hex-encoded HMAC-SHA256 of `body`, was made with
 * any key in `keys`. Accepting every key in the set is what lets a key be
 * rotated: during the overlap the old and the new key both work.
 */
export function verify(keys: KeySet | undefined, body: Buffer | string, signature: string | undefined): boolean {
  if (!keys || !signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const got = Buffer.from(signature, "hex");
  // KeySet.verify tries every key, so the time taken does not say which one matched.
  return keys.verify((key) => timingSafeEqual(createHmac("sha256", key).update(body).digest(), got));
}
