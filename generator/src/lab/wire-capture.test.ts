import net from "node:net";
import { describe, expect, it } from "vitest";
import { computeJA4, isGrease, parseClientHello, startCaptureServer } from "./wire-capture.js";

/**
 * A real, frozen TLS 1.3 ClientHello handshake message (type byte + 3-byte
 * length + body — no TLS record-layer header), captured 2026-07-02 from
 * curl_cffi 0.15.0 impersonating chrome131 with tls_permute_extensions
 * enabled, against `https://localhost:<port>/` (SNI present). This is the
 * exact byte sequence the Stage-0 spike's wire-verified anchors in
 * src/templates/python/http_client.py were derived from — freezing it
 * here means this test never depends on network access or curl_cffi being
 * installed, while still exercising the real parser against real bytes
 * (not a synthetic ClientHello that might not match real-world framing).
 */
const REAL_CHROME131_CLIENTHELLO_B64 =
  "AQAGmgMDCJdT4Hs1BepbPkygOKIOy43h6Xh2eEaNjgZlyRQpWnUgnENgRjR34r4uTaCeb+ULNjWTQVK0kP3MvVo++igXZpEAHhMBEwITA8ArwC/ALMAwzKnMqMATwBQAnACdAC8ANQEABjMAMwTqBOgR7ATAAcmw0XiiyYQt1yjLVArNBWgIT+Nun0drZRd7dUMmtYhx/ZlS57zIHRaG8GzFSzM9WaG8jJanxGtgddC6ZEkUHbVu4MR6EcZjfgBycyCNdmVz9aCO68KYbNsxFQOfqxNGshZxNrt5tNiVxfN9lppxdvu732XCyAsdSxB4cZN2WVq2H3e4msMSW8xpTnhz5Qic4uMXEtUBNCATt0AEnKVEFgZ1yYXE0eVdAeHOVQQoq4SLrnkFPVIlDXyiM5y6wRBtkKkgm5hTkHCIYQdxb4I40fW0ESgRrlM1DXyeKCkUoJlv+EuSAKfDruxLRNJ8EXiJ6TNSOIJ2WFWqOhhG5bhvV1ATbWGYqcEvAli1ZesdDrkyR+QUFMBX6UsBy5uJbaieXVF9W/Ix55YIKLmLpaZHFYiNh+e+v1Ew8LecuMYqaFhhTwdlALtqBuS0H9ke3CnGtUiMqklkcrSU1BXJ8FKocRcWpNJ6gkUCfIokBkZQ+nynJAgzpUCY43OrEhQkMleuXIgPBJiUbfp/q2UXURDFO7KtD+ketFqgPiFsREhxSnJxkfGIaCR8WUokDGy5qHEqdaMqM2VL0EMpb8QDLndRtRNYl+F8RGx4auWnnvwxEGe+QoB2a0dv0EWxTvka7ySvYQXM6NqtRiZUsnF1OPeDbMhL+Wxi84JuLym9ZHV+AXwg36Gr3NNOCtpoHjuPMWPASHpYJwg9esh8QoEXr0VmxDZAkbZV0BJsIOWo8NCtUlw9qANBU1JKpKUX7axnVpaolIF82clM6hGKyFIpAMmsl/I0sIBZEPYHgLYOH0ANQAc9e+uUFdy04xYRAsga9Lo6KXGzDTRhzpC44sWL9MKct/M2/CKCxpgBKIW0OFiYmxmwnzjDjehajnXC3yCiIhJDWZA378cmZ4N/2jw5bGgY2lmIrXQvwimxX4nCxGZR3YgwcUR2iRwtOHeuVNK+BKMKzZUS4Qox6ViJpfukMzOqprqtgLhOIArAYrhfHmirzwc3G0hyR2J9IuQuZyanpKZa+xEB+SeG8/DMgEpCl4pWIRfCqtK5yHmz39VVaUMtHZWonVi5TvCFaHysLaaDppaBliAh2YSFYVAXQFsjqjlFhnstmqBAeWnJQih+c5EwGMhsWbSpzWwJk+gtXRYpc0al0UabecIix9hW8foPDfEAU5FbgKvN3SwaOdQfC9ZnqbE1NOq1bDQWkzM2YaePtyoZbRZCPsswooRqL2aua6h9IsOczLUUyimggfvEHDG/jOC/WwabXHchBNRjW/M0CcdMXNyoCzNKNbSAC6G4Y5d3ddJBUZeIfaczcRKoOxBQCKigLMYoGciT9uOZKzcrmQRmF8gJLBJFznBWrECaAYRq3yAkpkHP1HGUY4dqH3ljJ1qQdsAG1AMtX7ddv4grDfCtvvCQ/rIQyiaAZXPG2lVgKVwhDYYMXKmzB/GzMQoyDPmIWvsvFUKgp/U3DKehf4GYwlKyZyxWc4rBZ4YZ6tVKD/JCbsmafesH+6BdLBIrGHhZ9Ex+krHKB4ec0aRg9fQPx8p40pLWVYaq4QnY/qIde8e11bjgQr2yq/UOsLMX0yuAd6NBuotV5Oq+Z9UrqriBgkmmmPyk1/SzGbXKclu/YgAdACAnQJyJr/qTxRjxjBxMefhSQwVxt3C3eavhKD45doimHAANABIAEAQDCAQEAQUDCAUFAQgGBgH+DQC6AAABAAGdACBJ4KQqVaYnmRyNhDDOaIv84wq0D7XpyEoci6Q4ue5NfwCQ0gW8VVIHfd5p3MceEZzzgPSaTNwiYxcWgTn3IoxzrxSfRAjaa5Yw9kZgsKQ2KDXIG2hcp55QycdNyQVlHorzfwfCVwbWEs9yfvNXDdHueVQbxhpQTthHQwfG11vvzxjrxHLLtfBi9By9Caf1fwW0NllYMwVTQXRLa7lgMDsp56NNxrB/d22/sxGSIQVtHFcgACMAAAAKAAoACBHsAB0AFwAYAAAADgAMAAAJbG9jYWxob3N0ABsAAwIAAgAtAAIBAURpAAUAAwJoMgAXAAAAKwAFBAMEAwMACwACAQAABQAFAQAAAAAAEgAAABAADgAMAmgyCGh0dHAvMS4x/wEAAQA=";

