import { createEnv } from "../../../../src/index.ts";
import { nothing } from "@/lib/nothing";

export const env = createEnv({ name: "alias-app", server: { X: nothing }, runtimeEnv: process.env });
