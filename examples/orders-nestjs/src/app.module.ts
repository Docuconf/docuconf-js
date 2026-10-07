import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller.js";
import { validate } from "./orders.config.js";

@Module({
  // validate checks the whole environment once, at boot, and throws a
  // DocuconfValidationError listing every violation.
  imports: [ConfigModule.forRoot({ isGlobal: true, validate })],
  controllers: [AppController],
})
export class AppModule {}
