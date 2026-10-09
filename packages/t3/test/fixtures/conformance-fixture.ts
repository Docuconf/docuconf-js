// The shared export fixture (docuconf-go conformance/export/fixture.yaml),
// declared with @docuconf/t3. Its export must match
// conformance/export/golden.cue as data (conformance-export.test.ts).
import { z } from "zod";
import {
  annotate,
  binaryFile,
  caBundleFile,
  configFile,
  createEnv,
  duration,
  int64,
  json,
  keySet,
  keystoreFile,
  list,
  secret,
  textFile,
  tlsFile,
  url,
} from "../../src/index.ts";

/** The settings type the config files bind to. */
const settings = z.strictObject({
  name: z.string().min(1),
  replicas: int64({ min: 1 }),
  tags: z.array(z.string()).optional(),
});

export const env = createEnv({
  name: "docuconf-fixture",
  appVersion: "1.0.0",
  server: {
    /** Lower case, as a DNS label allows. */
    APP_NAME: annotate(
      z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z][a-z0-9-]*$/)
        .default("orders")
        .describe("Service name, used in logs and metrics"),
      { group: "general", examples: ["orders", "billing"], configKey: "App:Name" },
    ),
    DATABASE_URL: annotate(secret(url({ schemes: ["postgres", "postgresql"], maxLength: 2048 })).describe("Primary Postgres connection string"), {
      group: "database",
    }),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080).describe("HTTP listen port"),
    TRACE_RATIO: z.coerce.number().min(0).max(1).default(0.25).describe("Fraction of requests traced"),
    DEBUG: z.stringbool().default(false).describe("Serve the debug endpoints"),
    REQUEST_TIMEOUT: duration({ min: "1s", max: "5m", default: "1m30s" }).describe("Upstream request timeout"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level"),
    ALLOWED_ORIGINS: list(z.string(), { separator: ";", minItems: 1, maxItems: 5, itemMinLength: 1, itemMaxLength: 255 })
      .optional()
      .describe("CORS origins allowed to call the API"),
    SHARDS: list(z.coerce.number().int().min(0).max(1023)).optional().describe("Shards this instance owns"),
    WEBHOOK_KEYS: keySet({ keyMinLength: 32, keyMaxLength: 256 }).optional().describe("Keys that verify webhook signatures"),
    RATE_LIMITS: json(z.strictObject({ perMinute: int64({ min: 1 }), burst: int64({ min: 0 }).optional() }), { maxLength: 1024 })
      .default({ perMinute: 60 })
      .describe("Per-client rate limits"),
    OLD_PORT: annotate(int64().optional().describe("Port the service used to listen on"), {
      deprecated: { message: "Use PORT instead", replacedBy: "PORT" },
    }),
    PARTNER_PASSWORD: secret(z.string()).optional().describe("Password of the partner keystore"),
  },
  files: {
    settings: configFile({
      format: "json",
      schema: settings,
      description: "Application settings",
      required: true,
      path: "/etc/app/settings/settings.json",
      pathEnv: "SETTINGS_FILE",
      reload: "watch",
      maxSize: 65536,
      group: "general",
    }),
    rules: configFile({ format: "yaml", schema: settings, description: "Routing rules", path: "/etc/app/rules/rules.yaml" }),
    flags: configFile({ format: "toml", schema: settings, description: "Feature defaults", path: "/etc/app/flags/flags.toml" }),
    "serving-tls": tlsFile({
      description: "Certificate the service serves HTTPS with",
      path: "/etc/app/tls",
      reload: "watch",
      dnsNames: ["app.example.test", "api.example.test"],
      keyAlgorithms: ["ECDSA", "Ed25519"],
      minRemaining: "720h",
      requireCA: true,
    }),
    trust: caBundleFile({ description: "CAs the service trusts", path: "/etc/app/trust/bundle.pem", minCertificates: 2 }),
    partner: keystoreFile({ format: "pkcs12", description: "Client certificate for the partner API", path: "/etc/app/partner/keystore.p12", passwordVar: "PARTNER_PASSWORD" }),
    licence: textFile({ description: "Licence key", path: "/etc/app/licence/licence.key", minLength: 8, maxLength: 64, pattern: "^[A-Z0-9-]+\\n?$" }),
    geoip: binaryFile({
      description: "GeoIP database",
      path: "/data/geoip/geoip.mmdb",
      maxSize: 134217728,
      deprecated: { message: "Use geo-db instead", replacedBy: "geo-db" },
    }),
    "geo-db": binaryFile({ description: "City-level location database", path: "/data/geo-db/geo.mmdb" }),
  },
  runtimeEnv: {},
  skipValidation: true,
});
