import React, { useEffect, useState } from "react";
import { Guidance } from "./Guidance";
export default function Demo({ onExit }: { onExit: () => void }) {
  const [heading, setHeading] = useState(20);
  const [distance, setDistance] = useState(85);
  const [poor, setPoor] = useState(false);
  const [lost, setLost] = useState(false);
  const [stale, setStale] = useState(false);
  const [ended, setEnded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const timestamp = stale ? now - 20000 : now;
  const local = {
    latitude: 0,
    longitude: 0,
    accuracy: poor ? 65 : 5,
    timestamp,
  };
  const peer = {
    latitude: distance / 111195,
    longitude: 0,
    accuracy: poor ? 70 : 5,
    timestamp,
  };
  return (
    <>
      <p className="demo-banner">Demo · simulated</p>
      {ended ? (
        <section className="ending">
          <span className="end-mark">↗</span>
          <h1>A little closer.</h1>
          <p>The simulated session has ended.</p>
          <button className="primary" onClick={onExit}>
            Back to Yonder
          </button>
        </section>
      ) : (
        <div className="demo-session is-finding">
          <div className="session-top">
            <span className="live-badge">SIMULATED PAIR</span>
            <span>Both people consented</span>
          </div>
          <Guidance
            local={local}
            peer={peer}
            heading={{
              degrees: heading,
              timestamp: now,
              reference: "true",
              source: "absolute",
              accuracy: 5,
            }}
            connected={!lost}
            visible={true}
          />
          <details className="demo-controls" open>
            <summary>Try the controls</summary>
            <label>
              Turn your phone <output>{heading}°</output>
              <input
                type="range"
                min="0"
                max="359"
                value={heading}
                onChange={(e) => setHeading(Number(e.target.value))}
              />
            </label>
            <label>
              Move closer / away <output>{distance} m</output>
              <input
                type="range"
                min="5"
                max="200"
                value={distance}
                onChange={(e) => setDistance(Number(e.target.value))}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={poor}
                onChange={(e) => setPoor(e.target.checked)}
              />
              Poor accuracy
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={lost}
                onChange={(e) => setLost(e.target.checked)}
              />
              Connection lost
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={stale}
                onChange={(e) => setStale(e.target.checked)}
              />
              Stale location
            </label>
            <p>
              No sensors, location permissions, invitations, or network are
              used.
            </p>
          </details>
          <footer className="session-footer">
            <button className="primary" onClick={() => setEnded(true)}>
              We found each other
            </button>
            <button className="text-button" onClick={() => setEnded(true)}>
              Stop sharing
            </button>
          </footer>
        </div>
      )}
    </>
  );
}
