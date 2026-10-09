import { createServer } from "node:http";
// Importing env validates the environment: on any problem, createEnv throws
// a DocuconfValidationError listing every violation, before we listen.
import { env } from "./env.js";
import { verify } from "./webhook.js";

const MAX_BODY = 1 << 20;

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.end("ok");
  } else if (req.method === "GET" && req.url === "/config") {
    res.setHeader("content-type", "application/json");
    const { PORT, LOG_LEVEL, ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT } = env;
    // REQUEST_TIMEOUT is in milliseconds. Secrets are never echoed, set or not.
    res.end(JSON.stringify({ PORT, LOG_LEVEL, DATABASE_URL: "***", ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT, WEBHOOK_KEYS: "***" }));
  } else if (req.method === "POST" && req.url === "/webhooks/payments") {
    // Payment webhooks, signed with any key in WEBHOOK_KEYS (see env.ts for
    // how to rotate it).
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end("body too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const signature = req.headers["x-signature"];
      if (!verify(env.WEBHOOK_KEYS, Buffer.concat(chunks), typeof signature === "string" ? signature : undefined)) {
        res.writeHead(401).end("bad signature");
        return;
      }
      res.writeHead(204).end();
    });
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(env.PORT, () => console.log(`orders listening on :${env.PORT} (log level ${env.LOG_LEVEL})`));
