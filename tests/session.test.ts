import { describe, expect, it } from 'vitest';
import { createSession, endSession, expireSession, giveConsent, joinSession, requireSharing, snapshot, validateFix } from '../worker/session-state';

const person = (id: string) => ({ id, tokenHash: 'hash-' + id, consent: false });
const seed = () => createSession('opaque-id', 'ABCDEFGH', 1_000, 600_000, 3_600_000, person('a'));
describe('temporary two-person session', () => {
  it('caps atomic sequential joins at two independent participants', () => {
    const s = seed(); joinSession(s, person('b'), 2_000);
    expect(() => joinSession(s, person('c'), 2_000)).toThrow('two people');
    expect(s.participants.map(p => p.tokenHash)).toEqual(['hash-a','hash-b']);
  });
  it('rejects duplicate identity or secret', () => {
    const s = seed(); expect(() => joinSession(s, person('a'), 2_000)).toThrow('Try joining again');
    expect(() => joinSession(s, { ...person('b'), tokenHash: 'hash-a' }, 2_000)).toThrow();
  });
  it('requires both explicit consents and extends time only on mutual consent', () => {
    const s = seed(); joinSession(s, person('b'), 2_000);
    expect(() => requireSharing(s, 3_000)).toThrow('Both people');
    giveConsent(s, 'a', 3_000); expect(s.expiresAt).toBe(601_000);
    expect(() => requireSharing(s, 4_000)).toThrow();
    giveConsent(s, 'b', 5_000); expect(s.expiresAt).toBe(3_605_000);
    giveConsent(s, 'b', 6_000); expect(s.expiresAt).toBe(3_605_000);
    expect(() => requireSharing(s, 6_000)).not.toThrow();
  });
  it('checks expiry from hydrated durable metadata without resetting it', () => {
    const s = JSON.parse(JSON.stringify(seed())); expect(expireSession(s, 601_000)).toBe(true);
    expect(s.participants).toEqual([]); expect(s.code).toBe('');
    expect(() => joinSession(s, person('b'), 602_000)).toThrow('ended');
  });
  it('stop/found are terminal and erase credentials', () => {
    for (const reason of ['stopped','found'] as const) {
      const s = seed(); endSession(s, reason);
      expect(s.endReason).toBe(reason); expect(s.participants).toEqual([]);
      expect(() => giveConsent(s, 'a', 2_000)).toThrow('ended');
    }
  });
  it('snapshots do not confuse durable consent with an active connection', () => {
    const s = seed(); joinSession(s, person('b'), 2_000); giveConsent(s,'a',3_000); giveConsent(s,'b',3_000);
    expect(snapshot(s,'a',new Set(['a'])).peerConnected).toBe(false);
    expect(snapshot(s,'a',new Set(['a','b'])).peerConnected).toBe(true);
  });
});
describe('location envelope', () => {
  const now = 1_000_000;
  const fix = { latitude: 31.2, longitude: 121.5, accuracy: 8, timestamp: now };
  it('accepts only finite in-range fresh fixes with bounded accuracy', () => {
    expect(validateFix(fix, now)).toEqual(fix);
    for (const bad of [{...fix,latitude:91},{...fix,longitude:Infinity},{...fix,accuracy:-1},{...fix,timestamp:now-15_001},{...fix,timestamp:now+5_001},{...fix,heading:45},{...fix,accuracy:100_001}])
      expect(() => validateFix(bad,now)).toThrow();
  });
  it('rejects replay and more than one fix per second across reconnect metadata', () => {
    expect(() => validateFix(fix,now,now,now-1001)).toThrow('out of order');
    expect(() => validateFix(fix,now,now-1001,now-999)).toThrow('one location');
    expect(validateFix(fix,now,now-1001,now-1000)).toEqual(fix);
  });
});
