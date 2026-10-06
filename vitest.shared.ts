import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

/** Tests run against the sibling packages' TypeScript sources, not their builds. */
export const sourceAliases = [
  { find: /^@docuconf\/core\/loader$/, replacement: src("core/src/loader.ts") },
  { find: /^@docuconf\/core$/, replacement: src("core/src/index.ts") },
];
