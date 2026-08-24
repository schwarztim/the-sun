/**
 * Plain-HTTP mock backend for the callability (gate 6) and precision
 * (gate 7) gates.
 *
 * Deliberately NOT the wire-fingerprint terminus (wire-capture.ts): those
 * gates don't care about the TLS wire fingerprint, only about the shape of
 * the HTTP response a generated tool receives when it calls out. Using
 * plain `http://` here keeps this backend trivial (no cert, no TLS
 * handshake) and keeps the wire-fingerprint gate the ONLY gate coupled to
 * TLS-layer capture — a single-responsibility split.
 *
 * Routing: any request whose method+path matches a known op (from
 * coverage.json, or the tool list when no manifest exists) gets a
 * well-formed JSON 2xx if it carries an Authorization header, or a
 * well-formed JSON 401 if it doesn't (credential-free path — gate 6).
 * Anything else (path the server was never told about) gets 404, which is
 * exactly what the precision gate (gate 7) is watching for: a generated
 * tool that calls a path outside the known set is either mis-mapped or
 * fabricated.
 */
import http from "node:http";

export interface KnownOp {
  method: string;
  path: string;
}

export interface MockRequestLogEntry {
  method: string;
  path: string;
  hadAuth: boolean;
  status: number;
}

export interface MockBackend {
  port: number;
  requestLog: MockRequestLogEntry[];
  close(): Promise<void>;
}

/**
 * Matches a request path against a known op path that may contain
 * `{param}`-style segments (coverage.json convention) or a literal path.
 */
function pathMatches(pattern: string, actual: string): boolean {
  const patternSegs = pattern.replace(/^\/|\/$/g, "").split("/");
  const actualSegs = actual.replace(/^\/|\/$/g, "").split("/");
  if (patternSegs.length !== actualSegs.length) return false;
  return patternSegs.every(
    (seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === actualSegs[i],
  );
}

export function startMockBackend(knownOps: KnownOp[]): Promise<MockBackend> {
  return new Promise((resolve, reject) => {
    const requestLog: MockRequestLogEntry[] = [];

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = (req.method ?? "GET").toUpperCase();
      const hadAuth = Boolean(req.headers["authorization"]);
      const matched = knownOps.some(
        (op) => op.method.toUpperCase() === method && pathMatches(op.path, url.pathname),
      );

      // Drain the request body so curl_cffi/httpx never sees a hung socket.
      req.resume();
      req.on("end", () => {
        let status: number;
        let body: Record<string, unknown>;
        if (!matched) {
          status = 404;
          body = { error: "not_found", message: `no route for ${method} ${url.pathname}` };
        } else if (!hadAuth) {
          status = 401;
          body = { error: "unauthorized", message: "missing credentials" };
        } else {
          status = 200;
          body = { ok: true, method, path: url.pathname };
        }
        requestLog.push({ method, path: url.pathname, hadAuth, status });
        const payload = Buffer.from(JSON.stringify(body));
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": String(payload.length),
        });
        res.end(payload);
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      if (port === null) {
        reject(new Error("failed to allocate a free port for the mock backend"));
        return;
      }
      resolve({
        port,
        requestLog,
        close: () =>
          new Promise<void>((res2) => {
            server.close(() => res2());
          }),
      });
    });
  });
}
