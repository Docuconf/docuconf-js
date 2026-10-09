import { createHmac, timingSafeEqual } from "node:crypto";
import { createEnv, keySet } from "@docuconf/t3";

export const env = createEnv({
  server: {
    WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).describe("Keys that verify webhook signatures"),
  },
  runtimeEnv: process.env,
});

/** Whether `signature` is the HMAC-SHA256 of `body` under any key in the set. */
export function signedByUs(body: Buffer, signature: Buffer): boolean {
  return env.WEBHOOK_KEYS.verify((key) => {
    const want = createHmac("sha256", key).update(body).digest();
    return want.length === signature.length && timingSafeEqual(want, signature);
  });
}
