// POST /webhooks/payments: payment webhooks, signed with any key in
// WEBHOOK_KEYS (see env.ts for how to rotate it). A route handler runs at
// request time, so it sees the keys the server started with.
import { env } from "@/env";
import { verify } from "@/webhook";

export async function POST(request: Request): Promise<Response> {
  const body = Buffer.from(await request.arrayBuffer());
  if (!verify(env.WEBHOOK_KEYS, body, request.headers.get("x-signature") ?? undefined)) {
    return new Response("bad signature", { status: 401 });
  }
  return new Response(null, { status: 204 });
}
