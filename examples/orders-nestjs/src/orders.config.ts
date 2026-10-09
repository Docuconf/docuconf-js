// The service's configuration: the class-validator class @nestjs/config
// validates the environment with, plus docuconf's decorators for what
// class-validator has no word for (descriptions, secrets, URL schemes,
// durations, lists, and a key set).
import { ArrayMinSize, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Describe, Duration, KeySet, List, Secret, UrlSchemes, docuconfValidate } from "@docuconf/nestjs";

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export class OrdersConfig {
  @IsInt() @Min(1) @Max(65535) @Describe("Port the HTTP server listens on")
  PORT: number = 8080;

  @IsEnum(LogLevel) @Describe("Minimum log level emitted")
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @Secret() @UrlSchemes("postgres") @MaxLength(2048) @Describe("Postgres connection string for the orders database")
  DATABASE_URL!: string;

  @List() @IsString({ each: true }) @ArrayMinSize(1) @Describe("Comma-separated CORS origins allowed to call the API")
  ALLOWED_ORIGINS: string[] = ["http://localhost:3000"];

  @Duration({ min: "1s", max: "5m", default: "30s" }) @Describe("Timeout for a single request")
  REQUEST_TIMEOUT!: number;

  /**
   * Number of background order workers.
   *
   * Each worker holds one database connection, so keep this below the
   * pool size of {@link DATABASE_URL}'s server.
   *
   * - Raise it when the order queue backs up.
   * - Lower it when the database is the bottleneck.
   */
  @IsInt() @Min(1) @Max(64) @Describe("Number of background order workers")
  WORKER_COUNT: number = 4;

  /**
   * Keys that verify the signature on incoming payment webhooks.
   *
   * A webhook is accepted when it is signed with any key in the set, so the key can be rotated without turning webhooks away. Each key is 32 to 256 characters, so an empty or truncated key fails at boot. Without this variable, the service rejects every webhook.
   */
  @IsOptional() @KeySet({ keyMinLength: 32, keyMaxLength: 256 })
  @Describe("Keys that verify the signature on incoming payment webhooks")
  WEBHOOK_KEYS?: KeySet;
}

// exitOnError: on invalid configuration, print every problem and exit 1.
export const validate = docuconfValidate(OrdersConfig, { name: "orders", exitOnError: true });
