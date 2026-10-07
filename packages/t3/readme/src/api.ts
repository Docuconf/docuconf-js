// src/api.ts
import { getDeclaration, toContract } from "@docuconf/t3";
import { env } from "./env.ts";

toContract(env, { name: "orders", appVersion: process.env.GIT_SHA }); // the CUE text
getDeclaration(env).vars.get("PORT")!.contract; // one variable as data
