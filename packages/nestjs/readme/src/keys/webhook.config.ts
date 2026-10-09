import { createHmac, timingSafeEqual } from "node:crypto";
import { Describe, KeySet } from "@docuconf/nestjs";

export class WebhookConfig {
  @KeySet({ keyMinLength: 32, keyMaxLength: 256 })
  @Describe("Keys that verify webhook signatures")
  WEBHOOK_KEYS!: KeySet;
}

/** Whether `signature` is the HMAC-SHA256 of `body` under any key in the set. */
export function signedByUs(keys: KeySet, body: Buffer, signature: Buffer): boolean {
  return keys.verify((key) => {
    const want = createHmac("sha256", key).update(body).digest();
    return want.length === signature.length && timingSafeEqual(want, signature);
  });
}
