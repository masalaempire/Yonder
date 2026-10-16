import React, { useEffect, useId, useRef, useState } from "react";

export function FindingFrame({
  children,
  onStop,
  onFound,
  demo = false,
  info,
}: {
  children: React.ReactNode;
  onStop: () => void;
  onFound?: () => void;
  demo?: boolean;
  info?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const infoButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    infoButton.current?.focus();
  };
  return (
    <div className="finding-frame">
      {children}
      <header className="finding-heading">
        <p className="finding-label">FINDING</p>
        <h1>Your friend</h1>
      </header>
      {demo && <span className="demo-marker">Demo</span>}
      {open && (
        <section
          id={panelId}
          className="finding-info"
          role="dialog"
          aria-label={demo ? "Demo information" : "Sharing information"}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="info-heading">
            <h2>{demo ? "Demo" : "Information"}</h2>
            <button ref={closeButton} className="info-close" onClick={close} aria-label="Close information">×</button>
          </div>
          {info}
          <p className="info-note">Approximate GPS guidance. Keep Yonder open and look around safely.</p>
          {onFound && <button className="primary" onClick={onFound}>We found each other</button>}
        </section>
      )}
      <footer className="finding-controls">
        <button className="round-control" onClick={onStop} aria-label={demo ? "Stop demo" : "Stop sharing"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" /></svg>
        </button>
        <button
          ref={infoButton}
          className="round-control"
          aria-label="Information"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => open ? close() : setOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11V17" /><circle className="info-dot" cx="12" cy="7.4" r="0.6" /></svg>
        </button>
      </footer>
    </div>
  );
}
