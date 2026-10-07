// src/config/env.validation.ts
import { ArrayMinSize, IsEnum, IsInt, IsString, Max, Min } from "class-validator";
import { Describe, Duration, List, Secret, UrlSchemes, docuconfValidate } from "@docuconf/nestjs";

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export class EnvironmentVariables {
  @IsInt() @Min(1) @Max(65535) @Describe("Port the HTTP server listens on")
  PORT: number = 8080;

  @IsEnum(LogLevel) @Describe("Minimum log level emitted")
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @Secret() @UrlSchemes("postgres") @Describe("Postgres connection string for the orders database")
  DATABASE_URL!: string;

  @List() @IsString({ each: true }) @ArrayMinSize(1) @Describe("CORS origins allowed to call the API")
  ALLOWED_ORIGINS: string[] = ["http://localhost:3000"];

  @Duration({ min: "1s", max: "5m", default: "30s" }) @Describe("Timeout for a single request")
  REQUEST_TIMEOUT!: number;

  @IsInt() @Min(1) @Max(64) @Describe("Number of background order workers")
  WORKER_COUNT: number = 4;
}

// exitOnError: on a problem, print every one and exit 1.
export const validate = docuconfValidate(EnvironmentVariables, { name: "orders", exitOnError: true });
