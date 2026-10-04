// Imports without extensions and uses an enum: needs the jiti fallback.
import { createEnv } from "../../src/index";
import { marker } from "./jiti-schemas";

export const env = createEnv({
  name: "jiti-sample",
  server: { JITI_LOADED: marker.optional() },
  runtimeEnv: process.env,
});
