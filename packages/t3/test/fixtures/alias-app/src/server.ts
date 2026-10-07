// Not the module to export: it uses env at import time.
import { env } from "./env.ts";

env.files.tls?.attach({} as never);
