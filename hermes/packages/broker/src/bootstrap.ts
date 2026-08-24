import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function generateClientToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface InitResult { dataDir: string; clientToken: string; configPath: string; clientTokenPath: string; }

export async function initDataDir(dataDir: string): Promise<InitResult> {
  await fs.mkdir(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  const clientTokenPath = path.join(dataDir, 'client.token');
  try { await fs.access(configPath); }
  catch { await fs.writeFile(configPath, JSON.stringify({ httpPort: 9876, logLevel: 'info' }, null, 2), { mode: 0o600 }); }
  let clientToken: string;
  try {
    clientToken = (await fs.readFile(clientTokenPath, 'utf8')).trim();
    if (!clientToken) throw new Error('empty');
  } catch {
    clientToken = generateClientToken();
    await fs.writeFile(clientTokenPath, clientToken, { mode: 0o600 });
  }
  return { dataDir, clientToken, configPath, clientTokenPath };
}
