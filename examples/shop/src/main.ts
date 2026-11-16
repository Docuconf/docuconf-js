// The shop app: loads its configuration at startup, prints one line and
// exits 0. With exitOnError, any problem prints every violation (never a
// secret) and exits 1 before the line.
import { loadShop, summary } from "./config.js";

const config = loadShop({ exitOnError: true });
console.log(summary(config));
