/** Shared wire types. Credentials and coordinates must never go in URLs. */
export interface LocationFix { latitude: number; longitude: number; accuracy: number; timestamp: number }
export type SessionPhase = 'waiting' | 'consent' | 'sharing' | 'ended';
export type EndReason = 'stopped' | 'found' | 'expired';
export interface SessionGrant { sessionId: string; participantId: string; token: string; code: string; expiresAt: number }
export interface SessionSnapshot {
  sessionId: string; code: string; phase: SessionPhase; expiresAt: number;
  participants: number; selfConsent: boolean; peerConsent: boolean;
  peerConnected: boolean; endReason?: EndReason;
}
export type ClientMessage =
  | { type: 'authenticate'; participantId: string; token: string }
  | { type: 'consent'; granted: true }
  | { type: 'location'; fix: LocationFix }
  | { type: 'end'; reason: 'stopped' | 'found' }
  | { type: 'ping' };
export type ServerMessage =
  | { type: 'state'; state: SessionSnapshot }
  | { type: 'peer-location'; fix: LocationFix }
  | { type: 'ended'; reason: EndReason }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
