import { describe, it, expect } from 'vitest';
import { generateTotp, base32ToBytes } from '../src/totp.js';

describe('base32ToBytes', () => {
  it('decodes a known base32 string', () => {
    // "JBSWY3DP" is base32 for "Hello"
    const bytes = base32ToBytes('JBSWY3DP');
    expect(bytes.toString('utf8')).toBe('Hello');
  });

  it('strips non-base32 characters', () => {
    const a = base32ToBytes('JBSWY3DP');
    const b = base32ToBytes('JBSW Y3DP');
    expect(a.equals(b)).toBe(true);
  });
});

describe('generateTotp', () => {
  it('generates a 6-digit code', () => {
    const code = generateTotp('JBSWY3DPEHPK3PXP', 1_000_000_000_000);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('produces stable output for same time', () => {
    const t = 1_700_000_000_000;
    expect(generateTotp('JBSWY3DPEHPK3PXP', t)).toBe(generateTotp('JBSWY3DPEHPK3PXP', t));
  });

  it('produces different codes for different time windows', () => {
    const a = generateTotp('JBSWY3DPEHPK3PXP', 0);
    const b = generateTotp('JBSWY3DPEHPK3PXP', 30_000);
    // Different time windows should produce different codes (overwhelmingly likely)
    expect(a).not.toBe(b);
  });
});
