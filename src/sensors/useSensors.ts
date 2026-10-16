import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isFresh, smoothHeading } from '../lib/navigation';
import { COMPASS_MAX_AGE, orientationToHeading } from './compass';
import type { OrientationReading } from './compass';
import type { HeadingFix, LocationFix, Sensors, SensorStatus } from './types';

export type { HeadingFix, LocationFix, SensorStatus } from './types';
type Snapshot = Pick<Sensors, 'location' | 'heading' | 'locationStatus' | 'compassStatus' | 'locationError' | 'compassError'>;
const initialSnapshot = (): Snapshot => ({
  location: null, heading: null, locationStatus: 'idle', compassStatus: 'idle',
  locationError: null, compassError: null,
});

type PermissionOrientationConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: (absolute?: boolean) => Promise<'granted' | 'denied'>;
};
type LegacyWindow = Window & { orientation?: number };
const screenAngle = () => window.screen?.orientation?.angle ?? (window as LegacyWindow).orientation ?? 0;

/**
 * Controller is exported for lifecycle tests. It starts no sensors until an
 * explicit request, and every callback is guarded by its request generation.
 */
export function createSensorController() {
  let snapshot = initialSnapshot();
  const subscribers = new Set<() => void>();
  let locationGeneration = 0, compassGeneration = 0;
  let watchId: number | null = null;
  let locationTimer: ReturnType<typeof setInterval> | null = null;
  let compassTimer: ReturnType<typeof setInterval> | null = null;
  let removeCompassListeners: (() => void) | null = null;
  let locationPermissionCleanups: Array<() => void> = [];
  let compassPermissionCleanups: Array<() => void> = [];
  let lastHeading: HeadingFix | null = null;

  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    subscribers.forEach(listener => listener());
  };
  const clearLocation = () => {
    locationGeneration++;
    if (watchId !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(watchId);
    watchId = null;
    if (locationTimer !== null) clearInterval(locationTimer);
    locationTimer = null;
    locationPermissionCleanups.forEach(remove => remove());
    locationPermissionCleanups = [];
  };
  const clearCompass = () => {
    compassGeneration++;
    removeCompassListeners?.();
    removeCompassListeners = null;
    if (compassTimer !== null) clearInterval(compassTimer);
    compassTimer = null;
    compassPermissionCleanups.forEach(remove => remove());
    compassPermissionCleanups = [];
    lastHeading = null;
  };

  const watchPermission = (name: string, live: () => boolean, revoked: () => void,
    register: (remove: () => void) => void) => {
    if (!navigator.permissions?.query) return;
    // Optional permission descriptors are not implemented by every browser.
    try {
      void navigator.permissions.query({ name: name as PermissionName }).then(permission => {
        if (!live()) return;
        const changed = () => { if (live() && permission.state === 'denied') revoked(); };
        permission.addEventListener('change', changed);
        register(() => permission.removeEventListener('change', changed));
        changed();
      }).catch(() => { /* Browser does not expose this permission descriptor. */ });
    } catch { /* Some browsers throw synchronously for optional descriptors. */ }
  };

  const invalidateHeading = () => {
    lastHeading = null;
    if (snapshot.heading) publish({ heading: null, compassStatus: 'unusable',
      compassError: 'A fresh location is required to calculate true north.' });
  };

  const requestLocation = () => {
    clearLocation();
    invalidateHeading();
    const generation = locationGeneration;
    const live = () => generation === locationGeneration;
    publish({ location: null, locationStatus: 'requesting', locationError: null });
    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.geolocation) {
      publish({ locationStatus: 'unavailable', locationError: 'Location requires HTTPS and a browser with geolocation support.' });
      return;
    }
    const denied = () => {
      if (!live()) return;
      clearLocation();
      publish({ location: null, locationStatus: 'denied', locationError: 'Location permission was denied or revoked. Allow it in browser settings and retry.',
        heading: null, ...(snapshot.compassStatus === 'ready' ? { compassStatus: 'unusable' as SensorStatus, compassError: 'Location is required to calculate true north.' } : {}) });
      lastHeading = null;
    };
    const started = Date.now();
    const received = (position: GeolocationPosition) => {
      if (!live()) return;
      const { latitude, longitude, accuracy } = position.coords;
      const location: LocationFix = { latitude, longitude, accuracy, timestamp: position.timestamp };
      if (![latitude, longitude, accuracy].every(Number.isFinite) || Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180 || accuracy < 0 || !isFresh(location, Date.now())) {
        invalidateHeading();
        publish({ location: null, locationStatus: 'unusable', locationError: 'Location is invalid or stale. Waiting for a fresh GPS measurement.' });
        return;
      }
      publish({ location, locationStatus: 'ready', locationError: null });
    };
    const failed = (error: GeolocationPositionError) => {
      if (!live()) return;
      if (error.code === 1) { denied(); return; }
      invalidateHeading();
      publish({ location: null, locationStatus: error.code === 2 ? 'unavailable' : 'error',
        locationError: error.code === 3 ? 'Location timed out. Move into an open area and retry.' : 'Location is unavailable. Check GPS and retry.' });
    };
    try {
      const id = navigator.geolocation.watchPosition(received, failed,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 });
      // Also safe for test doubles that synchronously call back during watchPosition.
      if (live()) watchId = id;
      else navigator.geolocation.clearWatch(id);
    } catch {
      if (live()) publish({ locationStatus: 'error', locationError: 'The browser could not start location. Check its permissions and retry.' });
    }
    if (!live()) return;
    locationTimer = setInterval(() => {
      if (!live()) return;
      if (snapshot.location && !isFresh(snapshot.location, Date.now())) {
        invalidateHeading();
        publish({ location: null, locationStatus: 'unusable', locationError: 'Location is stale. Waiting for a fresh GPS measurement.' });
      } else if (snapshot.locationStatus === 'requesting' && Date.now() - started > 13_000) {
        publish({ location: null, locationStatus: 'error', locationError: 'Location timed out. Move into an open area and retry.' });
      }
    }, 500);
    watchPermission('geolocation', live, denied, remove => locationPermissionCleanups.push(remove));
  };

  const requestCompass = async (): Promise<void> => {
    clearCompass();
    const generation = compassGeneration;
    const live = () => generation === compassGeneration;
    publish({ heading: null, compassStatus: 'requesting', compassError: null });
    if (typeof window === 'undefined' || !window.isSecureContext || typeof DeviceOrientationEvent === 'undefined') {
      publish({ compassStatus: 'unavailable', compassError: 'Compass requires HTTPS and a supported phone browser.' });
      return;
    }
    const ctor = DeviceOrientationEvent as PermissionOrientationConstructor;
    let permission: Promise<'granted' | 'denied'> | undefined;
    try {
      // Deliberately invoked BEFORE ANY await, inside the original button call.
      permission = ctor.requestPermission?.(true);
    } catch {
      if (live()) publish({ compassStatus: 'denied', compassError: 'Compass permission requires a direct button tap. Retry and allow access.' });
      return;
    }
    const denied = () => {
      if (!live()) return;
      clearCompass();
      publish({ heading: null, compassStatus: 'denied', compassError: 'Compass permission was denied or revoked. Allow motion and orientation access, then retry.' });
    };
    if (permission) {
      try {
        const result = await permission;
        if (!live()) return;
        if (result !== 'granted') { denied(); return; }
      } catch {
        if (live()) denied();
        return;
      }
    }
    if (!live()) return;
    const started = Date.now();
    let sawEvent = false;
    const received = (event: DeviceOrientationEvent) => {
      if (!live()) return;
      sawEvent = true;
      const reading = event as DeviceOrientationEvent & OrientationReading;
      // Browsers can dispatch both streams. Relative data never overwrites an
      // absolute fix; the freshness timer still expires a stopped absolute stream.
      if (!reading.absolute && reading.webkitCompassHeading === undefined &&
          lastHeading?.source === 'absolute') return;
      const now = Date.now();
      const eventTime = Number.isFinite(event.timeStamp) && event.timeStamp > 0
        ? (event.timeStamp > 1e12 ? event.timeStamp : performance.timeOrigin + event.timeStamp) : now;
      if (!isFresh({ timestamp: eventTime }, now, COMPASS_MAX_AGE)) {
        lastHeading = null;
        publish({ heading: null, compassStatus: 'unusable', compassError: 'Compass reading is stale. Waiting for a fresh measurement.' });
        return;
      }
      const result = orientationToHeading(reading, screenAngle(), snapshot.location, eventTime);
      if (!result.fix) {
        lastHeading = null;
        publish({ heading: null, compassStatus: 'unusable', compassError: result.error });
        return;
      }
      const previous = lastHeading;
      const dt = previous ? Math.max(16, now - previous.timestamp) : 100;
      // ~0.35 at 100ms, comparable response across event rates; no wrap jumps.
      const factor = 1 - Math.pow(1 - 0.35, Math.min(dt, 1_000) / 100);
      lastHeading = { ...result.fix, degrees: previous && isFresh(previous, now, COMPASS_MAX_AGE)
        ? smoothHeading(previous.degrees, result.fix.degrees, factor) : result.fix.degrees };
      publish({ heading: lastHeading, compassStatus: 'ready', compassError: null });
    };
    const rotationChanged = () => {
      if (!live()) return;
      lastHeading = null;
      publish({ heading: null, compassStatus: 'requesting', compassError: 'Screen rotated. Waiting for a fresh compass measurement.' });
    };
    window.addEventListener('deviceorientation', received);
    window.addEventListener('deviceorientationabsolute', received);
    window.addEventListener('orientationchange', rotationChanged);
    window.screen?.orientation?.addEventListener('change', rotationChanged);
    removeCompassListeners = () => {
      window.removeEventListener('deviceorientation', received);
      window.removeEventListener('deviceorientationabsolute', received);
      window.removeEventListener('orientationchange', rotationChanged);
      window.screen?.orientation?.removeEventListener('change', rotationChanged);
    };
    compassTimer = setInterval(() => {
      if (!live()) return;
      const now = Date.now();
      if (snapshot.heading && (!isFresh(snapshot.heading, now, COMPASS_MAX_AGE) || !isFresh(snapshot.location, now))) {
        lastHeading = null;
        publish({ heading: null, compassStatus: 'unusable', compassError: 'Compass or location is stale. Move the phone gently or refresh location.' });
      } else if (snapshot.compassStatus === 'requesting' && now - started > 8_000) {
        publish({ heading: null, compassStatus: sawEvent ? 'unusable' : 'unavailable',
          compassError: sawEvent ? 'No usable north-referenced compass readings are available.' : 'No compass readings arrived. Check motion permissions and retry.' });
      }
    }, 500);
    for (const name of ['accelerometer', 'gyroscope', 'magnetometer']) {
      watchPermission(name, live, denied, remove => compassPermissionCleanups.push(remove));
    }
  };

  const stop = () => {
    clearLocation();
    clearCompass();
    publish(initialSnapshot());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    requestLocation, requestCompass, stop,
  };
}

export function useSensors(): Sensors {
  const controllerRef = useRef<ReturnType<typeof createSensorController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createSensorController();
  const controller = controllerRef.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.stop(), [controller]);
  return { ...state, requestLocation: controller.requestLocation, requestCompass: controller.requestCompass, stop: controller.stop };
}
