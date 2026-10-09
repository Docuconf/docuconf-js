// One env.ts for the server and the browser. On the server, @docuconf/t3
// validates every variable at start (see instrumentation.ts); in the
// browser, bundlers pick its browser build, which is T3 Env alone.
import { z } from "zod";
import { createEnv, duration, keySet, list, secret, url } from "@docuconf/t3";
import { logLevel } from "@/schemas";

export const env = createEnv({
  name: "orders-web",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres"], maxLength: 2048 })).describe("Postgres connection string for the orders database"),
    LOG_LEVEL: logLevel,
    ALLOWED_ORIGINS: list(z.string(), { minItems: 1 }).default(["http://localhost:3000"]).describe("CORS origins allowed to call the API"),
    REQUEST_TIMEOUT: duration({ min: "1s", max: "5m", default: "30s" }).describe("Timeout for a single request"),
    WORKER_COUNT: z.coerce.number().int().min(1).max(64).default(4).describe("Number of background order workers"),
    /**
     * Keys that verify the signature on incoming payment webhooks.
     *
     * A webhook is accepted when it is signed with any key in the set, so the key can be rotated without turning webhooks away. Each key is 32 to 256 characters, so an empty or truncated key fails at boot. Without this variable, the service rejects every webhook.
     */
    WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).optional().describe("Keys that verify the signature on incoming payment webhooks"),
  },
  // Inlined into the browser bundle by `next build`: not runtime configuration.
  clientPrefix: "NEXT_PUBLIC_",
  client: {
    NEXT_PUBLIC_API_BASE: z.url().describe("Public base URL of the API"),
  },
  // Next.js only inlines process.env.NEXT_PUBLIC_* written out in full.
  runtimeEnv: { ...process.env, NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE },
});
