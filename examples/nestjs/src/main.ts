import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import type { EnvironmentVariables } from "./config/env.validation.js";

const app = await NestFactory.create(AppModule);
const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);
await app.listen(config.get("PORT", { infer: true }));
console.log(`orders-api listening on port ${config.get("PORT", { infer: true })} (${config.get("NODE_ENV", { infer: true })})`);
