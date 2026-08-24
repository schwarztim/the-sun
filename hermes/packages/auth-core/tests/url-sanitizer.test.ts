import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from '../src/url-sanitizer.js';

describe('sanitizeUrl', () => {
  it('strips SAMLRequest and RelayState from MS login URL', () => {
    const out = sanitizeUrl('https://login.microsoftonline.com/abc/saml2?SAMLRequest=x&RelayState=y');
    expect(out).not.toContain('SAMLRequest=');
    expect(out).not.toContain('RelayState=');
  });

  it('strips code and state but preserves other params', () => {
    const out = sanitizeUrl('https://example.com?code=abc&state=def&kept=yes');
    expect(out).not.toContain('code=');
    expect(out).not.toContain('state=');
    expect(out).toContain('kept=yes');
  });

  it('returns raw string unchanged on parse failure', () => {
    const raw = 'not-a-url';
    expect(sanitizeUrl(raw)).toBe(raw);
  });

  it('returns URL unchanged when no sensitive params present', () => {
    const url = 'https://example.com/path';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('strips lowercase samlrequest (case-insensitive matching)', () => {
    const out = sanitizeUrl('https://example.com?samlrequest=x');
    expect(out).not.toContain('samlrequest=');
    expect(out).not.toContain('samlrequest');
  });
});
