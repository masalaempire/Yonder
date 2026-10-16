// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { StrictMode } from "react";
import App from "../src/App";
import { Guidance, guidanceQuality } from "../src/components/Guidance";
import type { Sensors } from "../src/sensors/types";

type Reading = Pick<Sensors, "location" | "heading" | "locationStatus" | "compassStatus" | "locationError" | "compassError">;
const sensorStore = vi.hoisted(() => ({
  snapshot: { location: null, heading: null, locationStatus: "idle", compassStatus: "idle",
    locationError: null, compassError: null } as Reading,
  listeners: new Set<() => void>(),
  stop: vi.fn(), location: vi.fn(), compass: vi.fn(),
}));
vi.mock("../src/sensors/useSensors", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useSensors: () => {
    const state = useSyncExternalStore(
      (listener: () => void) => { sensorStore.listeners.add(listener); return () => { sensorStore.listeners.delete(listener); }; },
      () => sensorStore.snapshot,
    );
    return { ...state, requestLocation: sensorStore.location, requestCompass: sensorStore.compass, stop: sensorStore.stop };
  }};
});
function update(patch: Partial<Reading>) {
  act(() => {
    sensorStore.snapshot = { ...sensorStore.snapshot, ...patch };
    sensorStore.listeners.forEach(listener => listener());
  });
}
function location() {
  update({ locationStatus: "ready", location: { latitude: 0, longitude: 0, accuracy: 5, timestamp: Date.now() } });
}
function compass() {
  update({ compassStatus: "ready", heading: { degrees: 0, reference: "true", source: "absolute", accuracy: 5, timestamp: Date.now() } });
}
function setup() {
  fireEvent.click(screen.getByRole("button", { name: "Create session", exact: true }));
  expect(screen.getByRole("heading", { name: "Before you begin" })).toBeTruthy();
}
function allow() {
  fireEvent.click(screen.getByRole("button", { name: "Enable location" }));
  location();
  fireEvent.click(screen.getByRole("button", { name: "Enable compass" }));
  compass();
}
const finalCreate = () => screen.getByRole("button", { name: "Create session", exact: true }) as HTMLButtonElement;
const pendingFetch = () => vi.fn().mockImplementation(() => new Promise(() => {}));
beforeEach(() => {
  vi.clearAllMocks();
  sensorStore.snapshot = { location: null, heading: null, locationStatus: "idle", compassStatus: "idle", locationError: null, compassError: null };
  sensorStore.compass.mockResolvedValue(undefined);
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
it("home and invitation entry request neither session nor sensors", () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  window.history.replaceState(null, "", "/#join=ABCD2345");
  render(<App />);
  expect((screen.getByLabelText("Invite code") as HTMLInputElement).value).toBe("ABCD2345");
  expect(fetch).not.toHaveBeenCalled();
  expect(sensorStore.location).not.toHaveBeenCalled();
  expect(sensorStore.compass).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Join session", exact: true }));
  expect(screen.getByRole("heading", { name: "Before you begin" })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it("joins only from the explicit final setup button and preserves the normalized invite", () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  window.history.replaceState(null, "", "/#join=abcd-2345");
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Join session", exact: true }));
  allow();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Join session", exact: true }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions/join");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ code: "ABCD2345" });
});

