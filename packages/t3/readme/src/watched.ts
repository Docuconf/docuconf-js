// src/watched.ts
import { Agent, createServer, request } from "node:https";
import { caBundleFile, createEnv, onFileChange, reloadStatus, tlsFile } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {},
  files: {
    tls: tlsFile({ path: "/etc/orders/tls", required: true, reload: "watch", description: "Certificate the API serves HTTPS with" }),
    "payments-ca": caBundleFile({
      path: "/etc/orders/payments-ca/ca.crt",
      required: true,
      reload: "watch",
      description: "CAs that sign the payments API's certificate",
    }),
  },
  runtimeEnv: process.env,
});

// A TLS server: attach() calls server.setSecureContext() after every accepted reload.
const server = createServer({ ...env.files.tls }, (req, res) => res.end("ok"));
env.files.tls.attach(server);
server.listen(8443);

// An HTTP client: rebuild the agent in the hook; requests use whichever agent is current.
let payments = new Agent({ ...env.files["payments-ca"] });
onFileChange(env, "payments-ca", (bundle) => {
  payments = new Agent({ ...bundle });
});

export function charge(body: string): void {
  request("https://payments.internal/charges", { method: "POST", agent: payments }).end(body);
}

// A health check or a metric: never the content.
export function reloadHealth() {
  const { generation, lastReloadAt, lastRejected } = reloadStatus(env, "tls");
  return { generation, lastReloadAt: lastReloadAt?.toISOString(), rejected: lastRejected?.codes };
}
