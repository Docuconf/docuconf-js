// The service's configuration: a T3 Env declaration with docuconf's helpers
// for what Zod has no word for (secrets, URL schemes, durations, lists,
// and a key set).
import { z } from "zod";
import { createEnv, duration, keySet, list, secret, url } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("Port the HTTP server listens on"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level emitted"),
    DATABASE_URL: secret(url({ schemes: ["postgres"], maxLength: 2048 })).describe("Postgres connection string for the orders database"),
    ALLOWED_ORIGINS: list(z.string(), { minItems: 1 })
      .default(["http://localhost:3000"])
      .describe("Comma-separated CORS origins allowed to call the API"),
    REQUEST_TIMEOUT: duration({ min: "1s", max: "5m", default: "30s" }).describe("Timeout for a single request"),
    /**
     * Number of background order workers.
     *
     * Each worker holds one database connection, so keep this below the
     * pool size of {@link DATABASE_URL}'s server.
     *
     * - Raise it when the order queue backs up.
     * - Lower it when the database is the bottleneck.
     */
    WORKER_COUNT: z.coerce.number().int().min(1).max(64).default(4).describe("Number of background order workers"),
    /**
     * Keys that verify the signature on incoming payment webhooks.
     *
     * A webhook is accepted when it is signed with any key in the set, so the key can be rotated without turning webhooks away. Each key is 32 to 256 characters, so an empty or truncated key fails at boot. Without this variable, the service rejects every webhook.
     */
    WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).optional().describe("Keys that verify the signature on incoming payment webhooks"),
  },
  runtimeEnv: process.env,
  // On invalid configuration: print every problem and exit 1.
  exitOnError: true,
});
