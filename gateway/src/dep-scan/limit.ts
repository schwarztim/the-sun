/**
 * limit.ts (OPS-5) — a tiny hand-rolled concurrency-bounded map (no deps).
 *
 * The per-package fan-out in index.ts used Promise.all over the whole install
 * list, so a huge (or attacker-influenced) list could open unbounded sockets to
 * the registries/OSV at once. mapLimit runs at most `limit` calls concurrently
 * while preserving input order in the result array.
 */

/** Default fan-out ceiling; DEP_SCAN_CONCURRENCY overrides in index.ts. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Map items through fn with at most `limit` in flight at once. Results are
 * returned in input order. A rejection from any fn call rejects the whole
 * batch (index.ts wraps the batch in its own fail-open try/catch, so this can
 * never turn into a hard block).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  // Clamp the worker count to [1, items.length]; a bad/zero limit still runs.
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    // `nextIndex++` is atomic within the synchronous step (no await between the
    // read and the increment), so two workers never claim the same index.
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
