import type { LocationFix } from '../shared/protocol';

const RAD = Math.PI / 180;
const EARTH_RADIUS = 6_371_008.8;

export function normalizeDegrees(n: number): number {
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : NaN;
}

export function shortestAngleDelta(from: number, to: number): number {
  const a = normalizeDegrees(from), b = normalizeDegrees(to);
  return Number.isFinite(a) && Number.isFinite(b) ? ((b - a + 540) % 360) - 180 : NaN;
}

export function smoothHeading(previous: number, next: number, factor = 0.35): number {
  if (!Number.isFinite(next) || !Number.isFinite(factor)) return NaN;
  if (!Number.isFinite(previous)) return normalizeDegrees(next);
  return normalizeDegrees(previous + shortestAngleDelta(previous, next) * Math.max(0, Math.min(1, factor)));
}

function validCoordinates(fix: LocationFix): boolean {
  return Number.isFinite(fix.latitude) && Math.abs(fix.latitude) <= 90 &&
    Number.isFinite(fix.longitude) && Math.abs(fix.longitude) <= 180;
}

export function distanceMeters(from: LocationFix, to: LocationFix): number {
  if (!validCoordinates(from) || !validCoordinates(to)) return NaN;
  const lat1 = from.latitude * RAD, lat2 = to.latitude * RAD;
  const dLat = lat2 - lat1;
  const dLon = shortestAngleDelta(from.longitude, to.longitude) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

/** NaN means no unique direction: coincident, antipodal or invalid coordinates. */
export function bearingDegrees(from: LocationFix, to: LocationFix): number {
  const distance = distanceMeters(from, to);
  if (!Number.isFinite(distance) || distance < 0.01 || Math.abs(Math.PI * EARTH_RADIUS - distance) < 0.01) return NaN;
  const lat1 = from.latitude * RAD, lat2 = to.latitude * RAD;
  const dLon = shortestAngleDelta(from.longitude, to.longitude) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  if (Math.hypot(x, y) < 1e-12) return NaN;
  return normalizeDegrees(Math.atan2(y, x) / RAD);
}

export function relativeBearing(bearing: number, heading: number): number {
  return shortestAngleDelta(heading, bearing);
}

/** Up to one second of clock skew is tolerated, never an arbitrarily future fix. */
export function isFresh(fix: { timestamp: number } | null, now: number, maxAge = 15_000): boolean {
  return !!fix && Number.isFinite(fix.timestamp) && Number.isFinite(now) && Number.isFinite(maxAge) &&
    maxAge >= 0 && fix.timestamp > 0 && fix.timestamp <= now + 1_000 && now - fix.timestamp <= maxAge;
}

export interface ProximityState { nearby: boolean; candidateSince: number | null }

/**
 * Practical GPS heuristic, not proof of physical distance. Entry requires <=12m
 * for 2.5s, both accuracies <=20m and summed uncertainty <=24m. Exit at >=20m
 * or lost quality. The caller must include fix freshness in qualityValid.
 */
export function updateProximity(previous: ProximityState, distance: number, localAccuracy: number,
  peerAccuracy: number, now: number, qualityValid = true): ProximityState {
  const good = qualityValid && [distance, localAccuracy, peerAccuracy, now].every(Number.isFinite) &&
    distance >= 0 && localAccuracy >= 0 && peerAccuracy >= 0 &&
    localAccuracy <= 20 && peerAccuracy <= 20 && localAccuracy + peerAccuracy <= 24 && now > 0;
  if (!good || distance >= 20) return { nearby: false, candidateSince: null };
  if (previous.nearby) return { nearby: true, candidateSince: null };
  if (distance > 12) return { nearby: false, candidateSince: null };
  const since = previous.candidateSince;
  const candidateSince = since !== null && Number.isFinite(since) && since > 0 && since <= now ? since : now;
  return now - candidateSince >= 2_500
    ? { nearby: true, candidateSince: null }
    : { nearby: false, candidateSince };
}
