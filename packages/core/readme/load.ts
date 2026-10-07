import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadContract } from "@docuconf/core";

// exitOnError: on a problem, print every one and exit 1.
const env = loadContract(readFileSync("contract.json", "utf8"), { exitOnError: true });
createServer((req, res) => res.end("ok")).listen(env.PORT as number);
