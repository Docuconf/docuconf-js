import { z } from "zod";

// Imported through the "@/*" tsconfig alias, which `docuconf-t3 export` follows.
export const logLevel = z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level emitted");
