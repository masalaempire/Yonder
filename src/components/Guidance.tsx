import React, { useEffect, useRef, useState } from "react";
import type { LocationFix } from "../shared/protocol";
import type { HeadingFix } from "../sensors/types";
import {
  bearingDegrees,
  distanceMeters,
  relativeBearing,
  shortestAngleDelta,
  isFresh,
  updateProximity,
} from "../lib/navigation";
export function guidanceQuality(
  local: LocationFix | null,
  peer: LocationFix | null,
  heading: HeadingFix | null,
  now: number,
  connected: boolean,
  visible: boolean,
) {
  const fresh =
    connected && visible && isFresh(local, now) && isFresh(peer, now);
  const distance = fresh && local && peer ? distanceMeters(local, peer) : NaN;
  const accurate =
    !!local && !!peer && local.accuracy <= 30 && peer.accuracy <= 30;
  const compass = isFresh(heading, now, 5000) && heading?.reference === "true";
  const bearing = local && peer ? bearingDegrees(local, peer) : NaN;
  return {
    distance,
    fresh,
    accurate,
    compass,
    bearing,
    arrow:
      fresh &&
      accurate &&
      compass &&
      Number.isFinite(bearing) &&
      distance > local!.accuracy + peer!.accuracy,
  };
}
export function Guidance({
  local,
  peer,
  heading,
  connected,
  visible,
  message,
}: {
  local: LocationFix | null;
  peer: LocationFix | null;
  heading: HeadingFix | null;
  connected: boolean;
  visible: boolean;
  message?: string;
}) {
  const [now, setNow] = useState(Date.now());
  const [nearby, setNearby] = useState({
    nearby: false,
    candidateSince: null as number | null,
  });
  const rotation = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const quality = guidanceQuality(
    local,
    peer,
    heading,
    now,
    connected,
    visible,
  );
  useEffect(() => {
    setNearby((previous) =>
      updateProximity(
        previous,
        quality.distance,
        local?.accuracy ?? Infinity,
        peer?.accuracy ?? Infinity,
        now,
        quality.fresh && quality.accurate,
      ),
    );
  }, [
    quality.distance,
    quality.fresh,
    quality.accurate,
    local?.accuracy,
    peer?.accuracy,
    now,
  ]);
  if (quality.arrow && heading) {
    const target = relativeBearing(quality.bearing, heading.degrees);
    rotation.current += shortestAngleDelta(rotation.current, target);
  }
  const showNearby = nearby.nearby && quality.fresh && quality.accurate;
  const showArrow = quality.arrow && !showNearby;
  const age =
    local && peer
      ? Math.max(
          0,
          Math.floor((now - Math.min(local.timestamp, peer.timestamp)) / 1000),
        )
      : 0;
  let status = message || "Waiting for fresh locations";
  if (!visible) status = "Return to Yonder to continue";
  else if (!connected) status = "Connection interrupted";
  else if (quality.fresh && !quality.accurate)
    status = "Location accuracy is low";
  else if (showNearby) status = "You may be nearby";
  else if (quality.fresh && !quality.compass)
    status = "Compass direction unavailable";
  else if (quality.fresh && !quality.arrow)
    status = "Too close for a reliable direction";
  else if (showArrow) status = "Head this way";
  const distance = Number.isFinite(quality.distance)
    ? quality.distance < 1000
      ? Math.max(5, Math.round(quality.distance / 5) * 5) + " m"
      : (Math.round(quality.distance / 100) / 10).toFixed(1) + " km"
    : "—";
  return (
    <section className="guidance" aria-label="Direction to your friend">
      <div
        className={"direction-disc " + (showArrow ? "available" : "")}
        aria-hidden="true"
      >
        <span className="axis axis-h" />
        <span className="axis axis-v" />
        {showArrow ? (
          <svg
            className="direction-arrow"
            viewBox="0 0 180 210"
            style={{ transform: "rotate(" + rotation.current + "deg)" }}
          >
            <path d="M90 8C95 8 98 12 101 18L170 158C175 169 168 178 158 174L108 153V198C108 204 103 208 97 208H83C77 208 72 204 72 198V153L22 174C12 178 5 169 10 158L79 18C82 12 85 8 90 8Z" />
          </svg>
        ) : (
          <span className={"location-dot " + (showNearby ? "nearby" : "")} />
        )}
      </div>
      <p className="eyebrow">STRAIGHT-LINE DISTANCE</p>
      <div className="distance">
        {quality.fresh ? (
          <>
            <span className="approx">~</span>
            {distance}
          </>
        ) : (
          "—"
        )}
      </div>
      <h2 className="direction-status" aria-live="polite">
        {status}
      </h2>
      <p className="quality">
        {quality.fresh && local && peer
          ? "Accuracy about ±" +
            Math.round(local.accuracy + peer.accuracy) +
            " m · updated " +
            (age === 0 ? "just now" : age + "s ago")
          : "Direction appears only with fresh, accurate readings."}
      </p>
    </section>
  );
}
