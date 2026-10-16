import type { LocationFix, SessionGrant, SessionSnapshot, EndReason } from '../shared/protocol';
export type Connection = 'idle' | 'connecting' | 'connected' | 'interrupted' | 'ended';
export interface ClientState { grant: SessionGrant | null; session: SessionSnapshot | null; peer: LocationFix | null; connection: Connection; error: string | null; reason: EndReason | null }
const empty = (): ClientState => ({ grant: null, session: null, peer: null, connection: 'idle', error: null, reason: null });
export const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
export function invitationCode(hash: string): string { const raw = new URLSearchParams(hash.replace(/^#/, '')).get('join') ?? ''; const code = normalizeCode(raw); return code.length === 8 ? code : ''; }
export function validFix(value: unknown, now = Date.now()): value is LocationFix {
  if (!value || typeof value !== 'object') return false;
  const f = value as LocationFix;
  return [f.latitude, f.longitude, f.accuracy, f.timestamp].every(Number.isFinite) && Math.abs(f.latitude) <= 90 && Math.abs(f.longitude) <= 180 && f.accuracy >= 0 && f.accuracy <= 100000 && f.timestamp <= now + 2000 && now - f.timestamp <= 15000;
}
function validGrant(v: unknown): v is SessionGrant { if (!v || typeof v !== 'object') return false; const g = v as SessionGrant; return ['sessionId', 'participantId', 'token', 'code'].every(k => typeof g[k as keyof SessionGrant] === 'string') && /^[A-Z0-9]{8}$/.test(g.code) && Number.isFinite(g.expiresAt) && g.expiresAt > Date.now(); }
function validState(v: unknown, id: string): v is SessionSnapshot { if (!v || typeof v !== 'object') return false; const s = v as SessionSnapshot; return s.sessionId === id && /^[A-Z0-9]{8}$/.test(s.code) && ['waiting', 'consent', 'sharing', 'ended'].includes(s.phase) && Number.isFinite(s.expiresAt) && Number.isInteger(s.participants) && s.participants >= 0 && s.participants <= 2 && ['selfConsent', 'peerConsent', 'peerConnected'].every(k => typeof s[k as keyof SessionSnapshot] === 'boolean'); }
const unavailable = 'Live sessions need the Cloudflare connection. Try the demo.';
export class SessionClient {
  private value = empty(); private listeners = new Set<() => void>(); private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null; private handshake: ReturnType<typeof setTimeout> | null = null; private clock: ReturnType<typeof setInterval> | null = null; private abort: AbortController | null = null;
  private generation = 0; private stopped = true; private authenticated = false; private connectedAt = Infinity; private lastSent = -Infinity; private lastFix = -Infinity; private lastPing = 0; private retries = 0;
  constructor(private stopSensors: () => void = () => {}, private request: typeof fetch = (...args) => fetch(...args), private makeSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}
  setSensorStop(stop: () => void) { this.stopSensors = stop; }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<ClientState>) { this.value = { ...this.value, ...next }; this.listeners.forEach(fn => fn()); }
  async start(code?: string) {
    this.stop('stopped', false); this.stopped = false; const generation = this.generation; this.abort = new AbortController(); this.patch({ ...empty(), connection: 'connecting' });
    try {
      const response = await this.request(code ? '/api/sessions/join' : '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: code ? JSON.stringify({ code: normalizeCode(code) }) : '{}', signal: this.abort.signal, cache: 'no-store' });
      if (generation !== this.generation || this.stopped) return;
      if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) throw new Error(unavailable);
      const body: unknown = await response.json();
      if (generation !== this.generation || this.stopped) return;
      if (!response.ok) { const error = body as { error?: { message?: string } }; throw new Error(typeof error.error?.message === 'string' ? error.error.message.slice(0, 180) : unavailable); }
      if (!validGrant(body)) throw new Error(unavailable);
      this.patch({ grant: body }); this.clock = setInterval(() => this.tick(), 500); this.connect(generation);
    } catch (error) { if (generation !== this.generation || this.stopped) return; this.stop('stopped', false); this.patch({ connection: 'idle', error: error instanceof Error && error.message !== 'Failed to fetch' ? error.message : unavailable }); }
  }
  private connect(generation: number) {
    const grant = this.value.grant; if (this.stopped || generation !== this.generation || !grant || Date.now() >= grant.expiresAt) return;
    this.authenticated = false; this.connectedAt = Infinity; this.patch({ connection: this.retries ? 'interrupted' : 'connecting', peer: null });
    const url = new URL('/api/sessions/' + encodeURIComponent(grant.sessionId) + '/socket', window.location.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket; try { socket = this.makeSocket(url.href); this.socket = socket; } catch { this.schedule(generation); return; }
    this.handshake = setTimeout(() => { if (this.current(socket, generation) && !this.authenticated) socket.close(); }, 10000);
    socket.onopen = () => { if (!this.current(socket, generation)) return; socket.send(JSON.stringify({ type: 'authenticate', participantId: grant.participantId, token: grant.token })); };
    socket.onmessage = event => {
      if (!this.current(socket, generation) || typeof event.data !== 'string' || event.data.length > 8192) return;
      let message: Record<string, unknown>; try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'state' && validState(message.state, grant.sessionId)) {
        const state = message.state;
        if (state.phase === 'ended' || state.expiresAt <= Date.now()) { this.stop(state.endReason === 'found' ? 'found' : state.expiresAt <= Date.now() ? 'expired' : 'stopped', false); return; }
        if (!this.authenticated) { this.connectedAt = Date.now(); this.authenticated = true; this.retries = 0; if (this.handshake) clearTimeout(this.handshake); this.handshake = null; }
        this.patch({ connection: 'connected', session: state, grant: { ...grant, expiresAt: state.expiresAt }, peer: state.phase === 'sharing' && state.selfConsent && state.peerConsent && state.peerConnected ? this.value.peer : null, error: null });
      } else if (message.type === 'peer-location' && this.canShare() && validFix(message.fix) && message.fix.timestamp > this.connectedAt && (!this.value.peer || message.fix.timestamp > this.value.peer.timestamp)) this.patch({ peer: message.fix });
      else if (message.type === 'ended' && ['stopped', 'found', 'expired'].includes(String(message.reason))) this.stop(message.reason as EndReason, false);
      else if (message.type === 'error') { this.stop('stopped', false); this.patch({ error: 'This session could not continue. Please start again.' }); }
    };
    socket.onerror = () => { if (this.current(socket, generation)) socket.close(); };
    socket.onclose = () => { if (!this.current(socket, generation)) return; this.socket = null; if (this.handshake) clearTimeout(this.handshake); this.handshake = null; this.authenticated = false; this.connectedAt = Infinity; this.patch({ connection: 'interrupted', peer: null }); this.schedule(generation); };
  }
  private current(socket: WebSocket, generation: number) { return !this.stopped && generation === this.generation && socket === this.socket; }
  private schedule(generation: number) { if (this.stopped || generation !== this.generation) return; this.patch({ connection: 'interrupted', peer: null }); const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5)); this.retry = setTimeout(() => { this.retry = null; this.connect(generation); }, delay); }
  private tick() { if (this.value.grant && Date.now() >= this.value.grant.expiresAt) { this.stop('expired', false); return; } if (this.value.peer && !validFix(this.value.peer)) this.patch({ peer: null }); if (this.authenticated && this.socket?.readyState === 1 && Date.now() - this.lastPing >= 10000) { this.lastPing = Date.now(); this.socket.send(JSON.stringify({ type: 'ping' })); } }
  consent() { if (this.authenticated && this.socket?.readyState === 1 && this.value.session?.participants === 2) this.socket.send(JSON.stringify({ type: 'consent', granted: true })); }
  private canShare() { const s = this.value.session; return !this.stopped && this.authenticated && this.socket?.readyState === 1 && s?.phase === 'sharing' && s.selfConsent && s.peerConsent && s.peerConnected; }
  sendFix(fix: LocationFix | null) { const now = Date.now(); if (!fix || !this.canShare() || !validFix(fix, now) || fix.timestamp <= this.connectedAt || fix.timestamp <= this.lastFix || now - this.lastSent < 1000 || document.visibilityState === 'hidden') return; this.socket!.send(JSON.stringify({ type: 'location', fix })); this.lastSent = now; this.lastFix = fix.timestamp; }
  clearPeer() { this.patch({ peer: null }); }
  stop(reason: EndReason = 'stopped', notify = true) {
    const grant = this.value.grant; const socket = this.socket; this.stopped = true; ++this.generation; this.stopSensors(); this.abort?.abort(); this.abort = null;
    if (this.retry) clearTimeout(this.retry); if (this.handshake) clearTimeout(this.handshake); this.handshake = null; if (this.clock) clearInterval(this.clock); this.retry = null; this.clock = null; this.socket = null; this.authenticated = false; this.connectedAt = Infinity; this.lastSent = -Infinity; this.lastFix = -Infinity; this.retries = 0;
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; try { if (notify && socket.readyState === 1) socket.send(JSON.stringify({ type: 'end', reason: reason === 'found' ? 'found' : 'stopped' })); socket.close(); } catch { /* Local cleanup has already completed. */ } }
    this.patch({ ...empty(), connection: 'ended', reason });
    if (notify && grant) void this.request('/api/sessions/' + encodeURIComponent(grant.sessionId) + '/end', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + grant.token }, body: JSON.stringify({ reason: reason === 'found' ? 'found' : 'stopped' }), keepalive: true, cache: 'no-store' }).catch(() => {});
  }
}
