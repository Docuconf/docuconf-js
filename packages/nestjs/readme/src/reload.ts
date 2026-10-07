// src/reload.ts
import type { Server } from "node:https";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { docuconfValidate } from "@docuconf/nestjs";
import { FileInputs, type Settings } from "./files";

export const validate = docuconfValidate(FileInputs, { name: "orders" });

export function watch(config: ConfigService<FileInputs, true>, httpsServer: Server, logger: Logger): void {
  validate.onFileChange("settings", (settings) => logger.log(`now selling in ${(settings as Settings).currency}`));
  config.get("tls", { infer: true })?.attach(httpsServer); // serve renewed certificates without a restart
}
