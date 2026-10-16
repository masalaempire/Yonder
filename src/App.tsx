import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { SessionClient, invitationCode, normalizeCode, validFix } from "./session/client";
import { useSensors } from "./sensors/useSensors";
import { isFresh } from "./lib/navigation";
import { COMPASS_MAX_AGE, MAX_COMPASS_ACCURACY } from "./sensors/compass";
import { Guidance } from "./components/Guidance";
import { FindingFrame } from "./components/FindingFrame";
import Demo from "./components/Demo";

type Sensors = ReturnType<typeof useSensors>;
function locationReady(sensors: Sensors, now: number, after: number) {
  return sensors.locationStatus === "ready" && validFix(sensors.location, now) &&
    isFresh(sensors.location, now) && sensors.location!.timestamp >= after;
}
function compassReady(sensors: Sensors, now: number, after: number) {
  const heading = sensors.heading;
  return sensors.compassStatus === "ready" && !!heading &&
    heading.reference === "true" && Number.isFinite(heading.degrees) &&
    heading.degrees >= 0 && heading.degrees < 360 &&
    (heading.accuracy === null || (Number.isFinite(heading.accuracy) &&
      heading.accuracy >= 0 && heading.accuracy <= MAX_COMPASS_ACCURACY)) &&
    isFresh(heading, now, COMPASS_MAX_AGE) && heading.timestamp >= after;
}
function permissionLabel(status: Sensors["locationStatus"], compass = false) {
  if (status === "idle") return "Not enabled";
  if (status === "requesting") return compass ? "Waiting for compass…" : "Finding location…";
  if (status === "denied") return "Access blocked";
  if (status === "unavailable") return "Not available";
  return "Try again";
}
const compassFailed = (sensors: Sensors) =>
  ["denied", "unavailable", "unusable", "error"].includes(sensors.compassStatus);

function Invite({ code }: { code: string }) {
  const url =
    window.location.origin + window.location.pathname + "#join=" + code;
  const [qr, setQr] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, {
      margin: 1,
      width: 200,
      color: { dark: "#18241c", light: "#ffffff" },
    })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active) setNotice("QR unavailable. Share the code below.");
      });
    return () => {
      active = false;
    };
  }, [url]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Invite link copied.");
    } catch {
      setNotice("Copy unavailable. Select the invite link below.");
    }
  }
  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Find me on Yonder",
          text: "Join my temporary Yonder session.",
          url,
        });
        setNotice("Invite shared.");
      } else await copy();
    } catch (error) {
      setNotice(
        error instanceof DOMException && error.name === "AbortError"
          ? "Sharing cancelled."
          : "Sharing unavailable. Copy the link instead.",
      );
    }
  }
  return (
    <section className="invite">
      <div className="qr">
        {qr ? (
          <img
            src={qr}
            width="164"
            height="164"
            alt={"Scan to join session " + code}
          />
        ) : (
          <span>Preparing QR…</span>
        )}
      </div>
      <p className="eyebrow">YOUR INVITE CODE</p>
      <p className="invite-code">
        {code.slice(0, 4)} {code.slice(4)}
      </p>
      <div className="button-row">
        <button className="secondary" onClick={share}>
          Share invite ↗
        </button>
        <button className="secondary" onClick={copy}>
          Copy link
        </button>
      </div>
      <details><summary>Invite link</summary><label className="link-label">
        Invite link
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
      </label></details>
      <p className="notice" role="status">
        {notice}
      </p>
    </section>
  );
}

function SensorButtons({ sensors }: { sensors: Sensors }) {
  return <section className="sensor-tools" aria-label="Sensor permissions">
    <button className="secondary" onClick={() => sensors.requestLocation()}>
      {sensors.locationStatus === "ready" ? "Refresh location" : "Enable location"}
    </button>
    <button className="secondary" onClick={() => { void sensors.requestCompass(); }}>
      {sensors.compassStatus === "ready" ? "Refresh compass" : "Enable compass"}
    </button>
    <p>Location: {sensors.locationStatus}. Compass: {sensors.compassStatus}.</p>
    {(sensors.locationError || sensors.compassError) &&
      <p role="status">{sensors.locationError || sensors.compassError}</p>}
  </section>;
}

