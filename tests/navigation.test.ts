import { describe, expect, it } from 'vitest';
import { bearingDegrees, distanceMeters, isFresh, normalizeDegrees, relativeBearing,
  shortestAngleDelta, smoothHeading, updateProximity } from '../src/lib/navigation';
import type { LocationFix } from '../src/shared/protocol';

const fix = (latitude: number, longitude: number): LocationFix =>
  ({ latitude, longitude, accuracy: 5, timestamp: 10_000 });

describe('geodesy', () => {
  it('measures cardinal distances and bearings', () => {
    const origin = fix(0, 0);
    expect(distanceMeters(origin, fix(0, 1))).toBeCloseTo(111_195.08, 1);
    expect(bearingDegrees(origin, fix(1, 0))).toBeCloseTo(0);
    expect(bearingDegrees(origin, fix(0, 1))).toBeCloseTo(90);
    expect(bearingDegrees(origin, fix(-1, 0))).toBeCloseTo(180);
    expect(bearingDegrees(origin, fix(0, -1))).toBeCloseTo(270);
  });
  it('takes the short route across the antimeridian', () => {
    expect(distanceMeters(fix(0, 179.9), fix(0, -179.9))).toBeCloseTo(22_239, 0);
    expect(bearingDegrees(fix(0, 179.9), fix(0, -179.9))).toBeCloseTo(90);
  });
  it('does not invent a bearing at coincident or antipodal positions', () => {
    expect(distanceMeters(fix(30, 120), fix(30, 120))).toBe(0);
    expect(bearingDegrees(fix(30, 120), fix(30, 120))).toBeNaN();
    expect(bearingDegrees(fix(0, 0), fix(0, 180))).toBeNaN();
    expect(distanceMeters(fix(91, 0), fix(0, 0))).toBeNaN();
    expect(bearingDegrees(fix(0, NaN), fix(0, 0))).toBeNaN();
  });
});

describe('circular headings', () => {
  it('normalizes and smooths both directions across north', () => {
    expect(normalizeDegrees(-1)).toBe(359);
    expect(normalizeDegrees(Infinity)).toBeNaN();
    expect(shortestAngleDelta(359, 1)).toBe(2);
    expect(shortestAngleDelta(1, 359)).toBe(-2);
    expect(smoothHeading(359, 1, 0.5)).toBe(0);
    expect(smoothHeading(1, 359, 0.5)).toBe(0);
    expect(smoothHeading(100, 200, 2)).toBe(200);
    expect(smoothHeading(100, 200, -1)).toBe(100);
    expect(smoothHeading(100, NaN)).toBeNaN();
    expect(relativeBearing(10, 350)).toBe(20);
    expect(relativeBearing(350, 10)).toBe(-20);
  });
});

describe('freshness', () => {
  it('rejects stale, invalid and unreasonably future timestamps', () => {
    expect(isFresh({ timestamp: 20_000 }, 30_000)).toBe(true);
    expect(isFresh({ timestamp: 10_000 }, 30_000)).toBe(false);
    expect(isFresh({ timestamp: 30_900 }, 30_000)).toBe(true);
    expect(isFresh({ timestamp: 31_001 }, 30_000)).toBe(false);
    expect(isFresh({ timestamp: NaN }, 30_000)).toBe(false);
    expect(isFresh(null, 30_000)).toBe(false);
    expect(isFresh({ timestamp: 30_000 }, 30_000, -1)).toBe(false);
  });
});

describe('conservative nearby heuristic', () => {
  const empty = { nearby: false, candidateSince: null };
  it('enters only after 2.5 seconds and retains hysteresis until 20m', () => {
    const candidate = updateProximity(empty, 10, 10, 10, 1_000);
    expect(candidate).toEqual({ nearby: false, candidateSince: 1_000 });
    expect(updateProximity(candidate, 10, 10, 10, 3_499).nearby).toBe(false);
    const near = updateProximity(candidate, 12, 10, 10, 3_500);
    expect(near.nearby).toBe(true);
    expect(updateProximity(near, 19, 10, 10, 4_000).nearby).toBe(true);
    expect(updateProximity(near, 20, 10, 10, 4_000)).toEqual(empty);
  });
  it('resets stability and exits immediately when quality is lost', () => {
    expect(updateProximity(empty, 1, 20, 20, 1_000)).toEqual(empty);
    expect(updateProximity(empty, 1, 21, 1, 1_000)).toEqual(empty);
    expect(updateProximity(empty, 1, -1, 1, 1_000)).toEqual(empty);
    expect(updateProximity({ nearby: true, candidateSince: null }, 1, 5, 5, 1_000, false)).toEqual(empty);
    expect(updateProximity({ nearby: false, candidateSince: 1_000 }, 13, 5, 5, 2_000)).toEqual(empty);
    expect(updateProximity(empty, NaN, 5, 5, 2_000)).toEqual(empty);
  });
  it('does not reuse a future candidate after clock rollback', () => {
    expect(updateProximity({ nearby: false, candidateSince: 50_000 }, 10, 5, 5, 10_000))
      .toEqual({ nearby: false, candidateSince: 10_000 });
  });
});
