import { firefox } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const browser = await firefox.launch();
const output = "test-results/browser";
await fs.mkdir(output, { recursive: true });
const base = "http://127.0.0.1:4173";
async function visibleInViewport(page, locator) {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert(
    box && viewport && box.y >= 0 && box.y + box.height <= viewport.height,
    "Stop sharing must stay entirely in the viewport",
  );
}
async function aboveFooter(page, locator) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await locator.boundingBox();
  const footer = await page.locator(".is-finding .session-footer").boundingBox();
  assert(
    box && footer && box.y >= 0 && box.y + box.height <= footer.y - 2,
    "Guidance status and needed sensor controls must be visible above the footer",
  );
}
async function noOverflow(page) {
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Page must not overflow horizontally",
  );
}
try {
  for (const [name, width, height] of [
    ["small-mobile", 320, 568],
    ["mobile", 375, 667],
    ["desktop", 1440, 1000],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const apiCalls = [];
    await page.route("**/api/**", (route) => {
      apiCalls.push(route.request().url());
      return route.abort();
    });
    await page.goto(base);
    await noOverflow(page);
    await visibleInViewport(page, page.getByRole("button", { name: /Create session/ }));
    await visibleInViewport(page, page.getByRole("button", { name: "Join session" }));
    await page.screenshot({
      path: output + "/" + name + "-home.png",
      fullPage: false,
    });
    assert.equal(apiCalls.length, 0, "Home must not start a live session");
    await page.getByRole("button", { name: "Try a demo" }).click();
    await page.getByText("Demo · simulated").waitFor();
    await page.getByText("Head this way").waitFor();
    const stop = page.getByRole("button", { name: "Stop sharing" });
    await visibleInViewport(page, stop);
    await aboveFooter(page, page.locator(".direction-status"));
    await aboveFooter(page, page.locator(".distance"));
    await noOverflow(page);
    await page.screenshot({
      path: output + "/" + name + "-demo.png",
      fullPage: false,
    });
    const sliders = page.getByRole("slider");
    await sliders.nth(0).focus();
    await sliders.nth(0).press("ArrowRight");
    assert.equal(
      await sliders.nth(0).inputValue(),
      "21",
      "Demo heading responds to keyboard",
    );
    await sliders.nth(1).focus();
    await sliders.nth(1).press("Home");
    await page
      .getByText("You may be nearby", { exact: true })
      .waitFor({ timeout: 6000 });
    await sliders.nth(1).press("End");
    await page.getByText("Head this way", { exact: true }).waitFor();
    await page.getByLabel("Poor accuracy", { exact: true }).check();
    await page.getByText("Location accuracy is low").waitFor();
    await aboveFooter(page, page.locator(".direction-status"));
    await visibleInViewport(page, stop);
    await page.getByLabel("Poor accuracy", { exact: true }).uncheck();
    await page.getByLabel("Connection lost", { exact: true }).check();
    await page.getByText("Connection interrupted", { exact: true }).waitFor();
    await page.getByLabel("Connection lost", { exact: true }).uncheck();
    await page.getByLabel("Stale location", { exact: true }).check();
    await page
      .getByText("Waiting for fresh locations", { exact: true })
      .waitFor();
    await visibleInViewport(page, stop);
    await noOverflow(page);
    assert.equal(apiCalls.length, 0, "Demo must not make API requests");
    await stop.click();
    await page.getByText("The simulated session has ended.").waitFor();
    await page.getByRole("button", { name: "Back to Yonder" }).click();
    await page.unroute("**/api/**");
    const grant = {
      sessionId: "browser-smoke",
      participantId: "self",
      token: "synthetic-test-token",
      code: "ABCD2345",
      expiresAt: Date.now() + 600000,
    };
    await page.route("**/api/sessions", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(grant),
      }),
    );
    await page.route("**/api/sessions/browser-smoke/end", (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.routeWebSocket(
      "**/api/sessions/browser-smoke/socket",
      (socket) => {
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "authenticate" || message.type === "consent") {
            const consent = message.type === "consent";
            socket.send(
              JSON.stringify({
                type: "state",
                state: {
                  sessionId: grant.sessionId,
                  code: grant.code,
                  expiresAt: grant.expiresAt,
                  participants: 2,
                  phase: consent ? "sharing" : "consent",
                  selfConsent: consent,
                  peerConsent: true,
                  peerConnected: true,
                },
              }),
            );
          } else if (message.type === "location") {
            socket.send(
              JSON.stringify({
                type: "peer-location",
                fix: {
                  ...message.fix,
                  latitude: 102 / 111195,
                  timestamp: message.fix.timestamp + 1,
                },
              }),
            );
          }
        });
      },
    );
    await page.getByRole("button", { name: /Create session/ }).click();
    await page.getByRole("button", { name: "Share my location" }).click();
    await page.getByText("Enable location to begin", { exact: true }).waitFor();
    await visibleInViewport(
      page,
      page.getByRole("button", { name: "Stop sharing" }),
    );
    await aboveFooter(page, page.getByText("Enable location to begin", { exact: true }));
    await aboveFooter(page, page.getByRole("button", { name: "Enable location", exact: true }));
    await aboveFooter(page, page.getByRole("button", { name: "Enable compass", exact: true }));
    await noOverflow(page);
    await page.screenshot({
      path: output + "/" + name + "-live-finding.png",
      fullPage: false,
    });
    // Synthetic readings exercise the real permission controls without device sensors.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          watchPosition(success) {
            success({
              coords: { latitude: 0, longitude: 0, accuracy: 5 },
              timestamp: Date.now(),
            });
            return 1;
          },
          clearWatch() {},
        },
      });
      Object.defineProperty(window, "DeviceOrientationEvent", {
        configurable: true,
        value: class {
          static requestPermission() {
            return Promise.resolve("denied");
          }
        },
      });
    });
    await page.getByRole("button", { name: "Enable location", exact: true }).click();
    await page.getByText("Compass direction unavailable", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Enable compass", exact: true }).click();
    await page.getByText(/Compass permission was denied or revoked/).waitFor();
    assert.match(await page.locator(".distance").innerText(), /~\s*100 m/);
    assert.match(await page.locator(".quality").innerText(), /Accuracy about ±10 m/);
    assert.equal(await page.locator(".direction-arrow").count(), 0);
    await page.locator(".distance").waitFor({ state: "visible" });
    await aboveFooter(page, page.locator(".distance"));
    await aboveFooter(page, page.locator(".quality"));
    await aboveFooter(page, page.locator(".direction-status"));
    await aboveFooter(page, page.getByRole("button", { name: "Enable compass", exact: true }));
    const sensorBox = await page.locator(".sensor-tools").boundingBox();
    const guidanceBox = await page.locator(".guidance").boundingBox();
    assert(
      sensorBox && guidanceBox && sensorBox.y + sensorBox.height <= guidanceBox.y,
      "Sensor controls must not overlap guidance",
    );
    await visibleInViewport(page, page.getByRole("button", { name: "Stop sharing" }));
    await noOverflow(page);
    await page.screenshot({
      path: output + "/" + name + "-live-no-compass.png",
      fullPage: false,
    });
    await page.getByRole("button", { name: "Stop sharing" }).click();
    await page.getByText("Until next time.").waitFor();
    console.log(
      "PASS " +
        name +
        ": home/demo isolation, controls, live consent flow, distance without compass, unobscured guidance/permissions, persistent stop and no horizontal overflow",
    );
    await context.close();
  }
} finally {
  await browser.close();
}
