import { model } from 'geomagnetism';
import { isFresh, normalizeDegrees, shortestAngleDelta } from '../lib/navigation';
import type { HeadingFix, LocationFix } from './types';

const RAD = Math.PI / 180;
export const COMPASS_MAX_AGE = 5_000;
export const MAX_COMPASS_ACCURACY = 35;

export interface OrientationReading {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

export type CompassResult = { fix: HeadingFix; error: null } | { fix: null; error: string };

/** Z-X'-Y'' body-to-Earth matrix applied to the current SCREEN TOP vector. */
export function projectedScreenHeading(alpha: number, beta: number, gamma: number, screenAngle = 0): number | null {
  if (![alpha, beta, gamma, screenAngle].every(Number.isFinite) ||
      alpha < 0 || alpha > 360 || beta < -180 || beta > 180 || gamma < -90 || gamma > 90) return null;
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD, s = screenAngle * RAD;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  const topX = Math.sin(s), topY = Math.cos(s);
  const east = (ca * cg - sa * sb * sg) * topX - cb * sa * topY;
  const north = (cg * sa + ca * sb * sg) * topX + ca * cb * topY;
  // Below ~15 degrees from vertical, azimuth is unstable and misleading.
  if (Math.hypot(east, north) < 0.25) return null;
  return normalizeDegrees(Math.atan2(east, north) / RAD);
}

/** Entirely local WMM2025; no coordinates leave the browser. */
export function declinationDegrees(location: LocationFix, timestamp: number): number | null {
  if (!isFresh(location, timestamp) || !Number.isFinite(location.latitude) || Math.abs(location.latitude) >= 90 ||
      !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) return null;
  try {
    const magneticModel = model(new Date(timestamp), { allowOutOfBoundsModel: false });
    if (magneticModel.epoch !== 2025) return null;
    const field = magneticModel.point([location.latitude, location.longitude]);
    // WMM caution/blackout zones: magnetic north is unreliable at low horizontal intensity.
    if (!Number.isFinite(field.decl) || !Number.isFinite(field.h) || field.h < 6_000) return null;
    return field.decl;
  } catch { return null; }
}

export function magneticToTrue(magneticHeading: number, declination: number): number {
  return Number.isFinite(magneticHeading) && Number.isFinite(declination)
    ? normalizeDegrees(magneticHeading + declination) : NaN;
}

export function orientationToHeading(reading: OrientationReading, screenAngle: number,
  location: LocationFix | null, timestamp: number): CompassResult {
  const fail = (error: string): CompassResult => ({ fix: null, error });
  const accuracy = reading.webkitCompassAccuracy;
  if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_COMPASS_ACCURACY))
    return fail('Compass is unreliable. Move away from metal and magnetic objects, then recalibrate.');
  let magnetic: number | null = null;
  let source: HeadingFix['source'];
  if (reading.webkitCompassHeading !== undefined) {
    if (!Number.isFinite(reading.webkitCompassHeading) || reading.webkitCompassHeading < 0 ||
        reading.webkitCompassHeading > 360 || accuracy === undefined)
      return fail('The compass did not provide a reliable north reference.');
    if (reading.beta === null || reading.gamma === null) return fail('Hold your phone flatter to read the compass.');
    const naturalTop = projectedScreenHeading(0, reading.beta, reading.gamma, 0);
    const screenTop = projectedScreenHeading(0, reading.beta, reading.gamma, screenAngle);
    if (naturalTop === null || screenTop === null) return fail('Hold your phone flatter to read the compass.');
    magnetic = normalizeDegrees(reading.webkitCompassHeading + shortestAngleDelta(naturalTop, screenTop));
    source = 'webkit';
  } else {
    if (!reading.absolute) return fail('This device only supplies relative orientation. A north-referenced compass is required.');
    if (reading.alpha === null || reading.beta === null || reading.gamma === null)
      return fail('The device did not provide a usable absolute compass reading.');
    magnetic = projectedScreenHeading(reading.alpha, reading.beta, reading.gamma, screenAngle);
    source = 'absolute';
  }
  if (magnetic === null) return fail('Hold your phone flatter to read the compass.');
  if (!location) return fail('Enable location to correct magnetic north to true north.');
  const declination = declinationDegrees(location, timestamp);
  if (declination === null) return fail('True north is unavailable here or the location is stale. Refresh location.');
  return { fix: { degrees: magneticToTrue(magnetic, declination), timestamp, reference: 'true', source,
    accuracy: accuracy ?? null }, error: null };
}
