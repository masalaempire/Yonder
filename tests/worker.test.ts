import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../worker/index';
import { Session } from '../worker/session';
import type { SessionGrant } from '../src/shared/protocol';

class Socket {
  readyState = 1;
  attachment: unknown;
  sent: Array<Record<string, any>> = [];
  deserializeAttachment() { return structuredClone(this.attachment); }
  serializeAttachment(a: unknown) { this.attachment = structuredClone(a); }
  send(value: string) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
function context(backing = new Map<string, unknown>(), sockets: Socket[] = []) {
  const ctx = {
    ready: Promise.resolve(), sockets, backing, alarmAt: undefined as number | undefined,
    id: { toString: () => 'a'.repeat(64) },
    blockConcurrencyWhile(fn: () => Promise<void>) { this.ready = fn(); return this.ready; },
    getWebSockets: () => sockets,
    acceptWebSocket(ws: Socket) { sockets.push(ws); },
    storage: {
      async get<T>(key: string) { return structuredClone(backing.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { backing.set(key, structuredClone(value)); },
      async delete(key: string) { return backing.delete(key); },
      async setAlarm(when: number) { ctx.alarmAt = when; },
      async deleteAlarm() { ctx.alarmAt = undefined; },
    },
  };
  return ctx;
}
function environment() {
  const fetchStub = vi.fn(async () => new Response(null, { status: 204 }));
  return { env: {
    ASSETS: { fetch: vi.fn(async () => new Response('<html>frontend</html>')) },
    PAIRING_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    SESSIONS: { get: vi.fn(() => ({ fetch: fetchStub })), idFromName: vi.fn((s: string) => s), idFromString: vi.fn((s: string) => s), newUniqueId: vi.fn(() => 'b'.repeat(64)) },
    INVITE_TTL_SECONDS: '600', SHARING_TTL_SECONDS: '3600',
  } as unknown as Env, fetchStub };
}
function internal(path: string, body = {}, headers: Record<string,string> = {}) {
  return new Request('https://session.internal' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function freshSocket(ctx: ReturnType<typeof context>) {
  const ws = new Socket(); ws.serializeAttachment({ connectionId: crypto.randomUUID(), authDeadline: Date.now()+5000, windowAt: Date.now(), messages: 0, strikes: 0 });
  ctx.sockets.push(ws); return ws;
}
const message = (session: Session, ws: Socket, value: unknown) => session.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(value));
async function pair() {
  const ctx = context(); const { env } = environment(); const session = new Session(ctx as unknown as DurableObjectState, env); await ctx.ready;
  const a = await (await session.fetch(internal('/create',{code:'ABCDEFGH'}))).json() as SessionGrant;
  const b = await (await session.fetch(internal('/join'))).json() as SessionGrant;
  return { ctx, env, session, a, b };
}
async function authenticate(session: Session, ws: Socket, grant: SessionGrant) {
  await message(session,ws,{type:'authenticate',participantId:grant.participantId,token:grant.token});
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.stubGlobal('WebSocket', { OPEN: 1 }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Worker routing and request boundaries (runtime mocks)', () => {
  const api = (path: string, method = 'POST', body = '{}', origin = 'https://yonder.test') => new Request('https://yonder.test'+path, { method, headers: { Origin: origin, 'Content-Type':'application/json' }, ...(method === 'GET' ? {} : {body}) });
  it('health proves the pairing service rather than SPA fallback; missing APIs stay JSON', async () => {
    const { env } = environment();
    const health = await worker.fetch(api('/api/health','GET'),env);
    expect(await health.json()).toMatchObject({service:'yonder-pairing',status:'ok'});
    const missing = await worker.fetch(api('/api/missing'),env);
    expect(missing.status).toBe(404); expect(missing.headers.get('Cache-Control')).toBe('no-store');
    expect(vi.mocked(env.ASSETS.fetch)).not.toHaveBeenCalled();
  });
  it('rejects cross-origin requests before rate-limit or DO access', async () => {
    const { env } = environment();
    const response = await worker.fetch(api('/api/sessions','POST','{}','https://attacker.test'),env);
    expect(response.status).toBe(403); expect(vi.mocked(env.SESSIONS.get)).not.toHaveBeenCalled();
  });
  it('bounds request payload and uses the native limiter', async () => {
    const { env } = environment();
    expect((await worker.fetch(api('/api/sessions/join','POST',JSON.stringify({code:'A'.repeat(3000)})),env)).status).toBe(413);
    vi.mocked(env.PAIRING_LIMITER.limit).mockResolvedValue({success:false});
    expect((await worker.fetch(api('/api/sessions'),env)).status).toBe(429);
  });
  it('normalizes invitation code and routes lookup to an opaque session', async () => {
    const { env, fetchStub } = environment();
    fetchStub.mockResolvedValueOnce(new Response(JSON.stringify({id:'b'.repeat(64)}))).mockResolvedValueOnce(new Response(JSON.stringify({sessionId:'b'.repeat(64)}),{status:201}));
    const response = await worker.fetch(api('/api/sessions/join','POST',JSON.stringify({code:'abcd efgh'})),env);
    expect(response.status).toBe(201);
    expect(vi.mocked(env.SESSIONS.idFromName)).toHaveBeenCalledWith('invite:ABCDEFGH');
    expect(vi.mocked(env.SESSIONS.idFromString)).toHaveBeenCalledWith('b'.repeat(64));
  });
  it('collision-retries reservation before initializing the fresh session', async () => {
    const { env, fetchStub } = environment();
    fetchStub.mockResolvedValueOnce(new Response('{}',{status:409})).mockResolvedValueOnce(new Response('{}',{status:201})).mockResolvedValueOnce(new Response('{}',{status:201}));
    expect((await worker.fetch(api('/api/sessions'),env)).status).toBe(201);
    expect(fetchStub.mock.calls.map(call => new URL((call as unknown as [Request])[0].url).pathname)).toEqual(['/reserve','/reserve','/create']);
  });
});

describe('actual Durable Object handlers with in-memory platform doubles', () => {
  it('issues independent secrets and serializes simultaneous joins to two slots', async () => {
    const {ctx,env} = await pair();
    const stored = ctx.backing.get('session') as {participants: Array<{tokenHash:string}>};
    expect(stored.participants).toHaveLength(2); expect(stored.participants[0].tokenHash).not.toBe(stored.participants[1].tokenHash);
    const hydrated = new Session(ctx as unknown as DurableObjectState,env); await ctx.ready;
    const result = await Promise.all([hydrated.fetch(internal('/join')), hydrated.fetch(internal('/join'))]);
    expect(result.map(r=>r.status)).toEqual([409,409]);
    expect(JSON.stringify(stored)).not.toContain('"token":');
  });
  it('requires first-frame auth and never sends preconsent coordinates', async () => {
    const {ctx,session,a,b} = await pair();
    const invalid = freshSocket(ctx); await message(session,invalid,{type:'ping'}); expect(invalid.readyState).toBe(3);
    const wa=freshSocket(ctx), wb=freshSocket(ctx);
    await authenticate(session,wa,a); await authenticate(session,wb,b);
    await message(session,wa,{type:'location',fix:{latitude:1,longitude:2,accuracy:5,timestamp:Date.now()}});
    expect(wb.sent.some(m=>m.type==='peer-location')).toBe(false);
    expect(wa.sent.at(-1)).toMatchObject({type:'error',code:'consent_required'});
  });
  it('restores auth and mutual consent across hibernation without storing coordinates', async () => {
    const {ctx,env,session,a,b} = await pair(); const wa=freshSocket(ctx),wb=freshSocket(ctx);
    await authenticate(session,wa,a); await authenticate(session,wb,b);
    await message(session,wa,{type:'consent',granted:true}); await message(session,wb,{type:'consent',granted:true});
    const hydrated=new Session(ctx as unknown as DurableObjectState,env); await ctx.ready;
    await message(hydrated,wa,{type:'location',fix:{latitude:31.123456,longitude:121.654321,accuracy:5,timestamp:Date.now()}});
    expect(wb.sent.at(-1)).toMatchObject({type:'peer-location',fix:{latitude:31.123456}});
    const persistence=JSON.stringify([...ctx.backing.values()])+JSON.stringify(wa.attachment)+JSON.stringify(wb.attachment);
    expect(persistence).not.toContain('31.123456'); expect(persistence).not.toContain('121.654321'); expect(persistence).not.toContain(a.token);
  });
  it('invalidates old socket only after valid replacement auth and clears guidance on disconnect/error', async () => {
    const {ctx,session,a,b}=await pair(); const wa=freshSocket(ctx),wb=freshSocket(ctx);
    await authenticate(session,wa,a); await authenticate(session,wb,b);
    const wrong=freshSocket(ctx); await authenticate(session,wrong,{...a,token:'0'.repeat(64)}); expect(wa.readyState).toBe(1);
    const replacement=freshSocket(ctx); await authenticate(session,replacement,a); expect(wa.readyState).toBe(3);
    await session.webSocketClose(wa as unknown as WebSocket); expect(wb.sent.at(-1)?.state.peerConnected).toBe(true);
    await session.webSocketError(replacement as unknown as WebSocket); expect(wb.sent.at(-1)?.state.peerConnected).toBe(false);
  });
  it('auth deadline and session expiry survive reconstruction and alarms', async () => {
    const {ctx,env}=await pair(); const unauth=freshSocket(ctx);
    vi.setSystemTime(Date.now()+5001);
    let hydrated=new Session(ctx as unknown as DurableObjectState,env); await ctx.ready; await hydrated.alarm();
    expect(unauth.readyState).toBe(3);
    vi.setSystemTime(1_600_001); hydrated=new Session(ctx as unknown as DurableObjectState,env); await ctx.ready; await hydrated.alarm();
    expect((ctx.backing.get('session') as {phase:string;participants:unknown[]}).phase).toBe('ended');
    expect((await hydrated.fetch(internal('/join'))).status).toBe(410);
    expect((await hydrated.fetch(internal('/create',{code:'ABCDEFGH'}))).status).toBe(409);
  });
  it('authenticated HTTP stop ends both sockets and clears hashes', async () => {
    const {ctx,session,a,b}=await pair(); const wa=freshSocket(ctx),wb=freshSocket(ctx);
    await authenticate(session,wa,a); await authenticate(session,wb,b);
    const response=await session.fetch(internal('/end',{reason:'stopped'},{Authorization:'Bearer '+a.token}));
    expect(response.status).toBe(204); expect(wa.readyState).toBe(3); expect(wb.readyState).toBe(3);
    expect(wb.sent.some(m=>m.type==='ended'&&m.reason==='stopped')).toBe(true);
    const stored=ctx.backing.get('session') as {participants:unknown[];code:string};
    expect(stored.participants).toEqual([]); expect(stored.code).toBe('');
  });
  it('removes invitation directory metadata on expiry and uses a new opaque ID on reuse', async () => {
    const ctx=context(); const {env}=environment(); const session=new Session(ctx as unknown as DurableObjectState,env); await ctx.ready;
    expect((await session.fetch(internal('/reserve',{id:'old-id',until:Date.now()+1000}))).status).toBe(201);
    expect((await session.fetch(internal('/reserve',{id:'other',until:Date.now()+1000}))).status).toBe(409);
    vi.setSystemTime(Date.now()+1001); await session.alarm(); expect(ctx.backing.has('directory')).toBe(false);
    expect((await session.fetch(internal('/lookup'))).status).toBe(410);
    expect((await session.fetch(internal('/reserve',{id:'new-id',until:Date.now()+1000}))).status).toBe(201);
    expect(await (await session.fetch(internal('/lookup'))).json()).toEqual({id:'new-id'});
  });
});