function PermissionSetup({ sensors, joining, foregroundAt, onCancel, onStart }: {
  sensors: Sensors; joining: boolean; foregroundAt: number;
  onCancel: () => void; onStart: (distanceOnly: boolean, compassAttempted: boolean) => void;
}) {
  const [attempted, setAttempted] = useState(false);
  const [distanceOnly, setDistanceOnly] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const location = locationReady(sensors, now, foregroundAt);
  const compass = compassReady(sensors, now, foregroundAt);
  const fallback = attempted && compassFailed(sensors);
  const ready = document.visibilityState !== "hidden" && location &&
    (compass || (distanceOnly && fallback));
  return <section className="permission-setup">
    <button className="back-button" onClick={onCancel}>← Back</button>
    <h1>Before you begin</h1>
    <p className="setup-note">Enable location and compass on this phone. Readings stay here until you both agree to share.</p>
    <div className="permission-row">
      <span>Location</span><span role="status">{location ? "Ready" : sensors.locationStatus === "ready" ? "Needs a fresh reading" : permissionLabel(sensors.locationStatus)}</span>
      <button className="secondary" onClick={() => { setDistanceOnly(false); sensors.requestLocation(); }}>Enable location</button>
    </div>
    <div className="permission-row">
      <span>Compass</span><span role="status">{compass ? "Ready" : sensors.compassStatus === "ready" ? "Needs a fresh reading" : permissionLabel(sensors.compassStatus, true)}</span>
      <button className="secondary" onClick={() => {
        setAttempted(true); setDistanceOnly(false);
        // Keep this call in the original tap, before any await.
        void sensors.requestCompass();
      }}>Enable compass</button>
    </div>
    {(sensors.locationError || sensors.compassError) &&
      <p className="setup-note" role="status">{sensors.locationError || sensors.compassError}</p>}
    {fallback && <div className="setup-actions">
      <p className="setup-note">Without a compass, you can see distance only.</p>
      <button className="secondary" aria-pressed={distanceOnly} disabled={!location}
        onClick={() => setDistanceOnly(true)}>Continue without compass</button>
    </div>}
    {distanceOnly && fallback && <p className="setup-note" role="status">Distance only selected.</p>}
    <div className="setup-actions">
      <button className="primary" disabled={!ready} onClick={() => onStart(distanceOnly, attempted)}>
        {joining ? "Join session" : "Create session"}
      </button>
    </div>
  </section>;
}

