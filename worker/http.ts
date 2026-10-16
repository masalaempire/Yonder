import { SessionFault } from './session-state';
export const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}
export function failure(error: unknown): Response {
  return error instanceof SessionFault ? json({ error: { code: error.code, message: error.message } }, error.status)
    : json({ error: { code: 'unavailable', message: 'Pairing is temporarily unavailable. Try again.' } }, 503);
}
export function checkOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new SessionFault('invalid_origin', 'Use this website to pair.', 403);
}
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw new SessionFault('invalid_content_type', 'Expected JSON.', 415);
  const reader = request.body?.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  if (reader) {
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 2048) { await reader.cancel(); throw new SessionFault('payload_too_large', 'Request is too large.', 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new SessionFault('invalid_json', 'Expected a JSON object.'); }
}
export function requireReason(body: Record<string, unknown>): 'stopped' | 'found' {
  if (body.reason !== 'stopped' && body.reason !== 'found') throw new SessionFault('invalid_reason', 'Invalid end reason.');
  return body.reason;
}
export function randomSecret(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashSecret(secret: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), b => b.toString(16).padStart(2, '0')).join('');
}
