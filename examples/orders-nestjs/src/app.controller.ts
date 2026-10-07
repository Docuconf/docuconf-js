import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { OrdersConfig } from "./orders.config.js";

@Controller()
export class AppController {
  constructor(private readonly config: ConfigService<OrdersConfig, true>) {}

  @Get("healthz")
  healthz(): string {
    return "ok";
  }

  @Get("config")
  showConfig() {
    const get = <K extends keyof OrdersConfig>(key: K) => this.config.get(key, { infer: true });
    return {
      PORT: get("PORT"),
      LOG_LEVEL: get("LOG_LEVEL"),
      DATABASE_URL: "***", // the secret is never echoed
      ALLOWED_ORIGINS: get("ALLOWED_ORIGINS"),
      REQUEST_TIMEOUT: get("REQUEST_TIMEOUT"), // milliseconds
      WORKER_COUNT: get("WORKER_COUNT"),
    };
  }
}
