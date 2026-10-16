import { checkOrigin, failure, json, readJson, requireReason, SECURITY_HEADERS } from './http';
import { SessionFault } from './session-state';
import { ttl } from './session';
export { Session } from './session';

export interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  PAIRING_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  INVITE_TTL_SECONDS?: string;
  SHARING_TTL_SECONDS?: string;
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters, exactly 40 bits.
export function invitationCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), n => ALPHABET[n & 31]).join('');
}
export function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') throw new SessionFault('invalid_code', 'Enter an eight-character code.');
  const code = value.toUpperCase().replace(/[ -]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new SessionFault('invalid_code', 'Enter an eight-character code.');
  return code;
}
async function limited(env: Env, key: string): Promise<void> {
  if (!(await env.PAIRING_LIMITER.limit({ key })).success) throw new SessionFault('rate_limited', 'Too many attempts. Wait a minute and try again.', 429);
}
function internal(path: string, body?: unknown, headers?: HeadersInit): Request {
  const values = new Headers(headers); values.set('Content-Type', 'application/json');
  return new Request('https://session.internal' + path, { method: 'POST', headers: values, body: JSON.stringify(body ?? {}) });
}
function secured(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return secured(await env.ASSETS.fetch(request));
      if (url.search) throw new SessionFault('invalid_url', 'API query parameters are not supported.');
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ status: 'ok', service: 'yonder-pairing', protocol: 1 });
      // Require the browser's exact same origin for every unsafe request and socket.
      checkOrigin(request);
      // IP is a transient limiter key only. No application persistence or logging.
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local-development';
      await limited(env, 'pairing-ip:' + ip);
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        // No client-supplied identity, coordinates, or settings are accepted here.
        const body = await readJson(request);
        if (Object.keys(body).length) throw new SessionFault('invalid_request', 'Expected an empty object.');
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = invitationCode();
          const id = env.SESSIONS.newUniqueId();
          const directory = env.SESSIONS.get(env.SESSIONS.idFromName('invite:' + code));
          const reservation = await directory.fetch(internal('/reserve', { id: id.toString(), until: Date.now() + ttl(env.INVITE_TTL_SECONDS, 600) * 1000 }));
          if (reservation.status === 409) continue;
          if (!reservation.ok) return secured(reservation);
          const created = await env.SESSIONS.get(id).fetch(internal('/create', { code }));
          if (!created.ok) await directory.fetch(internal('/retire'));
          return secured(created);
        }
        throw new SessionFault('unavailable', 'Could not create an invitation. Try again.', 503);
      }
      if (url.pathname === '/api/sessions/join' && request.method === 'POST') {
        const body = await readJson(request);
        if (Object.keys(body).length !== 1) throw new SessionFault('invalid_request', 'Expected an invitation code.');
        const code = normalizeCode(body.code);
        await limited(env, 'pairing-code:' + code);
        const directory = env.SESSIONS.get(env.SESSIONS.idFromName('invite:' + code));
        const response = await directory.fetch(internal('/lookup'));
        if (!response.ok) return secured(response);
        const lookup = await response.json() as { id: string };
        return secured(await env.SESSIONS.get(env.SESSIONS.idFromString(lookup.id)).fetch(internal('/join')));
      }
      const match = /^\/api\/sessions\/([a-f0-9]{64})\/(socket|end)$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        let objectId: DurableObjectId;
        try { objectId = env.SESSIONS.idFromString(id); } catch { throw new SessionFault('invalid_session', 'Invalid session.', 404); }
        const stub = env.SESSIONS.get(objectId);
        if (action === 'socket' && request.method === 'GET') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new SessionFault('upgrade_required', 'WebSocket required.', 426);
          await limited(env, 'socket-session:' + id);
          return stub.fetch(new Request('https://session.internal/socket', { headers: { Upgrade: 'websocket' } }));
        }
        if (action === 'end' && request.method === 'POST') {
          const body = await readJson(request); const reason = requireReason(body);
          return secured(await stub.fetch(internal('/end', { reason }, { Authorization: request.headers.get('Authorization') ?? '' })));
        }
      }
      throw new SessionFault('not_found', 'API route not found.', 404);
    } catch (error) { return failure(error); }
  },
} satisfies ExportedHandler<Env>;
