import { defineProject } from "vitest/config";
import { sourceAliases } from "../../vitest.shared.ts";

export default defineProject({
  resolve: { alias: sourceAliases },
  test: {
    name: "orders-t3",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // src/env.ts validates process.env on import; the tests check maps with checkEnv.
    env: { DATABASE_URL: "postgres://orders:pw@db:5432/orders" },
  },
});
