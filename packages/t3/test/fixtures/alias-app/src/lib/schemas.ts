import { z } from "zod";

export const logLevel = z.enum(["debug", "info"]).default("info").describe("Minimum log level");
