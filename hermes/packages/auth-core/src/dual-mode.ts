export interface DualModeAuthOptions {
  service: string;
  scheme: string;
  hermesUrl?: string;
  hermesToken?: string;
  standaloneAcquire: () => Promise<{ accessToken: string; expiresAt: number }>;
}

export async function getToken(opts: DualModeAuthOptions): Promise<string> {
  const url = opts.hermesUrl ?? process.env['HERMES_URL'];
  const token = opts.hermesToken ?? process.env['HERMES_CLIENT_TOKEN'];
  if (url && token) {
    const { HermesClient } = await import('@hermes/client');
    const client = new HermesClient({ brokerUrl: url, clientToken: token });
    return (await client.getToken(opts.service, opts.scheme)).accessToken;
  }
  return (await opts.standaloneAcquire()).accessToken;
}
