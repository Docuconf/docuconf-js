// The service's configuration contract. In your app, import from "@docuconf/t3".
import { z } from "zod";
import { configFile, createEnv, duration, list, secret, tlsFile, url } from "../../packages/t3/src/index.ts";

export const env = createEnv({
  name: "orders-api",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres", "postgresql"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8443).describe("Port the API listens on"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level emitted"),
    REQUEST_TIMEOUT: duration({ default: "30s", max: "5m" }).describe("Timeout for upstream requests"),
    ALLOWED_ORIGINS: list(z.string()).optional().describe("CORS origins allowed to call the API"),
    MAINTENANCE_MODE: z.stringbool().default(false).describe("Reject writes during maintenance windows"),
  },
  files: {
    settings: configFile({
      format: "json",
      path: "/etc/orders/config/settings.json",
      description: "Business settings: currency and order limits",
      required: true,
      reload: "watch",
      schema: z.object({
        currency: z.enum(["EUR", "USD", "GBP"]),
        maxItemsPerOrder: z.number().int().positive(),
      }),
    }),
    tls: tlsFile({
      path: "/etc/orders/tls",
      description: "Certificate the API serves HTTPS with",
      dnsNames: ["orders.internal"],
      minRemaining: "168h",
      reload: "watch",
    }),
  },
  runtimeEnv: process.env,
});
