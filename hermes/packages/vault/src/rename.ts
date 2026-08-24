/**
 * Atomic-rename helper shared across the Hermes filesystem stores.
 *
 * On Windows an anti-virus / indexer can transiently hold a handle to the source
 * or destination of a rename, surfacing as EPERM/EBUSY/EACCES. A short jittered
 * retry rides that out instead of failing a durable write. On POSIX these codes
 * essentially never occur, so the happy path is a single `fs.rename`.
 */
import { promises as fs } from 'node:fs';

/** Rename with a short jittered retry on transient EPERM/EBUSY/EACCES (Windows AV handle contention). */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let attempt = 0;
  for (;;) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!transient.has(code) || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1) + Math.floor(Math.random() * 20)));
      attempt++;
    }
  }
}
