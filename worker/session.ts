import type { ClientMessage, EndReason, ServerMessage, SessionGrant } from '../src/shared/protocol';
import { createSession, endSession, giveConsent, joinSession, requireSharing, SessionFault, snapshot, validateFix, type Participant, type SessionData } from './session-state';
import { failure, hashSecret, json, randomSecret, readJson, requireReason, SECURITY_HEADERS } from './http';
import type { Env } from './index';

interface Attachment {
  connectionId: string; authDeadline: number; participantId?: string;
  windowAt: number; messages: number; strikes: number;
}
interface Directory { id: string; until: number; attempts: number }
const AUTH_MS = 5_000;
const INTERNAL = 'https://session.internal';

/** No coordinate is assigned to a field, storage value, or socket attachment. */
export class Session {
  private data?: SessionData;
  private directory?: Directory;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private ctx: DurableObjectState, private env: Env) {
    ctx.blockConcurrencyWhile(async () => {
      this.data = await ctx.storage.get<SessionData>('session');
      this.directory = await ctx.storage.get<Directory>('directory');
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined); return result;
  }
  private attachment(ws: WebSocket): Attachment | undefined {
    try { return ws.deserializeAttachment() as Attachment | undefined; } catch { return undefined; }
  }
  private activeParticipant(ws: WebSocket): Participant | undefined {
    const a = this.attachment(ws);
    if (!a?.participantId || !this.data || this.data.phase === 'ended') return undefined;
    return this.data.participants.find(p => p.id === a.participantId && p.connectionId === a.connectionId);
  }
  private sockets(): WebSocket[] { return this.ctx.getWebSockets(); }
  private connected(): Set<string> {
    return new Set(this.sockets().filter(ws => ws.readyState === WebSocket.OPEN).map(ws => this.activeParticipant(ws)?.id).filter((id): id is string => !!id));
  }
  private send(ws: WebSocket, message: ServerMessage): boolean {
    try { ws.send(JSON.stringify(message)); return true; } catch {
      // No payload logging. A failed socket must immediately cease to count as connected.
      const p = this.activeParticipant(ws); if (p) p.connectionId = undefined;
      ws.serializeAttachment(null);
      try { ws.close(1011, 'Connection lost'); } catch { /* Already closed. */ }
      return false;
    }
  }
  private broadcast(): void {
    if (!this.data || this.data.phase === 'ended') return;
    // A failed send invalidates that connection before updating the surviving peer.
    for (let pass = 0; pass < 2; pass++) {
      const live = this.connected(); let failed = false;
      for (const ws of this.sockets()) {
        const p = this.activeParticipant(ws);
        if (p && !this.send(ws, { type: 'state', state: snapshot(this.data, p.id, live) })) failed = true;
      }
      if (!failed) break;
    }
  }
  private async save(): Promise<void> {
    if (this.data) await this.ctx.storage.put('session', this.data);
    if (this.directory) await this.ctx.storage.put('directory', this.directory);
    await this.schedule();
  }
  private async schedule(): Promise<void> {
    const deadlines: number[] = [];
    if (this.data && this.data.phase !== 'ended') deadlines.push(this.data.expiresAt);
    if (this.directory?.until) deadlines.push(this.directory.until);
    for (const ws of this.sockets()) {
      const a = this.attachment(ws);
      if (ws.readyState === WebSocket.OPEN && a && !a.participantId) deadlines.push(a.authDeadline);
    }
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }
  private async finish(reason: EndReason): Promise<void> {
    if (!this.data || this.data.phase === 'ended') return;
    const code = this.data.code;
    endSession(this.data, reason);
    // Persist terminal state before closing connections. The opaque ID can never reopen.
    await this.save();
    for (const ws of this.sockets()) {
      this.send(ws, { type: 'ended', reason });
      ws.serializeAttachment(null);
      try { ws.close(1000, 'Session ended'); } catch { /* Already closed. */ }
    }
    if (code) {
      try { await this.env.SESSIONS.get(this.env.SESSIONS.idFromName('invite:' + code)).fetch(INTERNAL + '/retire', { method: 'POST' }); } catch { /* Directory alarm also clears the mapping. */ }
    }
  }
  private async guard(): Promise<SessionData> {
    if (!this.data || this.data.phase === 'ended') throw new SessionFault('session_ended', 'This session has ended.', 410);
    if (Date.now() >= this.data.expiresAt) { await this.finish('expired'); throw new SessionFault('session_ended', 'This session has expired.', 410); }
    return this.data;
  }
  private async participant(token: string, participantId?: string): Promise<Participant> {
    const s = await this.guard();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new SessionFault('unauthorized', 'Invalid credentials.', 401);
    const hash = await hashSecret(token);
    const p = s.participants.find(p => p.tokenHash === hash && (!participantId || p.id === participantId));
    if (!p) throw new SessionFault('unauthorized', 'Invalid credentials.', 401);
    return p;
  }
  private async newParticipant(): Promise<{ person: Participant; token: string }> {
    const token = randomSecret();
    return { person: { id: crypto.randomUUID(), tokenHash: await hashSecret(token), consent: false }, token };
  }
  private grant(p: Participant, token: string): SessionGrant {
    const s = this.data!;
    return { sessionId: s.sessionId, participantId: p.id, token, code: s.code, expiresAt: s.expiresAt };
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (path === '/reserve' && request.method === 'POST') {
          if (this.directory && Date.now() >= this.directory.until) { this.directory = undefined; await this.ctx.storage.delete('directory'); }
          if (this.directory || this.data) return json({ error: { code: 'collision', message: 'Code already used.' } }, 409);
          const body = await readJson(request);
          if (typeof body.id !== 'string' || typeof body.until !== 'number' || !Number.isFinite(body.until) || body.until <= Date.now()) throw new SessionFault('invalid_reservation', 'Invalid reservation.');
          this.directory = { id: body.id, until: body.until, attempts: 0 };
          await this.save(); return json({ ok: true }, 201);
        }
        if (path === '/lookup' && request.method === 'POST') {
          const d = this.directory;
          if (!d?.id || !d.until || Date.now() >= d.until) {
            if (d) { this.directory = undefined; await this.ctx.storage.delete('directory'); await this.save(); }
            throw new SessionFault('invitation_expired', 'This invitation has expired.', 410);
          }
          d.attempts++; await this.save();
          if (d.attempts > 40) throw new SessionFault('rate_limited', 'Too many attempts for this invitation.', 429);
          return json({ id: d.id });
        }
        if (path === '/retire' && request.method === 'POST') {
          if (this.directory) { this.directory = undefined; await this.ctx.storage.delete('directory'); await this.save(); }
          return new Response(null, { status: 204 });
        }
        if (path === '/create' && request.method === 'POST') {
          if (this.data || this.directory) throw new SessionFault('session_exists', 'Session cannot be recreated.', 409);
          const body = await readJson(request);
          if (typeof body.code !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(body.code)) throw new SessionFault('invalid_code', 'Invalid code.');
          const { person, token } = await this.newParticipant();
          this.data = createSession(this.ctx.id.toString(), body.code, Date.now(), ttl(this.env.INVITE_TTL_SECONDS, 600) * 1000, ttl(this.env.SHARING_TTL_SECONDS, 3600) * 1000, person);
          await this.save(); return json(this.grant(person, token), 201);
        }
        const s = await this.guard();
        if (path === '/join' && request.method === 'POST') {
          const { person, token } = await this.newParticipant();
          joinSession(s, person, Date.now()); await this.save(); this.broadcast();
          return json(this.grant(person, token), 201);
        }
        if (path === '/end' && request.method === 'POST') {
          const authorization = request.headers.get('Authorization') ?? '';
          if (!authorization.startsWith('Bearer ')) throw new SessionFault('unauthorized', 'Authentication required.', 401);
          await this.participant(authorization.slice(7));
          const reason = requireReason(await readJson(request)); await this.finish(reason);
          return new Response(null, { status: 204 });
        }
        if (path === '/socket' && request.method === 'GET') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new SessionFault('upgrade_required', 'WebSocket required.', 426);
          s.socketAttempts = (s.socketAttempts ?? 0) + 1;
          await this.save();
          if (s.socketAttempts > 120) throw new SessionFault('rate_limited', 'Connection attempt limit reached. Create a new invitation.', 429);
          if (this.sockets().filter(ws => ws.readyState === WebSocket.OPEN).length >= 8) throw new SessionFault('rate_limited', 'Too many connections.', 429);
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1]);
          pair[1].serializeAttachment({ connectionId: crypto.randomUUID(), authDeadline: Date.now() + AUTH_MS, windowAt: Date.now(), messages: 0, strikes: 0 } satisfies Attachment);
          await this.schedule();
          return new Response(null, { status: 101, webSocket: pair[0], headers: SECURITY_HEADERS });
        }
        throw new SessionFault('not_found', 'API route not found.', 404);
      } catch (e) {
        if (this.data && this.data.phase !== 'ended' && Date.now() >= this.data.expiresAt) await this.finish('expired');
        return failure(e);
      }
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.serial(async () => {
      try {
        const s = await this.guard();
        const a = this.attachment(ws);
        if (!a || typeof a.connectionId !== 'string') throw new SessionFault('unauthorized', 'Authentication required.', 401);
        if (!a.participantId && Date.now() >= a.authDeadline) throw new SessionFault('auth_timeout', 'Authentication timed out.', 401);
        if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > 2048) throw new SessionFault('invalid_message', 'Invalid message.');
        if (Date.now() - a.windowAt >= 10_000) { a.windowAt = Date.now(); a.messages = 0; }
        if (++a.messages > 60) throw new SessionFault('rate_limited', 'Too many messages.', 429);
        ws.serializeAttachment(a);
        let m: ClientMessage;
        try { m = JSON.parse(message) as ClientMessage; } catch { throw new SessionFault('invalid_message', 'Invalid JSON.'); }
        if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') throw new SessionFault('invalid_message', 'Invalid message.');
        if (!a.participantId) {
          if (m.type !== 'authenticate' || typeof m.participantId !== 'string' || typeof m.token !== 'string' || Object.keys(m).sort().join(',') !== 'participantId,token,type') throw new SessionFault('unauthorized', 'Authenticate as the first message.', 401);
          const p = await this.participant(m.token, m.participantId);
          const old = this.sockets().filter(other => other !== ws && this.activeParticipant(other)?.id === p.id);
          p.connectionId = a.connectionId; a.participantId = p.id; ws.serializeAttachment(a);
          await this.save();
          for (const other of old) { other.serializeAttachment(null); try { other.close(1000, 'Reconnected elsewhere'); } catch { /* Closed. */ } }
          this.broadcast(); return;
        }
        const p = this.activeParticipant(ws);
        if (!p) throw new SessionFault('unauthorized', 'Connection is no longer authenticated.', 401);
        if (m.type === 'ping' && Object.keys(m).length === 1) { this.send(ws, { type: 'pong' }); return; }
        if (m.type === 'consent' && m.granted === true && Object.keys(m).length === 2) {
          giveConsent(s, p.id, Date.now()); await this.save(); this.broadcast(); return;
        }
        if (m.type === 'end' && Object.keys(m).length === 2 && (m.reason === 'stopped' || m.reason === 'found')) { await this.finish(m.reason); return; }
        if (m.type === 'location' && Object.keys(m).length === 2) {
          requireSharing(s, Date.now());
          const fix = validateFix(m.fix, Date.now(), p.lastFixTimestamp, p.lastFixAt);
          p.lastFixTimestamp = fix.timestamp; p.lastFixAt = Date.now();
          // Only ordering/rate metadata is durable. The coordinate exists only in this event.
          await this.save();
          await this.guard();
          for (const other of this.sockets()) {
            const peer = this.activeParticipant(other);
            if (peer && peer.id !== p.id && peer.consent && !this.send(other, { type: 'peer-location', fix })) this.broadcast();
          }
          return;
        }
        throw new SessionFault('invalid_message', 'Unsupported message.');
      } catch (error) {
        const e = error instanceof SessionFault ? error : new SessionFault('unavailable', 'Connection failed.', 503);
        this.send(ws, { type: 'error', code: e.code, message: e.message });
        const a = this.attachment(ws);
        if (!a || !this.activeParticipant(ws) || e.status === 401 || e.status === 410 || e.code === 'rate_limited' || ++a.strikes >= 3) {
          await this.disconnect(ws, 1008, 'Connection ended');
        } else ws.serializeAttachment(a);
      }
    });
  }
  private async disconnect(ws: WebSocket, code: number, reason: string): Promise<void> {
    const p = this.activeParticipant(ws);
    if (p) p.connectionId = undefined;
    ws.serializeAttachment(null);
    try { ws.close(code, reason); } catch { /* Closed. */ }
    if (this.data && this.data.phase !== 'ended' && Date.now() >= this.data.expiresAt) await this.finish('expired');
    else { await this.save(); this.broadcast(); }
  }
  webSocketClose(ws: WebSocket): Promise<void> { return this.serial(() => this.disconnect(ws, 1000, 'Disconnected')); }
  webSocketError(ws: WebSocket): Promise<void> { return this.serial(() => this.disconnect(ws, 1011, 'Connection lost')); }
  alarm(): Promise<void> {
    return this.serial(async () => {
      const now = Date.now();
      if (this.directory?.until && now >= this.directory.until) { this.directory = undefined; await this.ctx.storage.delete('directory'); }
      if (this.data && this.data.phase !== 'ended' && now >= this.data.expiresAt) await this.finish('expired');
      for (const ws of this.sockets()) {
        const a = this.attachment(ws);
        if (!a || (!a.participantId && now >= a.authDeadline) || (a.participantId && !this.activeParticipant(ws)))
          await this.disconnect(ws, 1008, 'Authentication timed out');
      }
      await this.save(); this.broadcast();
    });
  }
}
export function ttl(value: string | undefined, fallback: number): number {
  const n = Number(value); return Number.isInteger(n) && n >= 30 && n <= 86_400 ? n : fallback;
}
