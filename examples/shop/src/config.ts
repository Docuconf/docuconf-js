import { readFileSync } from "node:fs";
import { type LoadContractOptions, loadContract } from "@docuconf/core";

/**
 * The shop's configuration, as loadContract types it. Role-specific inputs
 * are undefined outside their role unless set; the otel@1 fragment's
 * variables are loaded too, but the app does not read them.
 */
export interface ShopConfig {
  DOCUCONF_ROLE: "web" | "worker";
  DATABASE_URL: string;
  /** web: 1 to 65535, default 8080. */
  PORT: number;
  /** web: required. */
  ALLOWED_ORIGINS?: string[];
  /** worker: required, in priority order. */
  QUEUES?: string[];
  /** worker: default false. */
  WEBHOOKS_ENABLED: boolean;
  LOG_FORMAT: "text" | "json";
  /** Required when LOG_FORMAT is "json". */
  LOG_SCHEMA_URL?: string;
  /** worker: the webhook-signing-key file's text, required when WEBHOOKS_ENABLED is true. */
  "webhook-signing-key"?: string;
}

/** The contract, written by hand in contract.cue and exported to contract.json. */
export const contractPath = new URL("../contract.json", import.meta.url);

/**
 * Loads the configuration from the environment and the files under
 * DOCUCONF_FILE_ROOT, checked against contract.json. On any problem it throws
 * a DocuconfValidationError listing every one, or, with exitOnError, prints
 * them and exits 1. No message holds a secret.
 */
export function loadShop(opts: LoadContractOptions = {}): ShopConfig {
  return loadContract<ShopConfig & Record<string, unknown>>(readFileSync(contractPath, "utf8"), opts);
}

/** The one line the app prints on a good start, from the typed values. */
export function summary(config: ShopConfig): string {
  if (config.DOCUCONF_ROLE === "web") {
    return `shop web: port ${config.PORT}, origins ${(config.ALLOWED_ORIGINS ?? []).join(",")}`;
  }
  return `shop worker: queues ${(config.QUEUES ?? []).join(",")}, webhooks ${config.WEBHOOKS_ENABLED ? "on" : "off"}`;
}
