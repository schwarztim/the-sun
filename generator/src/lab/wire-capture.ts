/**
 * Wire-level TLS ClientHello capture (JA4 fingerprint gate).
 *
 * Stage 0 decision (recorded in src/templates/python/http_client.py): the
 * capture mechanism is a self-hosted TLS-terminus echo — the actual
 * destination curl_cffi connects to — NOT a MITM forward proxy. A MITM
 * proxy fingerprints the proxy's own upstream ClientHello, not the
 * server's; a terminus that IS the destination captures the real bytes.
 *
 * This module implements the terminus as a raw TCP listener that reads the
 * TLS record layer directly and computes JA4 from the ClientHello — no TLS
 * handshake is completed. That's sufficient for gate 4: it only needs to
 * observe the wire bytes, not obtain an HTTP response (a real backend for
 * actual tool responses is provided separately by mock-backend.ts, over
 * plain HTTP, so gates 6-9 aren't coupled to this TLS-parsing code path).
 *
 * JA4 spec (FoxIO): https://github.com/FoxIO-LLC/ja4
 * Empirically validated 2026-07-02 against the Stage-0 wire-verified
 * anchors in http_client.py — this exact parser, run against curl_cffi
 * 0.15.0 impersonating chrome131 with tls_permute_extensions, reproduced
 * `t13d1516h2_8daaf6152771_02713d6af862` byte-for-byte on a loopback
 * capture (see src/lab/wire-capture.test.ts for the frozen fixture).
 */
import crypto from "node:crypto";
import net from "node:net";

export interface ClientHelloInfo {
  legacyVersion: number;
  supportedVersionsMax?: number;
  /** Cipher suites in ClientHello order, GREASE values already stripped. */
  cipherSuites: number[];
  /** Extension type IDs in ClientHello order, GREASE values already stripped. */
  extensions: number[];
  hasSni: boolean;
  alpnProtocols: string[];
  /** signature_algorithms values, in ClientHello order (NOT sorted), GREASE stripped. */
  signatureAlgorithms: number[];
}

/**
 * GREASE values (RFC 8701) are all 16-bit values of the form 0x?A?A where
 * both bytes are equal and each byte's low nibble is 0xA (0x0A0A, 0x1A1A,
 * ... 0xFAFA). They exist purely to detect naive parsers and MUST be
 * excluded from every JA4 count/hash.
 */
export function isGrease(value: number): boolean {
  const hi = (value >> 8) & 0xff;
  const lo = value & 0xff;
  return hi === lo && (lo & 0x0f) === 0x0a;
}

function hex4(v: number): string {
  return v.toString(16).padStart(4, "0");
}

