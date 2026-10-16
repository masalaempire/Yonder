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
  const quality = guidanceQuality(local, peer, heading, now, connected, visible);
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
  let relative = 0;
  if (quality.arrow && heading) {
    relative = relativeBearing(quality.bearing, heading.degrees);
    rotation.current += shortestAngleDelta(rotation.current, relative);
  }
  const showNearby =
    nearby.nearby && quality.fresh && quality.accurate &&
    !!local && !!peer && local.accuracy <= 20 && peer.accuracy <= 20 &&
    local.accuracy + peer.accuracy <= 24 && quality.distance < 20;
  const showArrow = quality.arrow && !showNearby;
  const phase = showNearby ? "nearby" : showArrow ? "direction" : "weak";
  let status = message || "Weak signal";
  if (!visible) status = "Return to continue";
  else if (!connected) status = "Connection interrupted";
  else if (quality.fresh && !quality.accurate) status = "Weak signal";
  else if (showNearby) status = "nearby";
  else if (quality.fresh && !quality.compass) status = "Compass unavailable";
  else if (quality.fresh && !quality.arrow) status = "Weak signal";
  else if (showArrow) {
    status = Math.abs(relative) <= 20 ? "ahead"
      : Math.abs(relative) >= 160 ? "behind you"
      : relative > 0 ? "to your right" : "to your left";
  }
  const distance = Number.isFinite(quality.distance)
    ? quality.distance < 1000
      ? Math.max(5, Math.round(quality.distance / 5) * 5) + " m"
      : (Math.round(quality.distance / 100) / 10).toFixed(1) + " km"
    : "—";
  const age = local && peer
    ? Math.max(0, Math.floor((now - Math.min(local.timestamp, peer.timestamp)) / 1000))
    : 0;
  return (
    <section
      className={"guidance " + (quality.fresh ? "" : "awaiting-locations")}
      data-phase={phase}
      aria-label="Direction to your friend"
    >
      <div className="finding-visual" aria-hidden="true">
        {showArrow ? (
          <div className="direction-vector" style={{ transform: "rotate(" + rotation.current + "deg)" }}>
            <span className="target-dot" />
            <svg className="direction-arrow" viewBox="0 0 260 320">
              <path d="M130 282V94M48 176L130 94L212 176" />
            </svg>
          </div>
        ) : showNearby ? (
          <span className="location-dot nearby" />
        ) : (
          <div className="signal-field">
            <span className="signal-ring" />
            <span className="signal-orbit" />
          </div>
        )}
      </div>
      <div className="finding-readout">
        {showNearby ? (
          <p className="nearby-estimate">Approximate location</p>
        ) : (
          <div className="distance" aria-label={quality.fresh ? "Approximately " + distance : "Distance unavailable"}>
            {quality.fresh ? <><span className="approx" aria-hidden="true">~</span><span>{distance}</span></> : "—"}
          </div>
        )}
        <h2 className="direction-status" aria-live="polite">{status}</h2>
        <p className="quality visually-hidden">
          {quality.fresh && local && peer
            ? "Accuracy about ±" + Math.round(local.accuracy + peer.accuracy) +
              " m · updated " + (age === 0 ? "just now" : age + "s ago") +
              ". Straight-line estimate, not a walking route."
            : "Direction needs fresh, accurate locations and a true-north compass."}
        </p>
      </div>
    </section>
  );
}
