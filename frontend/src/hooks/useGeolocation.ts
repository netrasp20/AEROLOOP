/* Operator location.
 *
 * Uses the REAL browser/device geolocation API (navigator.geolocation.watchPosition).
 * The operator marker comes from the device GPS, NEVER from vehicle telemetry.
 *
 * Development fallback: when the browser denies geolocation or the API is
 * unavailable (non-secure context, headless), we fall back to a FIXED test
 * coordinate and mark it clearly as `isFallback` so the UI can label it
 * "Operator (fixed test location)" instead of pretending it is live GPS.
 */

import { useEffect, useState } from "react";

export interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number | null;
  error: string | null;
  loading: boolean;
  isFallback: boolean;
}

// Development/testing coordinate — used ONLY when browser GPS is unavailable.
const FIXED_LAT = 13.012316617087086;
const FIXED_LON = 77.70400019333756;

const INITIAL: GeolocationState = {
  latitude: null,
  longitude: null,
  altitude: null,
  accuracy: null,
  heading: null,
  speed: null,
  timestamp: null,
  error: null,
  loading: true,
  isFallback: false,
};

export function useGeolocation(): GeolocationState {
  const [state, setState] = useState<GeolocationState>(INITIAL);

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setState({
        ...INITIAL,
        loading: false,
        isFallback: true,
        latitude: FIXED_LAT,
        longitude: FIXED_LON,
        accuracy: null,
        error: "Geolocation API is not available in this browser.",
      });
      return;
    }

    let watchId: number | null = null;
    let cancelled = false;

    const onPos = (pos: GeolocationPosition) => {
      if (cancelled) return;
      setState({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        altitude: pos.coords.altitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        timestamp: pos.timestamp,
        error: null,
        loading: false,
        isFallback: false,
      });
    };

    const onErr = (err: GeolocationPositionError) => {
      if (cancelled) return;
      // Fall back to the fixed test position so the map still shows an operator
      // marker during development — explicitly labelled as a fallback.
      setState({
        ...INITIAL,
        loading: false,
        isFallback: true,
        latitude: FIXED_LAT,
        longitude: FIXED_LON,
        accuracy: null,
        error: `Geolocation unavailable (${err.code}): ${err.message}`,
      });
    };

    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000,
    });

    return () => {
      cancelled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  return state;
}