// Ground-truth JA4 for the buffer above — see http_client.py's "Wire-
// verified in Stage 0" docstring comment; this test's whole purpose is
// proving this file's parser reproduces that value from the raw bytes.
const EXPECTED_JA4 = "t13d1516h2_8daaf6152771_02713d6af862";

function tlsRecord(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0x16; // Handshake content type
  header.writeUInt16BE(0x0303, 1); // record-layer version (legacy)
  header.writeUInt16BE(payload.length, 3);
  return Buffer.concat([header, payload]);
}

describe("isGrease", () => {
  it("recognizes every RFC 8701 GREASE value (0x0A0A, 0x1A1A, ... 0xFAFA)", () => {
    for (let i = 0; i <= 0xf; i++) {
      const byte = (i << 4) | 0x0a; // 0x?A
      const grease = (byte << 8) | byte; // 0x?A?A
      expect(isGrease(grease)).toBe(true);
    }
  });

  it("rejects real cipher/extension IDs", () => {
    expect(isGrease(0x1301)).toBe(false); // TLS_AES_128_GCM_SHA256
    expect(isGrease(0x002b)).toBe(false); // supported_versions
  });
});

describe("parseClientHello + computeJA4 (frozen real Chrome capture)", () => {
  const hsBuffer = Buffer.from(REAL_CHROME131_CLIENTHELLO_B64, "base64");

  it("parses the frozen ClientHello without error", () => {
    const info = parseClientHello(hsBuffer);
    expect(info).not.toBeNull();
    expect(info!.hasSni).toBe(true);
    expect(info!.alpnProtocols).toContain("h2");
    expect(info!.cipherSuites.length).toBeGreaterThan(0);
    expect(info!.extensions.length).toBeGreaterThan(0);
  });

  it("computes the exact wire-verified JA4 from http_client.py's Stage-0 spike", () => {
    const info = parseClientHello(hsBuffer);
    expect(computeJA4(info!)).toBe(EXPECTED_JA4);
  });

  it("returns null for a non-ClientHello handshake type", () => {
    const notClientHello = Buffer.from([0x02, 0x00, 0x00, 0x01, 0x00]); // ServerHello (type 2)
    expect(parseClientHello(notClientHello)).toBeNull();
  });
});

describe("startCaptureServer", () => {
  it("captures a ClientHello sent over a raw TCP connection and computes its JA4", async () => {
    const hsBuffer = Buffer.from(REAL_CHROME131_CLIENTHELLO_B64, "base64");
    const capture = await startCaptureServer(5_000);
    const socket = net.createConnection({ port: capture.port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("error", reject);
    });
    socket.write(tlsRecord(hsBuffer));

    const result = await capture.result;
    capture.close();
    socket.destroy();

    expect(result.ja4).toBe(EXPECTED_JA4);
  });

  it("resolves with an error (not a throw) when no connection arrives in time", async () => {
    const capture = await startCaptureServer(150);
    const result = await capture.result;
    capture.close();
    expect(result.ja4).toBeNull();
    expect(result.error).toMatch(/no connection observed/);
  });
});
