/**
 * E2E hung-page test against a REAL chromium. Gated behind HERMES_E2E_BROWSER
 * because it launches an actual browser:
 *
 *   HERMES_E2E_BROWSER=1 pnpm --filter @hermes/auth-core test -- managed-browser.e2e
 *
 * Reproduces the production leak class: an auth page whose requests never
 * fulfill (network route intercepted and dropped) hangs page.goto forever.
 * withManagedBrowser must fire the lifetime ceiling, force-close (escalating
 * to SIGKILL), and leave the browser PID dead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  withManagedBrowser,
  browserRegistry,
  BrowserAuthTimeoutError,
  resetManagedBrowserStateForTests,
} from '../src/managed-browser.js';

const E2E_ENABLED = Boolean(process.env['HERMES_E2E_BROWSER']);

describe.skipIf(!E2E_ENABLED)('withManagedBrowser e2e (real chromium)', () => {
  beforeEach(() => {
    resetManagedBrowserStateForTests();
  });

  it('kills a browser stuck on a never-fulfilled route and rejects within 10s', async () => {
    let pid: number | undefined;
    const startedAt = Date.now();

    await expect(withManagedBrowser({
      service: 'e2e-hang',
      engine: 'chromium',
      maxLifetimeMs: 4_000,
      launchOptions: { headless: true },
    }, async (browser) => {
      pid = browserRegistry.list()[0]?.pid;
      const context = await browser.newContext();
      // Intercept every request and never fulfill it — page.goto hangs.
      await context.route('**/*', () => { /* dropped */ });
      const page = await context.newPage();
      await page.goto('https://example.com/', { timeout: 60_000 });
    })).rejects.toBeInstanceOf(BrowserAuthTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(pid).toBeDefined();

    // The browser process must be dead (process.kill(pid, 0) throws ESRCH).
    // Allow a short settling window for the kernel to reap the process group.
    const isAlive = (p: number): boolean => {
      try { process.kill(p, 0); return true; } catch { return false; }
    };
    let alive = isAlive(pid as number);
    if (alive) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      alive = isAlive(pid as number);
    }
    expect(alive).toBe(false);
    expect(browserRegistry.list()).toHaveLength(0);
  }, 30_000);
});
