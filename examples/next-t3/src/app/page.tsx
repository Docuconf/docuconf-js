import { connection } from "next/server";
import { env } from "@/env";
import { ApiBase } from "./api-base";

// Reads env at request time: without this, `next build` would prerender
// the page and freeze the values it saw then.
export default async function Page() {
  await connection();
  const { LOG_LEVEL, ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT } = env;
  return (
    <main>
      <pre id="config">{JSON.stringify({ LOG_LEVEL, DATABASE_URL: "***", ALLOWED_ORIGINS, REQUEST_TIMEOUT, WORKER_COUNT, WEBHOOK_KEYS: "***" })}</pre>
      <ApiBase />
    </main>
  );
}
