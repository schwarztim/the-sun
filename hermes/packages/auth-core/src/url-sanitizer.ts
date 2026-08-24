const SENSITIVE_PARAMS = [
  'SAMLRequest', 'SAMLResponse', 'code', 'state',
  'flowToken', 'RelayState', 'session_state',
  'id_token', 'access_token', 'refresh_token',
];

/**
 * Remove known OAuth/SAML/MS session query parameters from a URL.
 * Returns the URL with sensitive params stripped. Preserves origin, path, and
 * any query params that are not in the sensitive list.
 * Returns the raw string unchanged if it cannot be parsed as a URL.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const p of SENSITIVE_PARAMS) {
      // Case-insensitive deletion
      const keys = [...u.searchParams.keys()];
      for (const k of keys) {
        if (k.toLowerCase() === p.toLowerCase()) u.searchParams.delete(k);
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}
