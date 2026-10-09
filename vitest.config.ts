import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { projects: ["packages/*", "examples/orders-t3", "examples/orders-nestjs"] },
});
