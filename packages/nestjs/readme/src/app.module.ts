// src/app.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { validate } from "./config/env.validation";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate })],
  providers: [OrdersService],
})
export class AppModule {}
