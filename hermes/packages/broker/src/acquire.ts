import type { Broker } from './broker.js';

export interface AcquireOptions { broker: Broker; service: string; schemes: string[]; interactive?: boolean; }
export interface AcquireResult { acquired: string[]; failed: Array<{ scheme: string; error: string }>; }

export async function runAcquire(opts: AcquireOptions): Promise<AcquireResult> {
  try {
    const bundles = await opts.broker.acquireAllForService(opts.service, { interactive: false });
    const acquiredSchemes = bundles.map(b => b.scheme);
    const missing = opts.schemes.filter(s => !acquiredSchemes.includes(s));
    return {
      acquired: opts.schemes.filter(s => acquiredSchemes.includes(s)),
      failed: missing.map(s => ({ scheme: s, error: 'not captured during batch acquire' })),
    };
  } catch {
    // Batch not supported or failed, fall back to per-scheme
  }

  const acquired: string[] = [];
  const failed: Array<{ scheme: string; error: string }> = [];
  for (const scheme of opts.schemes) {
    try {
      await opts.broker.getToken(opts.service, scheme, { force: true, interactive: false });
      acquired.push(scheme);
    } catch (err) { failed.push({ scheme, error: (err as Error).message }); }
  }
  return { acquired, failed };
}
