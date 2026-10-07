// src/orders.service.ts
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "./config/env.validation";

@Injectable()
export class OrdersService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  describe(): string {
    const workers = this.config.get("WORKER_COUNT", { infer: true }); // number
    const timeout = this.config.get("REQUEST_TIMEOUT", { infer: true }); // milliseconds
    return `orders: ${workers} workers, timeout ${timeout} ms`;
  }
}
