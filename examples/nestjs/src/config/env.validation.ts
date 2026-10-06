// The service's configuration contract: the class the NestJS docs validate
// the environment with, plus docuconf's decorators.
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
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

export enum Environment {
  Development = "development",
  Production = "production",
}

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
  @IsEnum(Environment) @Describe("Environment the app runs in")
  NODE_ENV: Environment = Environment.Production;

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

export const validate = docuconfValidate(EnvironmentVariables, { name: "orders-api" });
