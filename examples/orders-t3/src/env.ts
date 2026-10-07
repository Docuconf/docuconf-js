// The service's configuration: a T3 Env declaration with docuconf's helpers
// for what Zod has no word for (secrets, URL schemes, durations, lists).
import { z } from "zod";
import { createEnv, duration, list, secret, url } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("Port the HTTP server listens on"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level emitted"),
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Postgres connection string for the orders database"),
    ALLOWED_ORIGINS: list(z.string(), { minItems: 1 })
      .default(["http://localhost:3000"])
      .describe("Comma-separated CORS origins allowed to call the API"),
    REQUEST_TIMEOUT: duration({ min: "1s", max: "5m", default: "30s" }).describe("Timeout for a single request"),
    WORKER_COUNT: z.coerce.number().int().min(1).max(64).default(4).describe("Number of background order workers"),
  },
  runtimeEnv: process.env,
  // T3's hook for invalid env: print every violation and exit, instead of
  // throwing a DocuconfValidationError with a stack trace.
  onValidationError: (issues) => {
    console.error(`orders: invalid configuration:\n${issues.map((i) => `  - ${i.message}`).join("\n")}`);
    process.exit(1);
  },
});
