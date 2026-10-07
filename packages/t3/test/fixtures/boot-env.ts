// Used by devx.test.ts in a child process: createEnv with exitOnError.
import { z } from "zod";
import { createEnv, secret, url } from "../../src/index.ts";

export const env = createEnv({
  name: "boot",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
    ...(process.env["BOOT_BAD"] === "1" ? { BAD: z.string().describe("x") } : {}),
  },
  runtimeEnv: process.env,
  exitOnError: process.env["BOOT_EXIT"] === "1",
});
