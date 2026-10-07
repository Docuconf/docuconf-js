import { defineProject } from "vitest/config";
import { sourceAliases } from "../../vitest.shared.ts";

export default defineProject({
  resolve: { alias: sourceAliases },
  test: {
    name: "t3",
    include: ["test/**/*.test.ts", "readme/**/*.test.ts"],
    testTimeout: 30_000,
    // As the README's vitest.config.ts: tests check maps with checkEnv.
    env: { SKIP_ENV_VALIDATION: "1" },
  },
});