it("requires direct permission actions and an explicit final tap with fresh location and true compass", async () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<App />); setup();
  expect(fetch).not.toHaveBeenCalled();
  expect(finalCreate().disabled).toBe(true);
  expect(sensorStore.location).not.toHaveBeenCalled();
  expect(sensorStore.compass).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Enable location" }));
  update({ locationStatus: "requesting" });
  expect(finalCreate().disabled).toBe(true);
  update({ locationStatus: "denied" });
  expect(finalCreate().disabled).toBe(true);
  fireEvent.click(finalCreate());
  expect(fetch).not.toHaveBeenCalled();
  location();
  expect(finalCreate().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Enable compass" }));
  expect(sensorStore.compass).toHaveBeenCalledTimes(1);
  update({ compassStatus: "requesting" });
  expect(finalCreate().disabled).toBe(true);
  compass();
  expect(fetch).not.toHaveBeenCalled();
  expect(finalCreate().disabled).toBe(false);
  const submit = finalCreate();
  fireEvent.click(submit);
  fireEvent.click(submit);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/sessions");
});
it("offers distance only after a compass attempt and requires its explicit selection and a fresh location", () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<App />); setup();
  update({ compassStatus: "unavailable" });
  expect(screen.queryByRole("button", { name: "Continue without compass" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Enable compass" }));
  const fallback = screen.getByRole("button", { name: "Continue without compass" }) as HTMLButtonElement;
  expect(fallback.disabled).toBe(true);
  location();
  expect(finalCreate().disabled).toBe(true);
  fireEvent.click(fallback);
  expect(fetch).not.toHaveBeenCalled();
  expect(finalCreate().disabled).toBe(false);
  fireEvent.click(finalCreate());
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not resurrect cancelled setup when pending permission callbacks arrive", () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<App />); setup();
  fireEvent.click(screen.getByRole("button", { name: "Enable location" }));
  fireEvent.click(screen.getByRole("button", { name: "Enable compass" }));
  const previous = sensorStore.stop.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /Back/ }));
  expect(sensorStore.stop.mock.calls.length).toBeGreaterThan(previous);
  location(); compass();
  expect(screen.queryByRole("heading", { name: "Before you begin" })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("rechecks freshness at the final tap even before the readiness timer rerenders", () => {
  vi.useFakeTimers();
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<App />); setup(); allow();
  const button = finalCreate();
  expect(button.disabled).toBe(false);
  vi.setSystemTime(Date.now() + 16000);
  fireEvent.click(button);
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves preflight sources across an explicit start under StrictMode", async () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<StrictMode><App /></StrictMode>);
  setup(); allow();
  const previous = sensorStore.stop.mock.calls.length;
  fireEvent.click(finalCreate());
  await Promise.resolve();
  expect(screen.getByText("Making room for two")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sensorStore.stop).toHaveBeenCalledTimes(previous);
});
it("stops sources when hidden and requires explicit acquisition after foregrounding", () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<App />); setup(); allow();
  const previous = sensorStore.stop.mock.calls.length;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
  expect(sensorStore.stop).toHaveBeenCalledTimes(previous + 1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 1);
  fireEvent(document, new Event("visibilitychange"));
  expect(sensorStore.location).toHaveBeenCalledTimes(1);
  expect(sensorStore.compass).toHaveBeenCalledTimes(1);
  fireEvent.click(finalCreate());
  expect(fetch).not.toHaveBeenCalled();
});
it("pagehide cancels setup so callbacks cannot submit it", () => {
  const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
  render(<App />); setup(); allow();
  fireEvent(window, new Event("pagehide"));
  fireEvent.click(finalCreate());
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps local setup readings through pairing and transmits only after mutual consent", async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  class Socket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: Array<{ type: string }> = [];
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(selfConsent: boolean, peerConsent: boolean) {
      this.onmessage?.({ data: JSON.stringify({ type: "state", state: {
        sessionId: "session", code: "ABCD2345", participants: 2, peerConnected: true,
        selfConsent, peerConsent, phase: selfConsent && peerConsent ? "sharing" : "consent",
        expiresAt: Date.now() + 3600000,
      } }) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    sessionId: "session", participantId: "participant", token: "secret",
    code: "ABCD2345", expiresAt: Date.now() + 3600000,
  }), { status: 201, headers: { "Content-Type": "application/json" } })));
  vi.stubGlobal("fetch", fetch);
  render(<App />); setup(); allow();
  const previous = sensorStore.stop.mock.calls.length;
  await act(async () => { fireEvent.click(finalCreate()); });
  const socket = sockets[0];
  act(() => { socket.open(); socket.receive(false, false); });
  expect(sensorStore.stop).toHaveBeenCalledTimes(previous);
  act(() => vi.advanceTimersByTime(10));
  location();
  expect(socket.sent.filter(message => message.type === "location")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Share my location" }));
  expect(socket.sent.filter(message => message.type === "consent")).toHaveLength(1);
  act(() => socket.receive(true, false));
  expect(socket.sent.filter(message => message.type === "location")).toHaveLength(0);
  act(() => socket.receive(true, true));
  expect(socket.sent.filter(message => message.type === "location")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
  expect(sensorStore.stop.mock.calls.length).toBeGreaterThan(previous);
});

