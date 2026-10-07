// The README's "Descriptions and details" example.
import { z } from "zod";
import { annotate, createEnv } from "@docuconf/t3";

export const env = createEnv({
  name: "orders",
  server: {
    /**
     * Number of background order workers.
     *
     * Each worker holds one database connection, so keep this below the
     * pool size of {@link DATABASE_URL}'s server.
     *
     * - Raise it when the order queue backs up.
     * - Lower it when the database is the bottleneck.
     */
    WORKER_COUNT: z.coerce.number().int().min(1).max(64).default(4).describe("Number of background order workers"),
    // Without a comment: .meta({ details }), or annotate() for other validators.
    REGION: z.string().default("eu-west-1").describe("Cloud region").meta({ details: "Set by the platform; do not change it." }),
    ZONE: annotate(z.string().default("a").describe("Availability zone"), { details: "One of the region's zones." }),
  },
  runtimeEnv: process.env,
});
