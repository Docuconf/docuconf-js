import {
  type BinaryFileOptions,
  type CaBundleFileOptions,
  type ConfigFileOptions,
  type FileInput,
  type KeystoreFileOptions,
  type TextFileOptions,
  type TlsFileOptions,
  binaryFile,
  caBundleFile,
  keystoreFile,
  makeFileInput,
  textFile,
  tlsFile,
} from "@docuconf/core";

/**
 * docuconf metadata class-validator has no decorator for. Stored per class
 * and property; subclasses inherit their parents' metadata.
 */
export interface PropertyMeta {
  description?: string;
  secret?: boolean;
  schemes?: string[];
  duration?: DurationOptions;
  list?: ListOptions;
  /** A class (or nothing) the JSON value binds to. */
  json?: { schema: JsonSchemaSource | undefined };
  examples?: string[];
  group?: string;
  deprecated?: { message: string; replacedBy?: string };
  /** A file input instead of a variable. */
  file?: { name: string | undefined; input: FileInput };
}

/** A class-validator class, or a Standard Schema validator that offers JSON Schema (Zod 4). */
export type JsonSchemaSource = (abstract new (...args: never[]) => object) | object;

const store = new WeakMap<object, Map<string, PropertyMeta>>();

function update(target: object, property: string | symbol, patch: (m: PropertyMeta) => void): void {
  if (typeof property !== "string") throw new TypeError("docuconf: decorated properties must have string names");
  const ctor = (target as { constructor: object }).constructor;
  let props = store.get(ctor);
  if (!props) store.set(ctor, (props = new Map()));
  const m = props.get(property) ?? {};
  patch(m);
  props.set(property, m);
}

/** Every property's docuconf metadata for `cls`, including inherited properties. */
export function docuconfMetadata(cls: object): Map<string, PropertyMeta> {
  const chain: object[] = [];
  for (let c: unknown = cls; typeof c === "function" && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c);
  const out = new Map<string, PropertyMeta>();
  for (const c of chain) {
    for (const [k, v] of store.get(c) ?? []) out.set(k, { ...out.get(k), ...v });
  }
  return out;
}

type Decorator = (target: object, propertyKey: string | symbol) => void;

/** The variable's (or file input's) description for the contract: at least 5 characters. */
export function Describe(description: string): Decorator {
  return (t, p) => update(t, p, (m) => void (m.description = description));
}

/**
 * Marks a variable as secret: the platform must supply it from a Secret
 * (SPEC §6), it can have no default or examples, and its value is never
 * printed in errors.
 */
export function Secret(): Decorator {
  return (t, p) => update(t, p, (m) => void (m.secret = true));
}

/**
 * A URL with a `scheme://` prefix, restricted to `schemes` (without "://"),
 * e.g. `@UrlSchemes("postgres", "postgresql")`. Contract type `url`. Unlike
 * `@IsUrl()`, it accepts hosts without a top-level domain, such as `db`.
 */
export function UrlSchemes(...schemes: [string, ...string[]]): Decorator {
  return (t, p) => update(t, p, (m) => void (m.schemes = schemes));
}

export interface DurationOptions {
  /** Smallest accepted duration, Go syntax ("1s"). */
  min?: string;
  /** Largest accepted duration, Go syntax ("5m"). */
  max?: string;
  /** Default, Go syntax ("30s"). A property initializer in milliseconds works too. */
  default?: string;
}

/**
 * A Go-syntax duration ("30s", "1m30s", "250ms"), parsed to milliseconds.
 * Contract type `duration` with encoding `go`. The property is a `number`.
 */
export function Duration(options: DurationOptions = {}): Decorator {
  return (t, p) => update(t, p, (m) => void (m.duration = options));
}

export interface ListOptions {
  /** Separator between items. Default ",". */
  separator?: string;
}

/**
 * A list in one variable, split on `separator` (contract encoding `csv`).
 * Items are strings, or integers with `@IsInt({ each: true })`. Bound the
 * length with `@ArrayMinSize()` and `@ArrayMaxSize()`.
 */
export function List(options: ListOptions = {}): Decorator {
  return (t, p) => update(t, p, (m) => void (m.list = options));
}

/**
 * A structured value in one variable, sent as compact JSON. With a
 * class-validator class, the value is bound to it and validated, and its
 * JSON Schema goes into the contract.
 */
export function Json(schema?: JsonSchemaSource): Decorator {
  return (t, p) => update(t, p, (m) => void (m.json = { schema }));
}

/** Example values for documentation. Not allowed on secrets. */
export function Examples(...examples: [string, ...string[]]): Decorator {
  return (t, p) => update(t, p, (m) => void (m.examples = examples));
}

/** A documentation group for the variable or file input. */
export function Group(group: string): Decorator {
  return (t, p) => update(t, p, (m) => void (m.group = group));
}

/** Marks a variable or file input as deprecated. The app warns when a deprecated variable is set. */
export function Deprecated(deprecated: { message: string; replacedBy?: string }): Decorator {
  return (t, p) => update(t, p, (m) => void (m.deprecated = deprecated));
}

/** Every file decorator takes an optional input name; the default is the property name in kebab case. */
export interface FileNameOption {
  /** The file input's name in the contract, a DNS label. Default: the property name in kebab case (`servingTls` → `serving-tls`). */
  name?: string;
}

function fileDecorator(input: FileInput, name: string | undefined): Decorator {
  return (t, p) => update(t, p, (m) => void (m.file = { name, input }));
}

function split<T extends FileNameOption>(options: T): [string | undefined, Omit<T, "name">] {
  const { name, ...rest } = options;
  return [name, rest];
}

/**
 * A structured config file (`json` or `yaml`), validated at boot against
 * `schema`: a class-validator class (nested classes need `@ValidateNested()`
 * and class-transformer's `@Type()`), or a Zod schema.
 */
export function ConfigFile(options: ConfigFileOptions<JsonSchemaSource, boolean> & FileNameOption): Decorator {
  const [name, rest] = split(options);
  return fileDecorator(makeFileInput("config", rest), name);
}

/** A TLS key pair directory (tls.crt, tls.key, optional ca.crt). The property is a `TlsMaterial`. */
export function TlsFile(options: TlsFileOptions<boolean> & FileNameOption): Decorator {
  const [name, rest] = split(options);
  return fileDecorator(tlsFile(rest), name);
}

/** A PEM bundle of one or more CA certificates. The property is a `CaBundle`. */
export function CaBundleFile(options: CaBundleFileOptions<boolean> & FileNameOption): Decorator {
  const [name, rest] = split(options);
  return fileDecorator(caBundleFile(rest), name);
}

/** A PKCS#12 (or JKS) keystore, opened at boot with the password in `passwordVar`. The property is a `Keystore`. */
export function KeystoreFile(options: KeystoreFileOptions<boolean> & FileNameOption): Decorator {
  const [name, rest] = split(options);
  return fileDecorator(keystoreFile(rest), name);
}

/** A UTF-8 text file, such as a licence key. The property is a `string`. */
export function TextFile(options: TextFileOptions<boolean> & FileNameOption): Decorator {
  const [name, rest] = split(options);
  return fileDecorator(textFile(rest), name);
}

/** Opaque bytes, such as a GeoIP database. Only the size is checked. The property is a `Buffer`. */
export function BinaryFile(options: BinaryFileOptions<boolean> & FileNameOption): Decorator {
  const [name, rest] = split(options);
  return fileDecorator(binaryFile(rest), name);
}
