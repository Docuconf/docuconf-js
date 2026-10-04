// A plain-JavaScript env module (.mjs), for apps that do not use TypeScript.
import { z } from "zod";
import { configFile, createEnv, duration, secret, url } from "../../src/index.ts";

export const env = createEnv({
  name: "plain-js",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
    REQUEST_TIMEOUT: duration({ default: "30s" }).describe("Upstream request timeout"),
  },
  files: {
    settings: configFile({
      format: "json",
      path: "/etc/plain/config/settings.json",
      required: true,
      description: "Currency settings",
      schema: z.object({ currency: z.enum(["EUR", "USD"]) }),
    }),
  },
  runtimeEnv: process.env,
});
