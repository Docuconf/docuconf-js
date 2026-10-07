// A package.json without "type", as every Next.js app has.
import { z } from "zod";
import { createEnv } from "../../../src/index.ts";

export const env = createEnv({
  name: "typeless",
  server: { PORT: z.coerce.number().int().default(3000).describe("HTTP listen port") },
  runtimeEnv: process.env,
});
