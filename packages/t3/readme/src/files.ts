// src/files.ts
import { createServer } from "node:https";
import { z } from "zod";
import { configFile, createEnv, tlsFile } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {},
  files: {
    settings: configFile({
      format: "json",
      path: "/etc/orders/config/settings.json",
      required: true,
      description: "Currency and order limits",
      schema: z.object({ currency: z.enum(["EUR", "USD"]), maxItemsPerOrder: z.number().int().min(1) }),
    }),
    tls: tlsFile({
      path: "/etc/orders/tls",
      required: true,
      reload: "watch",
      description: "Certificate the API serves HTTPS with",
      dnsNames: ["orders.internal"],
      minRemaining: "168h",
    }),
  },
  runtimeEnv: process.env,
  exitOnError: true,
});

const server = createServer({ ...env.files.tls }, (req, res) => res.end(env.files.settings.currency));
env.files.tls.attach(server); // serve renewed certificates without a restart
server.listen(8443);
