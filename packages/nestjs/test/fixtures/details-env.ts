// Descriptions and details, for the details tests (SPEC §14.7).
import "reflect-metadata";
import { IsInt, IsString, Max, Min } from "class-validator";
import { Describe, Details, TextFile, docuconfValidate } from "../../src/index.ts";

export class BaseEnv {
  /**
   * Cloud region.
   *
   * Inherited from the base class.
   */
  @IsString() @Describe("Cloud region")
  REGION: string = "eu";
}

export class DetailsEnv extends BaseEnv {
  /**
   * Port the HTTP server listens on.
   *
   * Behind the mesh, keep the default. See {@link HOST}.
   *
   * - `8080` in every environment
   * - `0` is rejected
   *
   * ```sh
   * PORT=9090 npm start
   * ```
   *
   * @see https://example.com
   */
  @IsInt() @Min(1) @Max(65535) @Describe("Port the HTTP server listens on")
  PORT: number = 8080;

  /** Only a summary, the same as the description. */
  @IsString() @Describe("Only a summary, the same as the description")
  HOST: string = "0.0.0.0";

  /** The comment loses to @Details. */
  @IsString() @Describe("Operating mode") @Details("Mode `a` is the default.")
  MODE: string = "a";

  /**
   * Settings file.
   *
   * Mounted from a ConfigMap.
   */
  @TextFile({ path: "/etc/details/settings", description: "Settings file" })
  settings?: string;
}

export const validate = docuconfValidate(DetailsEnv, { name: "details" });
