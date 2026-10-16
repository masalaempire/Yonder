// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Guidance, guidanceQuality } from "../src/components/Guidance";

const fix = (meters = 0, accuracy = 5, timestamp = Date.now()) => ({
  latitude: meters / 111195, longitude: 0, accuracy, timestamp,
});
const compass = (degrees = 0, timestamp = Date.now()) => ({
  degrees, timestamp, reference: "true" as const, source: "absolute" as const, accuracy: 5,
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows a rounded GPS estimate without a compass and never invents a bearing", () => {
  const view = render(<Guidance local={fix()} peer={fix(102)} heading={null} connected visible />);
  expect(view.container.querySelector('[data-phase="weak"]')).toBeTruthy();
  expect(screen.getByText("Compass unavailable")).toBeTruthy();
  expect(screen.getByText("100 m")).toBeTruthy();
  expect(view.container.querySelector(".approx")?.textContent).toBe("~");
  expect(view.container.querySelector(".direction-arrow")).toBeNull();
});

it("rotates through the shortest angle across the wrap boundary", () => {
  const local = fix(), peer = fix(85);
  const view = render(<Guidance local={local} peer={peer} heading={compass(181)} connected visible />);
  const vector = () => view.container.querySelector(".direction-vector") as HTMLElement;
  expect(vector().style.transform).toBe("rotate(179deg)");
  view.rerender(<Guidance local={local} peer={peer} heading={compass(179)} connected visible />);
  expect(vector().style.transform).toBe("rotate(181deg)");
  expect(view.container.querySelector('[data-phase="direction"]')).toBeTruthy();
});

it("suppresses the arrow for uncertainty, stale readings, hidden tabs and interrupted sessions", () => {
  const now = Date.now(), local = fix(0, 20, now), peer = fix(20, 20, now), heading = compass(0, now);
  expect(guidanceQuality(local, peer, heading, now, true, true).arrow).toBe(false);
  const view = render(<Guidance local={local} peer={peer} heading={heading} connected visible />);
  expect(view.container.querySelector('[data-phase="weak"]')).toBeTruthy();
  const distant = fix(85, 5, now);
  for (const props of [
    { local: fix(0, 5, now - 16000), peer: distant, heading, connected: true, visible: true },
    { local: fix(), peer: distant, heading: compass(0, now - 6000), connected: true, visible: true },
    { local: fix(), peer: distant, heading, connected: false, visible: true },
    { local: fix(), peer: distant, heading, connected: true, visible: false },
  ]) {
    view.rerender(<Guidance {...props} />);
    expect(view.container.querySelector('[data-phase="weak"]')).toBeTruthy();
    expect(view.container.querySelector(".direction-arrow")).toBeNull();
  }
});

it("enters nearby only after 2.5 seconds and retains the existing exit hysteresis", () => {
  vi.useFakeTimers();
  const now = Date.now(), local = fix(0, 5, now), heading = compass(0, now);
  const view = render(<Guidance local={local} peer={fix(5, 5, now)} heading={heading} connected visible />);
  act(() => vi.advanceTimersByTime(2250));
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeNull();
  act(() => vi.advanceTimersByTime(250));
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeTruthy();
  expect(screen.getByText("Approximate location")).toBeTruthy();
  expect(view.container.querySelector(".direction-arrow")).toBeNull();
  view.rerender(<Guidance local={local} peer={fix(18, 5, now)} heading={heading} connected visible />);
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeTruthy();
  view.rerender(<Guidance local={local} peer={fix(21, 5, now)} heading={heading} connected visible />);
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeNull();
});

it("cannot enter nearby from inaccurate fixes and immediately leaves it when quality is lost", () => {
  vi.useFakeTimers();
  const now = Date.now(), heading = compass(0, now);
  const view = render(<Guidance local={fix(0, 15, now)} peer={fix(5, 15, now)} heading={heading} connected visible />);
  act(() => vi.advanceTimersByTime(3000));
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeNull();
  view.rerender(<Guidance local={fix(0, 5)} peer={fix(5, 5)} heading={compass()} connected visible />);
  act(() => vi.advanceTimersByTime(2500));
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeTruthy();
  view.rerender(<Guidance local={fix(0, 5)} peer={fix(5, 5, now - 16000)} heading={compass()} connected visible />);
  expect(view.container.querySelector('[data-phase="weak"]')).toBeTruthy();
  expect(view.container.querySelector(".location-dot.nearby")).toBeNull();
});

it("restores black browser chrome when guidance ends", () => {
  const theme = document.createElement("meta");
  theme.name = "theme-color";
  theme.content = "#080808";
  document.head.appendChild(theme);
  const view = render(<Guidance local={fix()} peer={fix(85)} heading={compass()} connected visible />);
  expect(theme.content).toBe("#00c45b");
  view.unmount();
  expect(theme.content).toBe("#080808");
  theme.remove();
});
