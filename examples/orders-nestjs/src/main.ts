import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import type { OrdersConfig } from "./orders.config.js";

// rawBody: the webhook signature is over the body exactly as sent.
const app = await NestFactory.create(AppModule, { rawBody: true });
const config = app.get<ConfigService<OrdersConfig, true>>(ConfigService);
const port = config.get("PORT", { infer: true });
await app.listen(port);
console.log(`orders listening on :${port} (log level ${config.get("LOG_LEVEL", { infer: true })})`);
