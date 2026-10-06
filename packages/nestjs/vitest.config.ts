import { defineProject } from "vitest/config";
import { sourceAliases } from "../../vitest.shared.ts";

export default defineProject({
  resolve: { alias: sourceAliases },
  test: { name: "nestjs", include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
