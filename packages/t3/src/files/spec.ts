import type { StandardSchemaV1 } from "@t3-oss/env-core";
import { type ConfigFileOptions, type FileInput, makeFileInput } from "@docuconf/core/pure";

export {
  binaryFile,
  caBundleFile,
  isFileInput,
  keystoreFile,
  textFile,
  tlsFile,
  type BinaryFileOptions,
  type CaBundle,
  type CaBundleFileOptions,
  type FileCommonOptions,
  type FileInput,
  type FileInputs,
  type FileType,
  type FileValues,
  type KeyAlgorithm,
  type Keystore,
  type KeystoreFileOptions,
  type TextFileOptions,
  type TlsFileOptions,
  type TlsMaterial,
} from "@docuconf/core/pure";
export type { ConfigFileOptions };

/** A structured config file (`json` or `yaml`) validated against `schema` at boot. */
export function configFile<S extends StandardSchemaV1, const R extends boolean = false>(
  options: ConfigFileOptions<S, R>,
): FileInput<StandardSchemaV1.InferOutput<S>, R> {
  return makeFileInput("config", options);
}
