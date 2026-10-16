import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declinationDegrees, magneticToTrue, orientationToHeading, projectedScreenHeading } from '../src/sensors/compass';
import { createSensorController } from '../src/sensors/useSensors';
import type { OrientationReading } from '../src/sensors/compass';

const magnetic = vi.hoisted(() => ({ decl: 10, h: 30_000, epoch: 2025, fails: false, calls: 0 }));
vi.mock('geomagnetism', () => ({
  model: () => {
    magnetic.calls++;
    if (magnetic.fails) throw new Error('model unavailable');
    return { epoch: magnetic.epoch, start_date: new Date('2025-01-01'), end_date: new Date('2030-01-01'),
      point: () => ({ decl: magnetic.decl, h: magnetic.h }) };
  },
}));
const NOW = Date.parse('2026-10-16T00:00:00Z');
const location = () => ({ latitude: 31, longitude: 121, accuracy: 5, timestamp: Date.now() });
const absolute: OrientationReading = { alpha: 0, beta: 0, gamma: 0, absolute: true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(magnetic, { decl: 10, h: 30_000, epoch: 2025, fails: false, calls: 0 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('north reference and screen projection', () => {
  it('projects flat cardinal directions and both landscape rotations', () => {
    expect(projectedScreenHeading(0, 0, 0)).toBeCloseTo(0);
    expect(projectedScreenHeading(90, 0, 0)).toBeCloseTo(270);
    expect(projectedScreenHeading(0, 0, 0, 90)).toBeCloseTo(90);
    expect(projectedScreenHeading(0, 0, 0, 270)).toBeCloseTo(270);
    expect(projectedScreenHeading(45, 35, 20)).toBeCloseTo(315);
    // With roll and landscape rotation, adding an angle alone is incorrect.
    expect(projectedScreenHeading(0, 45, 45, 90)).toBeCloseTo(54.7356, 3);
  });
  it('hides degenerate screen-top projections and invalid input', () => {
    expect(projectedScreenHeading(0, 90, 0)).toBeNull();
    expect(projectedScreenHeading(0, 0, 90, 90)).toBeNull();
    expect(projectedScreenHeading(NaN, 0, 0)).toBeNull();
    expect(projectedScreenHeading(0, 181, 0)).toBeNull();
  });
  it('rejects relative alpha and converts magnetic to true north', () => {
    expect(orientationToHeading({ ...absolute, absolute: false }, 0, location(), NOW).fix).toBeNull();
    expect(orientationToHeading(absolute, 0, location(), NOW).fix)
      .toMatchObject({ degrees: 10, reference: 'true', source: 'absolute', accuracy: null });
    expect(magneticToTrue(355, 10)).toBe(5);
    expect(magneticToTrue(5, -10)).toBe(355);
    expect(magneticToTrue(NaN, 10)).toBeNaN();
  });
  it('accepts reliable WebKit north with screen rotation, but rejects unreliable magnetic data', () => {
    const webkit = { ...absolute, absolute: false, webkitCompassHeading: 350, webkitCompassAccuracy: 8 };
    expect(orientationToHeading(webkit, 90, location(), NOW).fix).toMatchObject({ degrees: 90, source: 'webkit', accuracy: 8 });
    for (const accuracy of [-1, 36, NaN]) {
      expect(orientationToHeading({ ...webkit, webkitCompassAccuracy: accuracy }, 0, location(), NOW).fix).toBeNull();
    }
    expect(orientationToHeading({ ...absolute, webkitCompassHeading: 10 }, 0, location(), NOW).fix).toBeNull();
    expect(orientationToHeading({ ...webkit, beta: 90 }, 0, location(), NOW).fix).toBeNull();
  });
  it('refuses missing/stale coordinates, model failure, non-2025 models and magnetic caution zones', () => {
    expect(orientationToHeading(absolute, 0, null, NOW).fix).toBeNull();
    expect(declinationDegrees({ ...location(), timestamp: NOW - 20_000 }, NOW)).toBeNull();
    expect(declinationDegrees({ ...location(), latitude: 90 }, NOW)).toBeNull();
    magnetic.h = 5_999;
    expect(declinationDegrees(location(), NOW)).toBeNull();
    magnetic.h = 30_000; magnetic.epoch = 2020;
    expect(declinationDegrees(location(), NOW)).toBeNull();
    magnetic.epoch = 2025; magnetic.fails = true;
    expect(declinationDegrees(location(), NOW)).toBeNull();
  });
  it('reuses the local field only for the same fresh GPS measurement and UTC day', () => {
    const gps = location();
    expect(declinationDegrees(gps, NOW)).toBe(10);
    expect(declinationDegrees(gps, NOW + 100)).toBe(10);
    expect(magnetic.calls).toBe(1);
    expect(declinationDegrees(gps, NOW + 20_000)).toBeNull();
    expect(magnetic.calls).toBe(1);
    expect(declinationDegrees({ ...gps, longitude: 120 }, NOW)).toBe(10);
    expect(magnetic.calls).toBe(2);
    // Even a caller that mutates a fix cannot reuse the previous coordinates.
    gps.longitude = 122;
    expect(declinationDegrees(gps, NOW)).toBe(10);
    expect(magnetic.calls).toBe(3);
    const midnight = Date.parse('2026-10-16T23:59:59Z');
    const overnight = { ...location(), timestamp: midnight };
    expect(declinationDegrees(overnight, midnight)).toBe(10);
    expect(declinationDegrees(overnight, midnight + 2_000)).toBe(10);
    expect(magnetic.calls).toBe(5);
    const outside = Date.parse('2040-01-01');
    expect(declinationDegrees({ ...location(), timestamp: outside }, outside)).toBeNull();
  });
  it('confirms the installed dependency actually bundles WMM2025 and enforces its time range', async () => {
    const actual = await vi.importActual<typeof import('geomagnetism')>('geomagnetism');
    const model = actual.model(new Date(NOW), { allowOutOfBoundsModel: false });
    expect(model.epoch).toBe(2025);
    expect(Number.isFinite(model.point([31, 121]).decl)).toBe(true);
    expect(() => actual.model(new Date('2040-01-01'), { allowOutOfBoundsModel: false })).toThrow();
  });
});

function browserHarness() {
  const orientation = Object.assign(new EventTarget(), { angle: 0 });
  const windowTarget = Object.assign(new EventTarget(), { isSecureContext: true, screen: { orientation } });
  let success: PositionCallback = () => {};
  let failure: PositionErrorCallback = () => {};
  const watchPosition = vi.fn((onSuccess: PositionCallback, onFailure: PositionErrorCallback) => {
    success = onSuccess; failure = onFailure; return 7;
  });
  const clearWatch = vi.fn();
  const statuses = new Map<string, PermissionStatus>();
  const permissionStatus = (name: string) => {
    let status = statuses.get(name);
    if (!status) {
      status = Object.assign(new EventTarget(), { state: 'granted', name, onchange: null }) as PermissionStatus;
      statuses.set(name, status);
    }
    return status;
  };
  const requestPermission = vi.fn<(...args: unknown[]) => Promise<'granted' | 'denied'>>(() => Promise.resolve('granted'));
  class OrientationEvent extends Event { static requestPermission = requestPermission; }
  vi.stubGlobal('DeviceOrientationEvent', OrientationEvent);
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('navigator', {
    geolocation: { watchPosition, clearWatch },
    permissions: { query: vi.fn(({ name }: { name: string }) => Promise.resolve(permissionStatus(name))) },
  });
  return {
    watchPosition, clearWatch, requestPermission, windowTarget, orientation,
    emitLocation: () => success({ coords: { ...location(), altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now() } as GeolocationPosition),
    lateLocationCallback: () => success,
    emitLocationError: (code: number) => failure({ code, message: 'test error' } as GeolocationPositionError),
    emitOrientation: (reading: OrientationReading = absolute) => {
      const event = new Event('deviceorientation');
      Object.defineProperty(event, 'timeStamp', { value: Date.now() });
      Object.assign(event, reading);
      windowTarget.dispatchEvent(event);
    },
    revoke: (name: string) => {
      const status = permissionStatus(name);
      Object.defineProperty(status, 'state', { value: 'denied', configurable: true });
      status.dispatchEvent(new Event('change'));
    },
  };
}

describe('sensor lifecycle', () => {
  it('starts only explicitly and requests uncached high accuracy GPS', () => {
    const browser = browserHarness();
    const controller = createSensorController();
    expect(browser.watchPosition).not.toHaveBeenCalled();
    controller.requestLocation();
    expect(browser.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 });
    browser.emitLocation();
    expect(controller.getSnapshot()).toMatchObject({ locationStatus: 'ready', location: location() });
    controller.stop();
    expect(browser.clearWatch).toHaveBeenCalledWith(7);
    expect(controller.getSnapshot()).toMatchObject({ location: null, heading: null, locationStatus: 'idle', compassStatus: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps sensor startup working when optional permission queries throw', async () => {
    const browser = browserHarness();
    Object.defineProperty(navigator, 'permissions', { value: { query: () => { throw new TypeError('unsupported'); } } });
    const controller = createSensorController();
    expect(() => controller.requestLocation()).not.toThrow();
    browser.emitLocation();
    await expect(controller.requestCompass()).resolves.toBeUndefined();
    browser.emitOrientation();
    expect(controller.getSnapshot().compassStatus).toBe('ready');
    controller.stop();
  });
  it('calls iOS permission synchronously and discards in-flight permission after Stop', async () => {
    const browser = browserHarness();
    let resolve!: (value: 'granted') => void;
    browser.requestPermission.mockImplementation(() => new Promise(r => { resolve = r; }));
    const controller = createSensorController();
    const pending = controller.requestCompass();
    expect(browser.requestPermission).toHaveBeenCalledWith(true);
    controller.stop();
    resolve('granted');
    await pending;
    browser.emitOrientation();
    expect(controller.getSnapshot().compassStatus).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('invalidates late watch callbacks across stop and explicit retry', () => {
    const browser = browserHarness();
    const controller = createSensorController();
    controller.requestLocation();
    const oldCallback = browser.lateLocationCallback();
    controller.stop();
    controller.requestLocation();
    oldCallback({ coords: { latitude: 1, longitude: 1, accuracy: 1 }, timestamp: NOW } as GeolocationPosition);
    expect(controller.getSnapshot().locationStatus).toBe('requesting');
    browser.emitLocation();
    expect(controller.getSnapshot().location?.latitude).toBe(31);
    controller.stop();
    browser.emitLocation();
    expect(controller.getSnapshot().location).toBeNull();
  });
  it('expires compass health even when stationary and events stop', async () => {
    const browser = browserHarness();
    const controller = createSensorController();
    controller.requestLocation(); browser.emitLocation();
    await controller.requestCompass();
    browser.emitOrientation();
    expect(controller.getSnapshot().compassStatus).toBe('ready');
    browser.emitOrientation({ ...absolute, absolute: false });
    expect(controller.getSnapshot().compassStatus).toBe('ready');
    vi.advanceTimersByTime(5_501);
    expect(controller.getSnapshot()).toMatchObject({ heading: null, compassStatus: 'unusable' });
    controller.stop();
    browser.emitOrientation();
    expect(controller.getSnapshot().heading).toBeNull();
  });
  it('clears guidance on screen rotation and rejects relative-only streams', async () => {
    const browser = browserHarness();
    const controller = createSensorController();
    controller.requestLocation(); browser.emitLocation(); await controller.requestCompass();
    browser.emitOrientation({ ...absolute, absolute: false });
    expect(controller.getSnapshot().compassStatus).toBe('unusable');
    browser.emitOrientation();
    browser.orientation.angle = 90;
    browser.orientation.dispatchEvent(new Event('change'));
    expect(controller.getSnapshot().heading).toBeNull();
    browser.emitOrientation();
    expect(controller.getSnapshot().heading?.degrees).toBeCloseTo(100);
    controller.stop();
  });
  it('handles denial, timeout, no readings and revocation', async () => {
    const browser = browserHarness();
    const controller = createSensorController();
    controller.requestLocation();
    browser.emitLocationError(3);
    expect(controller.getSnapshot().locationStatus).toBe('error');
    browser.emitLocationError(1);
    expect(controller.getSnapshot().locationStatus).toBe('denied');
    browser.requestPermission.mockResolvedValueOnce('denied');
    await controller.requestCompass();
    expect(controller.getSnapshot().compassStatus).toBe('denied');
    await controller.requestCompass();
    vi.advanceTimersByTime(8_501);
    expect(controller.getSnapshot().compassStatus).toBe('unavailable');
    controller.requestLocation(); browser.emitLocation(); await controller.requestCompass();
    browser.emitOrientation();
    // Let optional Permissions API observation settle.
    await Promise.resolve();
    browser.revoke('magnetometer');
    expect(controller.getSnapshot()).toMatchObject({ heading: null, compassStatus: 'denied' });
    browser.revoke('geolocation');
    expect(controller.getSnapshot()).toMatchObject({ location: null, locationStatus: 'denied' });
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
