// src/server.ts
import { createServer } from "node:http";
import { env } from "./env.ts";

createServer((req, res) => res.end(`orders: ${env.WORKER_COUNT} workers, timeout ${env.REQUEST_TIMEOUT} ms\n`)).listen(env.PORT);