it("avoids misleading arrows within combined uncertainty", () => {
  const now = Date.now(),
    a = { latitude: 0, longitude: 0, accuracy: 20, timestamp: now },
    b = { ...a, latitude: 20 / 111195 },
    h = {
      degrees: 0,
      timestamp: now,
      reference: "true" as const,
      source: "absolute" as const,
      accuracy: 5,
    };
  expect(guidanceQuality(a, b, h, now, true, true).arrow).toBe(false);
  expect(
    guidanceQuality(a, { ...b, latitude: 100 / 111195 }, h, now, true, true)
      .arrow,
  ).toBe(true);
  expect(guidanceQuality(a, b, h, now, true, false).arrow).toBe(false);
});
it("locally disables guidance when locations stop arriving", () => {
  vi.useFakeTimers();
  const now = Date.now(),
    a = { latitude: 0, longitude: 0, accuracy: 5, timestamp: now },
    b = { ...a, latitude: 100 / 111195 },
    h = {
      degrees: 0,
      timestamp: now,
      reference: "true" as const,
      source: "absolute" as const,
      accuracy: 5,
    };
  render(<Guidance local={a} peer={b} heading={h} connected visible />);
  expect(screen.getByText("ahead")).toBeTruthy();
  act(() => vi.advanceTimersByTime(16000));
  expect(screen.queryByText("ahead")).toBeNull();
  expect(screen.getByText("Weak signal")).toBeTruthy();
});
it("reports actual coordinate age and removes nearby styling immediately when quality is lost", () => {
  vi.useFakeTimers();
  const now = Date.now(),
    a = { latitude: 0, longitude: 0, accuracy: 5, timestamp: now },
    b = { ...a, latitude: 5 / 111195 },
    h = {
      degrees: 0,
      timestamp: now,
      reference: "true" as const,
      source: "absolute" as const,
      accuracy: 5,
    };
  const view = render(
    <Guidance local={a} peer={b} heading={h} connected visible />,
  );
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByText("nearby")).toBeTruthy();
  expect(view.container.querySelector(".location-dot.nearby")).toBeTruthy();
  expect(screen.getByText(/updated 3s ago/)).toBeTruthy();
  view.rerender(
    <Guidance
      local={{ ...a, accuracy: 70 }}
      peer={b}
      heading={h}
      connected
      visible
    />,
  );
  expect(view.container.querySelector(".location-dot.nearby")).toBeNull();
});

it("keeps rounded distance and quality when fresh GPS has no compass", () => {
  const now = Date.now(),
    local = { latitude: 0, longitude: 0, accuracy: 5, timestamp: now },
    peer = { ...local, latitude: 102 / 111195 };
  const view = render(
    <Guidance local={local} peer={peer} heading={null} connected visible />,
  );
  expect(screen.getByText("Compass unavailable")).toBeTruthy();
  expect(screen.getByText("100 m")).toBeTruthy();
  expect(screen.getByText(/Accuracy about ±10 m/)).toBeTruthy();
  expect(view.container.querySelector(".direction-arrow")).toBeNull();
  expect(view.container.querySelector(".guidance.awaiting-locations")).toBeNull();
  view.rerender(
    <Guidance local={null} peer={peer} heading={null} connected visible />,
  );
  expect(view.container.querySelector(".guidance.awaiting-locations")).toBeTruthy();
});

