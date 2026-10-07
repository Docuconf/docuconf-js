// src/contract.ts
import { toContract } from "@docuconf/nestjs";
import { EnvironmentVariables, validate } from "./config/env.validation";

toContract(validate, { appVersion: process.env.GIT_SHA }); // the CUE text
toContract(EnvironmentVariables, { name: "orders" }); // from the class
