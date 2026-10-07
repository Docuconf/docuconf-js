// Every variable type and every file type, for the export golden test.
import "reflect-metadata";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import {
  BinaryFile,
  type CaBundle,
  CaBundleFile,
  ConfigFile,
  Describe,
  Duration,
  Examples,
  Group,
  Json,
  type Keystore,
  KeystoreFile,
  List,
  Secret,
  TextFile,
  TlsFile,
  type TlsMaterial,
  UrlSchemes,
  docuconfValidate,
} from "../../src/index.ts";

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export class RateLimits {
  @IsInt() @Min(1)
  perMinute!: number;

  @IsOptional() @IsInt() @Min(0)
  burst?: number;
}

export class Route {
  @IsString() @Matches(/^\//)
  match!: string;

  @IsString() @Matches(/^https?:\/\//)
  upstream!: string;

  @IsOptional() @IsString()
  timeout?: string;
}

export class Routes {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => Route)
  routes!: Route[];
}

export class EnvironmentVariables {
  @Secret() @UrlSchemes("postgres", "postgresql") @Describe("Primary Postgres connection string")
  DATABASE_URL!: string;

  @IsInt() @Min(1) @Max(65535) @Describe("HTTP listen port")
  PORT: number = 8080;

  @IsOptional() @IsInt() @Min(1) @Describe("Soft memory limit, in bytes")
  GOMEMLIMIT?: number;

  @IsNumber() @Min(0) @Max(1) @Describe("Fraction of requests traced")
  SAMPLE_RATE: number = 0.25;

  @IsBoolean() @Describe("Verbose request logging")
  DEBUG: boolean = false;

  @Duration({ min: "1s", max: "5m", default: "30s" }) @Describe("Upstream request timeout")
  REQUEST_TIMEOUT!: number;

  @UrlSchemes("https") @MaxLength(200) @Describe("Externally visible base URL")
  PUBLIC_URL!: string;

  @IsEnum(LogLevel) @Group("logging") @Describe("Minimum log level emitted")
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @List() @IsString({ each: true }) @ArrayMinSize(1) @ArrayMaxSize(10) @Length(8, 100, { each: true })
  @Describe("CORS origins allowed to call the API")
  ALLOWED_ORIGINS!: string[];

  @IsOptional() @List({ separator: ";" }) @IsInt({ each: true }) @Min(1, { each: true }) @Max(65535, { each: true })
  @Describe("Ports the workers bind")
  WORKER_PORTS?: number[];

  @IsOptional() @Json(RateLimits, { maxLength: 256 }) @Describe("Default per-client rate limits")
  RATE_LIMITS?: RateLimits;

  @IsString() @Matches(/^[a-z]{2}-[a-z]+-[0-9]$/) @Length(4, 32) @Examples("eu-west-1") @Describe("Cloud region the service runs in")
  REGION!: string;

  @IsOptional() @Secret() @IsString() @MinLength(1) @Describe("Password for the partner keystore")
  KEYSTORE_PASSWORD?: string;

  @ConfigFile({
    format: "yaml",
    path: "/etc/gateway/routes/routes.yaml",
    pathEnv: "ROUTES_FILE",
    description: "Routing table: path prefixes and their upstreams",
    required: true,
    reload: "watch",
    maxSize: 65536,
    schema: Routes,
  })
  routes!: Routes;

  @TlsFile({
    path: "/etc/gateway/tls",
    description: "Certificate the gateway serves HTTPS with",
    required: true,
    reload: "watch",
    dnsNames: ["gateway.internal", "api.example.com"],
    keyAlgorithms: ["ECDSA", "RSA"],
    minRemaining: "720h",
    requireCA: true,
  })
  servingTls!: TlsMaterial;

  @CaBundleFile({
    path: "/etc/gateway/ca/bundle.pem",
    pathEnv: "SSL_CERT_FILE",
    description: "Private CAs the gateway trusts for upstream TLS",
  })
  upstreamCa?: CaBundle;

  @KeystoreFile({
    path: "/etc/gateway/partner/keystore.p12",
    description: "Client certificate for mTLS to the partner API",
    passwordVar: "KEYSTORE_PASSWORD",
  })
  partnerKeystore?: Keystore;

  @TextFile({
    path: "/etc/gateway/license/license.key",
    description: "Gateway licence key",
    required: true,
    pattern: "^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}\\n?$",
  })
  license!: string;

  @BinaryFile({
    path: "/data/geoip/GeoLite2-City.mmdb",
    description: "GeoIP database for country-based routing",
    maxSize: 134217728,
  })
  geoip?: Buffer;
}

export const validate = docuconfValidate(EnvironmentVariables, { name: "sample-gateway" });
