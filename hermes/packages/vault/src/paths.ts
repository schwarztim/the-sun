/**
 * Filesystem locations for the Hermes vault. All paths derive from a single
 * base directory (`~/.hermes`) that is overridable via the `HERMES_DIR` env var
 * or an explicit argument, so tests never touch the real `~/.hermes`.
 */
import os from 'node:os';
import path from 'node:path';

/** POSIX file-mode operations (chmod, dir-fsync) are no-ops / unsupported on Windows. */
export const IS_WINDOWS = process.platform === 'win32';

/** Base `~/.hermes` directory. Precedence: explicit arg → `HERMES_DIR` env → `~/.hermes`. */
export function hermesDir(override?: string): string {
  if (override) return override;
  const env = process.env['HERMES_DIR'];
  if (env) return env;
  return path.join(os.homedir(), '.hermes');
}

/** Whole-file encrypted vault: `<hermesDir>/vault.enc`. */
export function vaultFilePath(dir?: string): string {
  return path.join(hermesDir(dir), 'vault.enc');
}

/** Raw 32-byte master key file: `<hermesDir>/master.key`. */
export function masterKeyFilePath(dir?: string): string {
  return path.join(hermesDir(dir), 'master.key');
}

/** Cross-process lock sidecar for the vault file: `<vaultPath>.lock`. */
export function lockFilePath(vaultPath: string): string {
  return `${vaultPath}.lock`;
}
