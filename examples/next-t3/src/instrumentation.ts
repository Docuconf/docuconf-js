// src/instrumentation.ts
// Next.js calls register() once when the server starts: validate the
// environment then, and exit 1 with every problem if it is wrong.
import { registerEnv } from "@docuconf/t3/next";

export const register = registerEnv(() => import("./env"));
