const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Return the URL if it is safe to put in an href/src attribute, else undefined.
 * Allows http(s), mailto, tel, and relative URLs. Blocks javascript:, data:,
 * vbscript: and anything else, including scheme tricks using control characters.
 */
export function safeUrl(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const url = input.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (url === '' || url !== input.trim()) return undefined;
  if (url.startsWith('//')) return undefined;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme) {
    return SAFE_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`) ? url : undefined;
  }
  // No scheme: must be a relative path/query/fragment.
  return /^[/?#.\w~-]/.test(url) ? url : undefined;
}
