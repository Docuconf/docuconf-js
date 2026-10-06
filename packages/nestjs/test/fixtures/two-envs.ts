import "reflect-metadata";
import { IsInt } from "class-validator";
import { Describe, UrlSchemes, docuconfValidate } from "../../src/index.ts";

class HttpEnv {
  @IsInt() @Describe("HTTP listen port")
  HTTP_PORT: number = 8080;
}

class WorkerEnv {
  @UrlSchemes("amqp", "amqps") @Describe("Queue the worker consumes")
  QUEUE_URL!: string;
}

export const httpValidate = docuconfValidate(HttpEnv, { name: "http" });
export const workerValidate = docuconfValidate(WorkerEnv, { name: "worker" });
