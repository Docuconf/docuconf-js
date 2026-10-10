// src/watched.ts
import { Agent, type Server, request } from "node:https";
import { Controller, Get, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CaBundleFile, TlsFile, docuconfValidate, type CaBundle, type TlsMaterial } from "@docuconf/nestjs";

export class WatchedFiles {
  @TlsFile({ path: "/etc/orders/tls", required: true, reload: "watch", description: "Certificate the API serves HTTPS with" })
  tls!: TlsMaterial;

  @CaBundleFile({ path: "/etc/orders/payments-ca/ca.crt", required: true, reload: "watch",
    description: "CAs that sign the payments API's certificate" })
  paymentsCa!: CaBundle;
}

export const validate = docuconfValidate(WatchedFiles, { name: "orders" });

// A TLS server: attach() calls server.setSecureContext() after every accepted reload.
export function serveRenewedCertificates(config: ConfigService<WatchedFiles, true>, httpsServer: Server): void {
  config.get("tls", { infer: true }).attach(httpsServer);
}

// An HTTP client: rebuild the agent in the hook; requests use whichever agent is current.
@Injectable()
export class PaymentsClient implements OnModuleDestroy {
  private agent: Agent;
  private readonly unsubscribe: () => void;

  constructor(config: ConfigService<WatchedFiles, true>) {
    this.agent = new Agent({ ...config.get("paymentsCa", { infer: true }) });
    this.unsubscribe = validate.onFileChange("paymentsCa", (bundle) => {
      this.agent = new Agent({ ...(bundle as CaBundle) });
    });
  }

  charge(body: string): void {
    request("https://payments.internal/charges", { method: "POST", agent: this.agent }).end(body);
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }
}

// A health check or a metric: never the content.
@Controller("healthz")
export class ReloadHealthController {
  @Get("tls")
  tls() {
    const { generation, lastReloadAt, lastRejected } = validate.reloadStatus("tls");
    return { generation, lastReloadAt: lastReloadAt?.toISOString(), rejected: lastRejected?.codes };
  }
}
