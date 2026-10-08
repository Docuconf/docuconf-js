// The README's "Descriptions and details" example.
import { IsInt, IsString, Max, Min } from "class-validator";
import { Describe, Details, docuconfValidate } from "@docuconf/nestjs";

export class OrdersConfig {
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

  // Without a comment, or from compiled JavaScript: @Details.
  @IsString() @Describe("Cloud region") @Details("Set by the platform; do not change it.")
  REGION: string = "eu-west-1";
}

export const validate = docuconfValidate(OrdersConfig, { name: "orders" });