function sha256_12(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

function versionCode(v: number | undefined): string {
  switch (v) {
    case 0x0304:
      return "13";
    case 0x0303:
      return "12";
    case 0x0302:
      return "11";
    case 0x0301:
      return "10";
    case 0x0300:
      return "s3";
    default:
      return "00";
  }
}

/**
 * Parse a single reassembled TLS Handshake message (type byte + 3-byte
 * length + body) known to be a ClientHello (type 0x01). Returns null if
 * the buffer isn't a well-formed ClientHello.
 */
export function parseClientHello(buf: Buffer): ClientHelloInfo | null {
  if (buf.length < 4 || buf[0] !== 0x01) return null;
  const hsLen = (buf[1] << 16) | (buf[2] << 8) | buf[3];
  if (buf.length < 4 + hsLen) return null;
  const body = buf.subarray(4, 4 + hsLen);
  let off = 0;

  if (body.length < off + 2) return null;
  const legacyVersion = body.readUInt16BE(off);
  off += 2;

  off += 32; // random
  if (body.length < off + 1) return null;
  const sessIdLen = body[off];
  off += 1 + sessIdLen;

  if (body.length < off + 2) return null;
  const csLen = body.readUInt16BE(off);
  off += 2;
  const cipherSuites: number[] = [];
  for (let i = 0; i + 1 < csLen; i += 2) {
    cipherSuites.push(body.readUInt16BE(off + i));
  }
  off += csLen;

  if (body.length < off + 1) return null;
  const compLen = body[off];
  off += 1 + compLen;

  let hasSni = false;
  const alpnProtocols: string[] = [];
  let supportedVersionsMax: number | undefined;
  const signatureAlgorithms: number[] = [];
  const extensions: number[] = [];

  if (off + 2 <= body.length) {
    const extTotalLen = body.readUInt16BE(off);
    off += 2;
    const extEnd = Math.min(off + extTotalLen, body.length);
    while (off + 4 <= extEnd) {
      const extType = body.readUInt16BE(off);
      off += 2;
      const extLen = body.readUInt16BE(off);
      off += 2;
      const extData = body.subarray(off, Math.min(off + extLen, body.length));
      if (!isGrease(extType)) extensions.push(extType);

      if (extType === 0x0000) {
        hasSni = true;
      } else if (extType === 0x0010 && extData.length >= 2) {
        let p = 2;
        while (p < extData.length) {
          const plen = extData[p];
          p += 1;
          alpnProtocols.push(extData.subarray(p, p + plen).toString("latin1"));
          p += plen;
        }
      } else if (extType === 0x002b && extData.length >= 1) {
        const listLen = extData[0];
        let max = 0;
        for (let i = 1; i + 1 < 1 + listLen && i + 1 < extData.length; i += 2) {
          const v = extData.readUInt16BE(i);
          if (!isGrease(v) && v > max) max = v;
        }
        supportedVersionsMax = max || undefined;
      } else if (extType === 0x000d && extData.length >= 2) {
        const listLen = extData.readUInt16BE(0);
        for (let i = 2; i + 1 < 2 + listLen && i + 1 < extData.length; i += 2) {
          const v = extData.readUInt16BE(i);
          if (!isGrease(v)) signatureAlgorithms.push(v);
        }
      }
      off += extLen;
    }
  }

  return {
    legacyVersion,
    supportedVersionsMax,
    cipherSuites: cipherSuites.filter((c) => !isGrease(c)),
    extensions,
    hasSni,
    alpnProtocols,
    signatureAlgorithms,
  };
}

/** Compute the JA4 fingerprint string from a parsed ClientHello. */
export function computeJA4(info: ClientHelloInfo): string {
  const version = versionCode(info.supportedVersionsMax ?? info.legacyVersion);
  const sni = info.hasSni ? "d" : "i";
  const cCount = Math.min(info.cipherSuites.length, 99).toString().padStart(2, "0");
  const eCount = Math.min(info.extensions.length, 99).toString().padStart(2, "0");
  let alpn = "00";
  if (info.alpnProtocols.length > 0 && info.alpnProtocols[0].length > 0) {
    const first = info.alpnProtocols[0];
    alpn = first[0] + first[first.length - 1];
  }
  const ja4a = `t${version}${sni}${cCount}${eCount}${alpn}`;

  const cipherHex = info.cipherSuites.map(hex4).sort();
  const ja4b = cipherHex.length ? sha256_12(cipherHex.join(",")) : "000000000000";

  // ja4_c excludes SNI (0x0000) and ALPN (0x0010) from the extension list
  // (they're already represented in ja4_a) and is a hash of the sorted
  // extension list plus the signature_algorithms list IN CLIENTHELLO ORDER
  // (not sorted) — see JA4 spec. Both lists concatenated into one string
  // before a single SHA-256, not two independently-hashed halves.
  const extForHash = info.extensions
    .filter((e) => e !== 0x0000 && e !== 0x0010)
    .map(hex4)
    .sort();
  const sigAlgHex = info.signatureAlgorithms.map(hex4);
  let ja4cRaw = extForHash.join(",");
  if (sigAlgHex.length) ja4cRaw += "_" + sigAlgHex.join(",");
  const ja4c = extForHash.length || sigAlgHex.length ? sha256_12(ja4cRaw) : "000000000000";

  return `${ja4a}_${ja4b}_${ja4c}`;
}

/** Result of a single-connection capture attempt. */
export interface CaptureResult {
  ja4: string | null;
  /** Raw parse failure reason, if any (e.g. connection closed before a full ClientHello arrived). */
  error?: string;
}

/**
 * Start a raw-socket TLS-terminus echo that captures exactly one inbound
 * ClientHello, computes its JA4, and then resets the connection (no
 * handshake is completed — see module docstring for why that's sufficient
 * for gate 4). Returns the assigned port plus a promise that resolves with
 * the capture result once a connection arrives (or the timeout elapses).
 */
export function startCaptureServer(
  timeoutMs = 10_000,
): Promise<{ port: number; result: Promise<CaptureResult>; close(): void }> {
  return new Promise((resolveStart, rejectStart) => {
    let settleResult: (r: CaptureResult) => void;
    const result = new Promise<CaptureResult>((resolve) => {
      settleResult = resolve;
    });
    let settled = false;
    const finish = (r: CaptureResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleResult(r);
    };

    const server = net.createServer((socket) => {
      const recordChunks: Buffer[] = [];
      let total = 0;
      socket.on("data", (chunk) => {
        recordChunks.push(chunk);
        total += chunk.length;
        const buf = Buffer.concat(recordChunks, total);

        // Walk the TLS record layer, collecting Handshake-typed (0x16)
        // record payloads — a large ClientHello can span >1 record.
        let recOff = 0;
        const hsBytes: Buffer[] = [];
        while (recOff + 5 <= buf.length) {
          const contentType = buf[recOff];
          const recLen = buf.readUInt16BE(recOff + 3);
          if (recOff + 5 + recLen > buf.length) break; // incomplete record; wait for more data
          if (contentType === 0x16) {
            hsBytes.push(buf.subarray(recOff + 5, recOff + 5 + recLen));
          }
          recOff += 5 + recLen;
        }
        if (hsBytes.length === 0) return;
        const hs = Buffer.concat(hsBytes);
        if (hs.length < 4) return;
        const declaredLen = (hs[1] << 16) | (hs[2] << 8) | hs[3];
        if (hs.length < 4 + declaredLen) return; // still waiting on a fragment

        const info = parseClientHello(hs);
        socket.destroy();
        if (info) {
          finish({ ja4: computeJA4(info) });
        } else {
          finish({ ja4: null, error: "captured bytes did not parse as a ClientHello" });
        }
      });
      socket.on("error", () => {
        finish({ ja4: null, error: "socket error before a full ClientHello arrived" });
      });
    });

    const timer = setTimeout(() => {
      finish({ ja4: null, error: `no connection observed within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();

    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      if (port === null) {
        rejectStart(new Error("failed to allocate a free port for the capture server"));
        return;
      }
      resolveStart({
        port,
        result,
        close: () => server.close(),
      });
    });
  });
}
