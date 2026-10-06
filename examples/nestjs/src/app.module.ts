import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller.js";
import { validate } from "./config/env.validation.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate })],
  controllers: [AppController],
})
export class AppModule {}
