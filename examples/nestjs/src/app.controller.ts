import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "./config/env.validation.js";

@Controller()
export class AppController {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  @Get()
  status() {
    // Typed: settings is a Settings instance, re-read when the mounted file changes.
    const settings = this.config.get("settings", { infer: true });
    return {
      currency: settings.currency,
      maxItemsPerOrder: settings.maxItemsPerOrder,
      maintenance: this.config.get("MAINTENANCE_MODE", { infer: true }),
      timeoutMs: this.config.get("REQUEST_TIMEOUT", { infer: true }),
    };
  }
}
