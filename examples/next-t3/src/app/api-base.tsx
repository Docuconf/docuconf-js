"use client";
// A client component importing the same env.ts as the server.
import { env } from "@/env";

export function ApiBase() {
  return <p id="api-base">{env.NEXT_PUBLIC_API_BASE}</p>;
}
