import { readFileSync } from "node:fs";
import { Agent, type Server, createServer, request } from "node:https";
import { type CaBundle, type TlsMaterial, loadContract, onFileChange, reloadStatus } from "@docuconf/core";

const env = loadContract(readFileSync("contract.json", "utf8"), { exitOnError: true });

// A TLS server: attach() calls server.setSecureContext() after every accepted reload.
const tls = env["serving-tls"] as TlsMaterial;
const server: Server = createServer({ ...tls }, (req, res) => res.end("ok"));
tls.attach(server);
server.listen(8443);

// An HTTP client: rebuild the agent in the hook; requests use whichever agent is current.
let payments = new Agent({ ...(env["payments-ca"] as CaBundle) });
onFileChange(env, "payments-ca", (bundle) => {
  payments = new Agent({ ...(bundle as CaBundle) });
});
request("https://payments.internal/charges", { method: "POST", agent: payments }).end("{}");

// A health check or a metric: never the content.
const { generation, lastReloadAt, lastRejected } = reloadStatus(env, "serving-tls");
console.log(generation, lastReloadAt?.toISOString(), lastRejected?.codes);
