// A plain Node server reading its configuration through env.ts.
//
//   DATABASE_URL=postgres://localhost/orders \
//   DOCUCONF_FILE_ROOT=examples/basic/dev-root \
//   node examples/basic/server.ts
import { type IncomingMessage, type ServerResponse, createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { onFileChange } from "../../src/index.ts";
import { env } from "./env.ts";

function handler(_req: IncomingMessage, res: ServerResponse) {
  // env.files.settings is re-read when the mounted file changes (reload: "watch").
  const { currency, maxItemsPerOrder } = env.files.settings;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ currency, maxItemsPerOrder, maintenance: env.MAINTENANCE_MODE }));
}

// The TLS input is optional: serve HTTPS when the platform mounts a key pair.
const tls = env.files.tls;
let server;
if (tls) {
  server = createHttpsServer({ ...tls }, handler);
  tls.attach(server); // picks up renewed certificates without a restart
} else {
  server = createHttpServer(handler);
}

onFileChange(env, "settings", (s) => console.log(`settings reloaded: ${JSON.stringify(s)}`));

server.listen(env.PORT, () => {
  console.log(`orders-api listening on ${tls ? "https" : "http"}://localhost:${env.PORT} (log level ${env.LOG_LEVEL})`);
});
