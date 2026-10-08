// Descriptions and details, for the details tests (SPEC §14.7).
import { z } from "zod";
import { annotate, createEnv, textFile } from "../../src/index.ts";

export const env = createEnv({
  name: "details",
  server: {
    /**
     * Port the HTTP server listens on.
     *
     * Behind the mesh, keep the default. See {@link HOST}.
     *
     * - `8080` in every environment
     * - `0` is rejected
     *
     * ```sh
     * PORT=9090 npm start
     * ```
     *
     * @default 8080
     */
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("Port the HTTP server listens on"),
    /** Only a summary, the same as the description. */
    HOST: z.string().default("0.0.0.0").describe("Only a summary, the same as the description"),
    /** The comment loses to .meta({ details }). */
    REGION: z.string().default("eu").describe("Cloud region").meta({ details: "Set by the **platform**." }),
    MODE: annotate(z.enum(["a", "b"]).default("a").describe("Operating mode"), { details: "Mode `a` is the default." }),
  },
  files: {
    /**
     * Settings file.
     *
     * Mounted from a ConfigMap.
     */
    settings: textFile({ path: "/etc/details/settings", description: "Settings file" }),
  },
  runtimeEnv: {},
});
