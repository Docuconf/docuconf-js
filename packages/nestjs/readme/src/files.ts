// src/files.ts
import { IsIn, IsInt, Min } from "class-validator";
import { ConfigFile, TlsFile, type TlsMaterial } from "@docuconf/nestjs";

export class Settings {
  @IsIn(["EUR", "USD"]) currency!: string;
  @IsInt() @Min(1) maxItemsPerOrder!: number;
}

export class FileInputs {
  @ConfigFile({ format: "json", path: "/etc/orders/config/settings.json", required: true, reload: "watch",
    description: "Business settings: currency and order limits", schema: Settings })
  settings!: Settings;

  @TlsFile({ path: "/etc/orders/tls", description: "Certificate the API serves HTTPS with",
    dnsNames: ["orders.internal"], minRemaining: "168h" })
  tls?: TlsMaterial;
}
