// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import Demo from "../src/components/Demo";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps simulation controls behind Information and uses no real sensors or network", () => {
  const fetch = vi.fn(), geo = vi.fn(), exit = vi.fn();
  vi.stubGlobal("fetch", fetch);
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { watchPosition: geo },
  });
  const view = render(createElement(Demo, { onExit: exit }));
  expect(screen.getByText("Demo · simulated")).toBeTruthy();
  expect(view.container.querySelector('[data-phase="direction"]')).toBeTruthy();
  expect(screen.queryByLabelText("Poor accuracy")).toBeNull();
  const info = screen.getByRole("button", { name: "Information" });
  expect(info.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(info);
  expect(screen.getByRole("dialog", { name: "Demo information" })).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Poor accuracy"));
  expect(view.container.querySelector('[data-phase="weak"]')).toBeTruthy();
  expect(view.container.querySelector(".direction-arrow")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close information" }));
  expect(screen.queryByLabelText("Poor accuracy")).toBeNull();
  expect(document.activeElement).toBe(info);
  fireEvent.click(screen.getByRole("button", { name: "Stop demo" }));
  expect(screen.getByText("The simulated session has ended.")).toBeTruthy();
  expect(screen.getByText("Demo · simulated")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  expect(geo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to Yonder" }));
  expect(exit).toHaveBeenCalledOnce();
});

it("offers live-equivalent weak and sustained nearby phases through simulated fixes", () => {
  vi.useFakeTimers();
  const view = render(createElement(Demo, { onExit: vi.fn() }));
  fireEvent.click(screen.getByRole("button", { name: "Information" }));
  fireEvent.click(screen.getByLabelText("Connection lost"));
  expect(screen.getByText("Connection interrupted")).toBeTruthy();
  expect(view.container.querySelector(".direction-arrow")).toBeNull();
  fireEvent.click(screen.getByLabelText("Connection lost"));
  fireEvent.click(screen.getByLabelText("Stale location"));
  expect(view.container.querySelector('[data-phase="weak"]')).toBeTruthy();
  expect(view.container.querySelector(".distance")?.textContent).toBe("—");
  fireEvent.click(screen.getByLabelText("Stale location"));
  fireEvent.change(screen.getByLabelText(/Move closer/), { target: { value: "5" } });
  act(() => vi.advanceTimersByTime(2250));
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeNull();
  act(() => vi.advanceTimersByTime(500));
  expect(view.container.querySelector('[data-phase="nearby"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "We found each other" }));
  expect(screen.getByText("The simulated session has ended.")).toBeTruthy();
});
