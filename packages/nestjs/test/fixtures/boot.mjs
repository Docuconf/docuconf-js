// Used by devx.test.ts in a child process: the decorators applied by hand,
// so Node runs it without a TypeScript build.
import "reflect-metadata";
import { IsInt, Max, Min } from "class-validator";
import { Describe, Secret, UrlSchemes, docuconfValidate } from "../../src/index.ts";

class Env {
  constructor() {
    this.PORT = 3000;
  }
}
for (const d of [IsInt(), Min(1), Max(65535), Describe("Port the API listens on")]) d(Env.prototype, "PORT");
for (const d of [Secret(), UrlSchemes("postgres"), Describe("Primary Postgres connection string")]) d(Env.prototype, "DATABASE_URL");

export const validate = docuconfValidate(Env, { name: "boot", exitOnError: process.env.BOOT_EXIT === "1" });
validate(process.env);
console.log("booted");
