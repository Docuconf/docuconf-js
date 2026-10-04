// Every variable type and every file type, for the export golden test.
import { z } from "zod";
import {
  annotate,
  binaryFile,
  caBundleFile,
  configFile,
  createEnv,
  duration,
  json,
  keystoreFile,
  list,
  secret,
  textFile,
  tlsFile,
  url,
} from "../../src/index.ts";

export const routesSchema = z.object({
  routes: z
    .array(
      z.object({
        match: z.string().regex(/^\//),
        upstream: z.string().regex(/^https?:\/\//),
        timeout: z.string().optional(),
      }),
    )
    .min(1),
});

export const env = createEnv({
  name: "sample-gateway",
  server: {
    DATABASE_URL: secret(url({ schemes: ["postgres", "postgresql"] })).describe("Primary Postgres connection string"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
    GOMEMLIMIT: z.coerce.number().int().min(1).optional().describe("Soft memory limit, in bytes"),
    SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.25).describe("Fraction of requests traced"),
    DEBUG: z.stringbool().default(false).describe("Verbose request logging"),
    REQUEST_TIMEOUT: duration({ min: "1s", max: "5m", default: "30s" }).describe("Upstream request timeout"),
    PUBLIC_URL: url({ schemes: ["https"] }).describe("Externally visible base URL"),
    LOG_LEVEL: annotate(z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level emitted"), {
      group: "logging",
    }),
    ALLOWED_ORIGINS: list(z.string(), { minItems: 1, maxItems: 10 }).describe("CORS origins allowed to call the API"),
    WORKER_PORTS: list(z.coerce.number().int(), { separator: ";" }).optional().describe("Ports the workers bind"),
    RATE_LIMITS: json(z.object({ perMinute: z.number().int().min(1), burst: z.number().int().min(0).optional() }))
      .optional()
      .describe("Default per-client rate limits"),
    REGION: z
      .string()
      .regex(/^[a-z]{2}-[a-z]+-[0-9]$/)
      .min(4)
      .max(32)
      .meta({ examples: ["eu-west-1"] })
      .describe("Cloud region the service runs in"),
    KEYSTORE_PASSWORD: secret(z.string().min(1)).optional().describe("Password for the partner keystore"),
  },
  files: {
    routes: configFile({
      format: "yaml",
      path: "/etc/gateway/routes/routes.yaml",
      pathEnv: "ROUTES_FILE",
      description: "Routing table: path prefixes and their upstreams",
      required: true,
      reload: "watch",
      maxSize: 65536,
      schema: routesSchema,
    }),
    "serving-tls": tlsFile({
      path: "/etc/gateway/tls",
      description: "Certificate the gateway serves HTTPS with",
      required: true,
      reload: "watch",
      dnsNames: ["gateway.internal", "api.example.com"],
      keyAlgorithms: ["ECDSA", "RSA"],
      minRemaining: "720h",
      requireCA: true,
    }),
    "upstream-ca": caBundleFile({
      path: "/etc/gateway/ca/bundle.pem",
      pathEnv: "SSL_CERT_FILE",
      description: "Private CAs the gateway trusts for upstream TLS",
    }),
    "partner-keystore": keystoreFile({
      path: "/etc/gateway/partner/keystore.p12",
      description: "Client certificate for mTLS to the partner API",
      passwordVar: "KEYSTORE_PASSWORD",
    }),
    license: textFile({
      path: "/etc/gateway/license/license.key",
      description: "Gateway licence key",
      required: true,
      pattern: "^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}\\n?$",
    }),
    geoip: binaryFile({
      path: "/data/geoip/GeoLite2-City.mmdb",
      description: "GeoIP database for country-based routing",
      maxSize: 134217728,
    }),
  },
  runtimeEnv: process.env,
});
