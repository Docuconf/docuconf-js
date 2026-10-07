import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import type { OrdersConfig } from "./orders.config.js";

const app = await NestFactory.create(AppModule);
const config = app.get<ConfigService<OrdersConfig, true>>(ConfigService);
const port = config.get("PORT", { infer: true });
await app.listen(port);
console.log(`orders listening on :${port} (log level ${config.get("LOG_LEVEL", { infer: true })})`);