function Live({ client, sensors, visible, foregroundAt, onExit }: {
  client: SessionClient; sensors: Sensors; visible: boolean; foregroundAt: number; onExit: () => void;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const sensorsRef = useRef(sensors);
  sensorsRef.current = sensors;
  const previousConsent = useRef({ self: false, peer: false });
  useEffect(() => {
    // Initial preflight readings are local only. Revocation after consent stops them.
    const self = !!state.session?.selfConsent;
    const peer = !!state.session?.peerConsent;
    if ((previousConsent.current.self && !self) || (previousConsent.current.peer && !peer))
      sensorsRef.current.stop();
    previousConsent.current = { self, peer };
  }, [state.session?.selfConsent, state.session?.peerConsent]);
  useEffect(() => {
    if (sensors.locationStatus === "denied" && state.session?.selfConsent) client.stop();
  }, [client, sensors.locationStatus, state.session?.selfConsent]);
  useEffect(() => {
    if (visible && sensors.location && sensors.location.timestamp >= foregroundAt)
      client.sendFix(sensors.location);
  }, [client, sensors.location, state.session, state.connection, visible, foregroundAt]);
  const end = (found = false) => client.stop(found ? "found" : "stopped");
  if (state.connection === "ended" || (state.error && !state.grant))
    return <section className="ending">
      <h1>{state.error ? "Unable to connect" : state.reason === "found" ? "There you are." : "Session ended"}</h1>
      <p>{state.error || (state.reason === "expired" ? "This session expired." : "Location sharing has stopped.")}</p>
      <button className="primary" onClick={onExit}>Back to Yonder</button>
    </section>;
  const session = state.session;
  const sharing = session?.phase === "sharing" && session.selfConsent && session.peerConsent;
  const local = sensors.location && sensors.location.timestamp >= foregroundAt ? sensors.location : null;
  const heading = sensors.heading && sensors.heading.timestamp >= foregroundAt ? sensors.heading : null;
  if (sharing) return <FindingFrame onStop={() => end()} onFound={() => end(true)}
    info={<>
      <SensorButtons sensors={sensors} />
      <p className="setup-note">GPS gives approximate straight-line guidance. Keep Yonder open.</p>
    </>}>
    <Guidance local={local} peer={state.peer} heading={heading}
      connected={state.connection === "connected" && !!session.peerConnected} visible={visible}
      message={sensors.locationStatus === "requesting" ? "Acquiring your location" :
        !local ? "Enable location to continue" : undefined} />
  </FindingFrame>;
  return <div className="live-session">
    <div className="session-top">
      <button className="round-control" aria-label="Stop sharing" onClick={() => end()}>×</button>
    </div>
    {!state.grant ? <section className="intro compact">
      <h1>Making room for two</h1><p>Connecting…</p>
    </section> : !session || session.participants < 2 ? <>
      <section className="intro compact"><h1>Invite your friend</h1><p>Waiting for your friend to join.</p></section>
      <Invite code={state.grant.code} />
    </> : !session.selfConsent ? <section className="intro consent">
      <h1>Ready to share?</h1>
      <p>Share your live location with your friend? Both of you must agree.</p>
      <button className="primary" disabled={state.connection !== "connected"} onClick={() => client.consent()}>Share my location</button>
    </section> : <section className="intro compact">
      <h1>Waiting for your friend</h1><p>Nothing is sent until you both agree.</p>
    </section>}
  </div>;
}

function SensorCheck({ sensors, onExit }: { sensors: Sensors; onExit: () => void }) {
  return <>
    <button className="back-button" onClick={onExit}>← Back</button>
    <section className="intro compact"><h1>Sensor check</h1>
      <p>Readings stay on this phone.</p></section>
    <SensorButtons sensors={sensors} />
    <dl className="diagnostics">
      <dt>Location accuracy</dt><dd>{sensors.location ? "±" + Math.round(sensors.location.accuracy) + " m" : "No reading"}</dd>
      <dt>True-north heading</dt><dd>{sensors.heading ? Math.round(sensors.heading.degrees) + "°" : "No reading"}</dd>
    </dl>
  </>;
}
export default function App() {
  const [screen, setScreen] = useState<"home" | "join" | "setup" | "live" | "demo" | "check">(
    () => invitationCode(window.location.hash) ? "join" : "home");
  const [code, setCode] = useState(() => invitationCode(window.location.hash));
  const [client] = useState(() => new SessionClient());
  // A single controller survives preflight -> Live, with no remount teardown.
  const sensors = useSensors();
  const sensorsRef = useRef(sensors);
  sensorsRef.current = sensors;
  const lifecycle = useRef(0);
  const setup = useRef<{ code?: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const [foregroundAt, setForegroundAt] = useState(0);
  const foregroundRef = useRef(foregroundAt);
  foregroundRef.current = foregroundAt;
  useEffect(() => {
    const generation = ++lifecycle.current;
    client.setSensorStop(() => sensorsRef.current.stop());
    const visibility = () => {
      const shown = document.visibilityState !== "hidden";
      setVisible(shown);
      client.clearPeer();
      if (!shown) sensorsRef.current.stop();
      else {
        foregroundRef.current = Date.now();
        setForegroundAt(foregroundRef.current);
      }
    };
    const pagehide = () => { setup.current = null; client.stop(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      setup.current = null;
      sensorsRef.current.stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      // React StrictMode immediately installs a new generation. Real unmount
      // still cancels pending HTTP/socket work after sources stop synchronously.
      queueMicrotask(() => { if (lifecycle.current === generation) client.stop(); });
    };
  }, [client]);
  useEffect(() => {
    const handle = () => {
      const invite = invitationCode(window.location.hash);
      if (invite) {
        setCode(invite);
        setScreen(current => current === "home" || current === "join" ? "join" : current);
      }
    };
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);
  const home = () => {
    setup.current = null;
    client.stop();
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setScreen("home");
  };
  const prepare = (join?: string) => {
    client.stop();
    setup.current = { code: join };
    setJoining(!!join);
    setScreen("setup");
  };
  const start = (distanceOnly: boolean, compassAttempted: boolean) => {
    const pending = setup.current;
    const current = sensorsRef.current;
    const now = Date.now();
    // Recheck at this explicit tap. Async callbacks never create/join a session.
    if (!pending || document.visibilityState === "hidden" ||
      !locationReady(current, now, foregroundRef.current) ||
      !(compassReady(current, now, foregroundRef.current) ||
        (distanceOnly && compassAttempted && compassFailed(current)))) return;
    setup.current = null;
    setScreen("live");
    void client.start(pending.code, { preserveSensors: true });
  };
  return <div className="site-shell">
    <main className={"phone-shell screen-" + screen}>
      {screen !== "live" && screen !== "demo" && <header className="app-header">
        <button className="wordmark" onClick={home} aria-label="Yonder home">Yonder</button>
      </header>}
      {screen === "home" && <>
        <section className="hero"><div className="home-arrow" aria-hidden="true">↗<span className="tiny-dot" /></div></section>
        <div className="home-actions">
          <button className="primary" onClick={() => prepare()}>Create session</button>
          <button className="secondary" onClick={() => setScreen("join")}>Join session</button>
          <div className="button-row">
            <button className="text-button" onClick={() => setScreen("demo")}>Try a demo</button>
            <button className="text-button" onClick={() => setScreen("check")}>Sensor check</button>
          </div>
        </div>
      </>}
      {screen === "join" && <>
        <button className="back-button" onClick={home}>← Back</button>
        <section className="intro compact"><h1>Join your friend</h1></section>
        <form className="join-form" onSubmit={e => {
          e.preventDefault();
          if (/^[A-HJ-NP-Z2-9]{8}$/.test(code)) prepare(code);
        }}>
          <label htmlFor="invite-code">Invite code</label>
          <input id="invite-code" value={code} onChange={e => setCode(normalizeCode(e.target.value))}
            autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="ABCD2345"
            maxLength={16} aria-describedby="code-hint" />
          <p id="code-hint">8 characters from your friend’s invite.</p>
          <button className="primary" disabled={!/^[A-HJ-NP-Z2-9]{8}$/.test(code)}>Join session</button>
        </form>
      </>}
      {screen === "setup" && <PermissionSetup sensors={sensors} joining={joining}
        foregroundAt={foregroundAt} onCancel={home} onStart={start} />}
      {screen === "live" && <Live client={client} sensors={sensors} visible={visible}
        foregroundAt={foregroundAt} onExit={home} />}
      {screen === "demo" && <Demo onExit={home} />}
      {screen === "check" && <SensorCheck sensors={sensors} onExit={home} />}
    </main>
  </div>;
}
