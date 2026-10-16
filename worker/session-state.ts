import type { EndReason, LocationFix, SessionSnapshot } from '../src/shared/protocol';

export class SessionFault extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export interface Participant { id: string; tokenHash: string; consent: boolean; connectionId?: string; lastFixTimestamp?: number; lastFixAt?: number }
export interface SessionData {
  sessionId: string; code: string; expiresAt: number; sharingMs: number;
  phase: 'waiting' | 'consent' | 'sharing' | 'ended';
  participants: Participant[]; socketAttempts?: number; endReason?: EndReason;
}
export function createSession(sessionId: string, code: string, now: number, inviteMs: number, sharingMs: number, person: Participant): SessionData {
  return { sessionId, code, expiresAt: now + inviteMs, sharingMs, phase: 'waiting', participants: [person] };
}
export function endSession(s: SessionData, reason: EndReason): void {
  s.phase = 'ended'; s.endReason = reason;
  // Keep only a terminal tombstone. Never retain credentials after ending.
  s.participants = []; s.code = '';
}
export function expireSession(s: SessionData, now: number): boolean {
  if (s.phase !== 'ended' && now >= s.expiresAt) endSession(s, 'expired');
  return s.phase === 'ended';
}
export function requireActive(s: SessionData, now: number): void {
  if (s.phase === 'ended' || now >= s.expiresAt) throw new SessionFault('session_ended', 'This session has ended.', 410);
}
export function joinSession(s: SessionData, person: Participant, now: number): void {
  requireActive(s, now);
  if (s.participants.length >= 2) throw new SessionFault('session_full', 'This invitation already has two people.', 409);
  if (s.participants.some(p => p.id === person.id || p.tokenHash === person.tokenHash)) throw new SessionFault('credential_collision', 'Try joining again.', 409);
  s.participants.push(person); s.phase = 'consent';
}
export function giveConsent(s: SessionData, participantId: string, now: number): void {
  requireActive(s, now);
  const person = s.participants.find(p => p.id === participantId);
  if (!person) throw new SessionFault('unauthorized', 'Authentication required.', 401);
  person.consent = true;
  if (s.phase !== 'sharing' && s.participants.length === 2 && s.participants.every(p => p.consent)) {
    s.phase = 'sharing'; s.expiresAt = now + s.sharingMs;
  }
}
export function snapshot(s: SessionData, self: string, connected: Set<string>): SessionSnapshot {
  return { sessionId: s.sessionId, code: s.code, phase: s.phase, expiresAt: s.expiresAt,
    participants: s.participants.length, selfConsent: s.participants.find(p => p.id === self)?.consent ?? false,
    peerConsent: s.participants.find(p => p.id !== self)?.consent ?? false,
    peerConnected: s.participants.some(p => p.id !== self && connected.has(p.id)), ...(s.endReason ? { endReason: s.endReason } : {}) };
}
export function validateFix(value: unknown, now: number, previousTimestamp = -Infinity, lastReceivedAt = -Infinity): LocationFix {
  if (!value || typeof value !== 'object') throw new SessionFault('invalid_fix', 'Invalid location.');
  const f = value as Record<string, unknown>;
  if (Object.keys(f).sort().join(',') !== 'accuracy,latitude,longitude,timestamp' ||
    !['latitude','longitude','accuracy','timestamp'].every(k => typeof f[k] === 'number' && Number.isFinite(f[k])) ||
    (f.latitude as number) < -90 || (f.latitude as number) > 90 ||
    (f.longitude as number) < -180 || (f.longitude as number) > 180 ||
    (f.accuracy as number) < 0 || (f.accuracy as number) > 100_000 ||
    (f.timestamp as number) < now - 15_000 || (f.timestamp as number) > now + 5_000 ||
    (f.timestamp as number) <= previousTimestamp) throw new SessionFault('invalid_fix', 'Location is invalid, stale, or out of order.');
  if (now - lastReceivedAt < 1000) throw new SessionFault('rate_limited', 'Send at most one location per second.', 429);
  return f as unknown as LocationFix;
}
export function requireSharing(s: SessionData, now: number): void {
  requireActive(s, now);
  if (s.phase !== 'sharing' || s.participants.length !== 2 || !s.participants.every(p => p.consent))
    throw new SessionFault('consent_required', 'Both people must agree before sharing.', 403);
}
