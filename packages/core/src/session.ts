/** Session state an SDK's declaration calls write to while a module is imported for export. */
export interface ExportSession<T> {
  declarations: T[];
}

/**
 * Export mode, keyed by `key` (a Symbol.for name). Kept on globalThis so it
 * works even when the module under export resolves its own copy of the SDK.
 */
export function exportSession<T>(key: symbol) {
  type G = typeof globalThis & Record<symbol, ExportSession<T> | undefined>;
  return {
    begin(): ExportSession<T> {
      const s: ExportSession<T> = { declarations: [] };
      (globalThis as G)[key] = s;
      return s;
    },
    end(): void {
      delete (globalThis as G)[key];
    },
    current(): ExportSession<T> | undefined {
      return (globalThis as G)[key];
    },
  };
}
