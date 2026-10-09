import { Controller, Get, Headers, HttpCode, Post, type RawBodyRequest, Req, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { OrdersConfig } from "./orders.config.js";
import { verify } from "./webhook.js";

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
      DATABASE_URL: "***", // secrets are never echoed, set or not
      ALLOWED_ORIGINS: get("ALLOWED_ORIGINS"),
      REQUEST_TIMEOUT: get("REQUEST_TIMEOUT"), // milliseconds
      WORKER_COUNT: get("WORKER_COUNT"),
      WEBHOOK_KEYS: "***",
    };
  }

  // Payment webhooks, signed with any key in WEBHOOK_KEYS (see
  // orders.config.ts for how to rotate it). main.ts keeps the raw body.
  @Post("webhooks/payments")
  @HttpCode(204)
  payment(@Req() req: RawBodyRequest<object>, @Headers("x-signature") signature?: string): void {
    if (!verify(this.config.get("WEBHOOK_KEYS", { infer: true }), req.rawBody ?? Buffer.alloc(0), signature)) {
      throw new UnauthorizedException("bad signature");
    }
  }
}
