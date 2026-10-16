import type { LocationFix } from '../shared/protocol';

export type { LocationFix } from '../shared/protocol';
export type SensorStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'unusable' | 'error';

export interface HeadingFix {
  degrees: number;
  timestamp: number;
  reference: 'true';
  source: 'absolute' | 'webkit';
  accuracy: number | null;
}

export interface Sensors {
  location: LocationFix | null;
  heading: HeadingFix | null;
  locationStatus: SensorStatus;
  compassStatus: SensorStatus;
  locationError: string | null;
  compassError: string | null;
  requestLocation: () => void;
  requestCompass: () => Promise<void>;
  stop: () => void;
}
