// The service's configuration contract: the class the NestJS docs validate
// the environment with, plus docuconf's decorators.
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import {
  ConfigFile,
  Describe,
  Duration,
  List,
  Secret,
  TlsFile,
  type TlsMaterial,
  UrlSchemes,
  docuconfValidate,
} from "@docuconf/nestjs";

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export enum Currency {
  EUR = "EUR",
  USD = "USD",
  GBP = "GBP",
}

/** The settings file the platform mounts from a ConfigMap. */
export class Settings {
  @IsEnum(Currency)
  currency!: Currency;

  @IsInt() @Min(1)
  maxItemsPerOrder!: number;
}

export class EnvironmentVariables {
  @IsInt() @Min(1) @Max(65535) @Describe("Port the API listens on")
  PORT: number = 3000;

  @Secret() @UrlSchemes("postgres", "postgresql") @Describe("Primary Postgres connection string")
  DATABASE_URL!: string;

  @IsEnum(LogLevel) @Describe("Minimum log level emitted")
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @Duration({ default: "30s", max: "5m" }) @Describe("Timeout for upstream requests")
  REQUEST_TIMEOUT!: number;

  @IsOptional() @List() @IsString({ each: true }) @Describe("CORS origins allowed to call the API")
  ALLOWED_ORIGINS?: string[];

  @IsBoolean() @Describe("Reject writes during maintenance windows")
  MAINTENANCE_MODE: boolean = false;

  /**
   * Keys that verify the signature on incoming payment webhooks.
   *
   * A webhook is accepted when it is signed with any key in the list, so the key can be rotated without turning webhooks away. To rotate:
   *
   *  1. add the new key as the second item, and roll out;
   *  2. switch the sender to the new key;
   *  3. remove the old key, and roll out.
   *
   * Each key is 32 to 256 characters, so an empty or truncated key fails at boot. Without this variable, the service rejects every webhook.
   */
  @IsOptional() @Secret() @List() @IsString({ each: true }) @ArrayMinSize(1) @ArrayMaxSize(2)
  @MinLength(32, { each: true }) @MaxLength(256, { each: true })
  @Describe("Keys that verify the signature on incoming payment webhooks")
  WEBHOOK_KEYS?: string[];

  @ConfigFile({
    format: "json",
    path: "/etc/orders/config/settings.json",
    description: "Business settings: currency and order limits",
    required: true,
    reload: "watch",
    schema: Settings,
  })
  settings!: Settings;

  @TlsFile({
    path: "/etc/orders/tls",
    description: "Certificate the API serves HTTPS with",
    dnsNames: ["orders.internal"],
    minRemaining: "168h",
    reload: "watch",
  })
  tls?: TlsMaterial;
}

export const validate = docuconfValidate(EnvironmentVariables, { name: "orders-api", exitOnError: true });
