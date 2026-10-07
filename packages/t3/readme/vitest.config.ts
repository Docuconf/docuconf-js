// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { env: { SKIP_ENV_VALIDATION: "1" } },
});
