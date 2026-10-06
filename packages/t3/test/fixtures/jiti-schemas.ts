import { z } from "zod";

// An enum: not erasable syntax, so Node's type stripping cannot load this file.
export enum Marker {
  Loaded = "loaded",
}

export const marker = z.string().describe(`Proves jiti loaded the module (${Marker.Loaded})`);
