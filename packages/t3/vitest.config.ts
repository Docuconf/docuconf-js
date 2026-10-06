import { defineProject } from "vitest/config";
import { sourceAliases } from "../../vitest.shared.ts";

export default defineProject({
  resolve: { alias: sourceAliases },
  test: { name: "t3", include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
