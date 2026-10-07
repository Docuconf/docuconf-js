// Imports through a tsconfig "paths" alias, extensionless, as Next.js apps do.
import { createEnv, tlsFile } from "../../../../src/index.ts";
import { logLevel } from "@/lib/schemas";

export const env = createEnv({
  name: "alias-app",
  server: { LOG_LEVEL: logLevel },
  files: { tls: tlsFile({ path: "/etc/alias/tls", description: "Serving certificate" }) },
  runtimeEnv: process.env,
});
