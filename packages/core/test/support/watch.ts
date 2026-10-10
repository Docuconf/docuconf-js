import { writeFileSync } from "node:fs";

/**
 * Writes `content` to `file` until `changed` settles, then returns it.
 *
 * On macOS, fs.watch uses FSEvents, whose stream starts asynchronously: a
 * write made in the same tick as watch() can be missed, so the test would
 * wait forever. Rewriting the same bytes every 100 ms until the listener
 * fires covers that window; on Linux (inotify) the first write is enough.
 */
export async function writeUntilChanged<T>(file: string, content: string, changed: Promise<T>): Promise<T> {
  let settled = false;
  const done = changed.finally(() => {
    settled = true;
  });
  writeFileSync(file, content);
  const timer = setInterval(() => {
    if (!settled) writeFileSync(file, content);
  }, 100);
  try {
    return await done;
  } finally {
    clearInterval(timer);
  }
}
