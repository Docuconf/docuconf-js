// vitest.config.e2e.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    // What ConfigModule.forRoot({ validate }) needs to boot the app under test.
    env: { DATABASE_URL: "postgres://orders:test@localhost:5432/orders_test" },
  },
});
