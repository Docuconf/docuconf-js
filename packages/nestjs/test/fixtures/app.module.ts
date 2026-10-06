// A module that declares its environment inline in ConfigModule.forRoot, as
// some apps do. Exporting it must not need a real environment.
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { IsInt, Max, Min } from "class-validator";
import { Describe, Secret, docuconfValidate } from "../../src/index.ts";

class AppEnv {
  @IsInt() @Min(1) @Max(65535) @Describe("Port the app listens on")
  APP_PORT: number = 3000;

  @Secret() @Describe("Token for the upstream API")
  API_TOKEN!: string;
}

@Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true, validate: docuconfValidate(AppEnv, { name: "app" }) })] })
export class AppModule {}
