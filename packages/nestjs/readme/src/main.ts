// src/main.ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { OrdersService } from "./orders.service";

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
console.log(app.get(OrdersService).describe());
await app.close();
