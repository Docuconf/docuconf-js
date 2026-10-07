import { createServer } from "node:http";
// Importing env validates the environment: on any problem, createEnv throws
// a DocuconfValidationError listing every violation, before we listen.
import { env } from "./env.js";

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.end("ok");
  } else if (req.method === "GET" && req.url === "/config") {
    res.setHeader("content-type", "application/json");
    const { PORT, LOG_LEVEL, ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT } = env;
    // REQUEST_TIMEOUT is in milliseconds. The secret is never echoed.
    res.end(JSON.stringify({ PORT, LOG_LEVEL, DATABASE_URL: "***", ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT }));
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(env.PORT, () => console.log(`orders listening on :${env.PORT} (log level ${env.LOG_LEVEL})`));
