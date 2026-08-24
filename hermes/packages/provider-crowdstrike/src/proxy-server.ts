import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

type PlaywrightPage = import('patchright').Page;

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  page: PlaywrightPage,
): Promise<void> {
  const method = req.method ?? 'GET';
  const targetUrl = req.headers['x-proxy-url'] as string | undefined;

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing X-Proxy-URL header' }));
    return;
  }

  const body = method !== 'GET' && method !== 'HEAD' ? await collectBody(req) : undefined;
  const forwardHeaders = filterHeaders(req.headers as Record<string, string>);
  delete forwardHeaders['x-proxy-url'];

  try {
    const result = await page.evaluate(
      async ({ method, url, headers, body }) => {
        const opts: RequestInit = { method, headers, credentials: 'same-origin' };
        if (body && method !== 'GET' && method !== 'HEAD') opts.body = body;
        const resp = await fetch(url, opts);
        return {
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
          body: await resp.text(),
        };
      },
      { method, url: targetUrl, headers: forwardHeaders, body: body ?? null },
    );

    res.writeHead(result.status, filterHeaders(result.headers));
    res.end(result.body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

export interface ProxyHandle {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function startProxyServer(page: PlaywrightPage, preferredPort: number): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/__health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      handleProxy(req, res, page).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end((err as Error).message);
        }
      });
    });

    server.on('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : preferredPort;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
