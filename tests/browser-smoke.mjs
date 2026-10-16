import { firefox } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const browser = await firefox.launch();
const output = "test-results/browser";
await fs.mkdir(output, { recursive: true });
const base = "http://127.0.0.1:4173";

async function noOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Page must not overflow horizontally");
}
async function inViewport(page, locator) {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert(box && viewport && box.x >= 0 && box.y >= 0 &&
    box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
    "Control or readout must remain entirely within the viewport");
}
async function phase(page, value) {
  await page.locator('.guidance[data-phase="' + value + '"]').waitFor();
}
async function findingFits(page, stopName) {
  const frame = page.locator(".finding-frame");
  await frame.waitFor();
  const box = await frame.boundingBox(), viewport = page.viewportSize();
  assert(box && viewport && Math.abs(box.x) <= 1 && Math.abs(box.y) <= 1 &&
    Math.abs(box.width - viewport.width) <= 1 && Math.abs(box.height - viewport.height) <= 1,
    "Finding frame must fill the viewport at mobile and desktop sizes");
  const stop = page.getByRole("button", { name: stopName, exact: true });
  await inViewport(page, stop);
  await inViewport(page, page.getByRole("button", { name: "Information", exact: true }));
  const controls = await page.locator(".finding-controls").boundingBox();
  for (const selector of [".direction-status", ".distance"]) {
    const item = page.locator(selector);
    if (!await item.count()) continue;
    await inViewport(page, item);
    const itemBox = await item.boundingBox();
    assert(itemBox && controls && itemBox.y + itemBox.height <= controls.y - 2,
      "Guidance distance and status must stay above the round controls");
  }
  assert.equal(await frame.getByRole("button").count(), 2,
    "Closed finding view has only Stop and Information controls");
  assert.equal(await page.getByRole("button", { name: "Information", exact: true }).getAttribute("aria-expanded"), "false");
  await noOverflow(page);
}
async function palette(page, expected) {
  const color = await page.locator(".finding-frame").evaluate(el => getComputedStyle(el).backgroundColor);
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert(channels?.length === 3, "Finding background is opaque");
  if (expected === "black") assert(channels.every(value => value <= 15), "Weak and unavailable guidance use black");
  else assert(channels[1] > channels[0] + 30 && channels[1] > channels[2] + 20,
    "Direction and nearby guidance use a green background");
}
async function screenshot(page, name) {
  await page.screenshot({ path: output + "/" + name + ".png", fullPage: false });
}
async function openInfo(page) {
  await page.getByRole("button", { name: "Information", exact: true }).click();
  await page.getByRole("dialog").waitFor();
}
async function closeInfo(page) {
  await page.getByRole("button", { name: "Close information", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

// Instrument the real controller's boundaries. It still receives fresh GPS and
// absolute north-referenced orientation through its normal permission handlers.
async function sensorFixture(context) {
  await context.addInitScript(() => {
    const fixture = {
      locationMode: "pending", compassMode: "granted",
      watches: 0, clears: 0, compassRequests: 0, absoluteRequests: [],
      active: new Map(),
    };
    window.__sensorFixture = fixture;
    Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined });
    const deliver = (success, failure) => {
      if (fixture.locationMode === "ready") success({
        coords: { latitude: 0, longitude: 0, accuracy: 5 }, timestamp: Date.now(),
      });
      else if (fixture.locationMode === "denied") failure({ code: 1, message: "Synthetic permission denial" });
    };
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      watchPosition(success, failure) {
        const id = ++fixture.watches;
        fixture.active.set(id, { success, failure });
        queueMicrotask(() => { if (fixture.active.has(id)) deliver(success, failure); });
        return id;
      },
      clearWatch(id) { fixture.clears++; fixture.active.delete(id); },
    } });
    class OrientationPermission extends Event {
      static requestPermission(absolute) {
        fixture.compassRequests++;
        fixture.absoluteRequests.push(absolute);
        return Promise.resolve(fixture.compassMode);
      }
    }
    Object.defineProperty(window, "DeviceOrientationEvent", { configurable: true, value: OrientationPermission });
    setInterval(() => {
      for (const { success, failure } of fixture.active.values()) deliver(success, failure);
      if (fixture.compassRequests && fixture.compassMode === "granted") {
        const event = new Event("deviceorientationabsolute");
        Object.defineProperties(event, {
          alpha: { value: 0 }, beta: { value: 0 }, gamma: { value: 0 },
          absolute: { value: true }, webkitCompassAccuracy: { value: 5 },
        });
        window.dispatchEvent(event);
      }
    }, 200);
  });
}
async function metrics(page) {
  return page.evaluate(() => ({
    watches: window.__sensorFixture.watches, clears: window.__sensorFixture.clears,
    active: window.__sensorFixture.active.size,
    compassRequests: window.__sensorFixture.compassRequests,
    absoluteRequests: window.__sensorFixture.absoluteRequests,
  }));
}
async function setSensors(page, patch) {
  await page.evaluate(values => Object.assign(window.__sensorFixture, values), patch);
}
async function mockSession(page) {
  const traffic = { requests: [], messages: [], socketUrls: [], createBodies: [] };
  const grant = {
    sessionId: "browser-smoke", participantId: "self", token: "synthetic-test-token",
    code: "ABCD2345", expiresAt: Date.now() + 600000,
  };
  page.on("request", request => { if (request.url().includes("/api/")) traffic.requests.push(request.url()); });
  for (const path of ["**/api/sessions", "**/api/sessions/join"]) {
    await page.route(path, route => {
      traffic.createBodies.push(route.request().postData() || "");
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(grant) });
    });
  }
  await page.route("**/api/sessions/browser-smoke/end", route => route.fulfill({ status: 204 }));
  await page.routeWebSocket("**/api/sessions/browser-smoke/socket", socket => {
    traffic.socketUrls.push(socket.url());
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      traffic.messages.push(message);
      if (message.type === "authenticate" || message.type === "consent") {
        const consent = message.type === "consent";
        socket.send(JSON.stringify({ type: "state", state: {
          sessionId: grant.sessionId, code: grant.code, expiresAt: grant.expiresAt,
          participants: 2, phase: consent ? "sharing" : "consent",
          selfConsent: consent, peerConsent: true, peerConnected: true,
        } }));
      } else if (message.type === "location") socket.send(JSON.stringify({
        type: "peer-location", fix: { ...message.fix, latitude: 102 / 111195, timestamp: message.fix.timestamp + 1 },
      }));
    });
  });
  return traffic;
}
function untouched(traffic) {
  assert.equal(traffic.requests.length, 0, "No API call is allowed before explicit ready Create/Join");
  assert.equal(traffic.socketUrls.length, 0, "No socket opens during home, demo or setup");
}
async function enterSetup(page, action = "Create session") {
  await page.getByRole("button", { name: action, exact: true }).click();
  await page.getByRole("heading", { name: "Before you begin", exact: true }).waitFor();
  assert(await page.getByRole("button", { name: action, exact: true }).isDisabled());
}
async function stopLive(page) {
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await page.getByRole("heading", { name: "Session ended", exact: true }).waitFor();
  assert.equal((await metrics(page)).active, 0, "Stop clears GPS immediately");
}
try {
  for (const [name, width, height] of [
    ["small-mobile", 320, 568], ["mobile", 375, 667], ["desktop", 1440, 1000],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await sensorFixture(context);
    const page = await context.newPage();
    const traffic = await mockSession(page);
    await page.goto(base);
    await noOverflow(page);
    await inViewport(page, page.getByRole("button", { name: "Create session", exact: true }));
    await inViewport(page, page.getByRole("button", { name: "Join session", exact: true }));
    await screenshot(page, name + "-home");
    untouched(traffic);
    assert.equal((await metrics(page)).watches, 0);
    assert.equal((await metrics(page)).compassRequests, 0);

    await page.getByRole("button", { name: "Try a demo", exact: true }).click();
    await page.getByText("Demo · simulated", { exact: true }).waitFor();
    await phase(page, "direction");
    await palette(page, "green");
    await findingFits(page, "Stop demo");
    for (const slider of await page.getByRole("slider").all()) assert.equal(await slider.isVisible(), false,
      "Demo simulation controls are hidden by default");
    await screenshot(page, name + "-demo-direction");
    await openInfo(page);
    const sliders = page.getByRole("slider");
    const initialHeading = Number(await sliders.nth(0).inputValue());
    await sliders.nth(0).focus();
    await sliders.nth(0).press("ArrowRight");
    assert.equal(Number(await sliders.nth(0).inputValue()), initialHeading + 1, "Demo heading remains keyboard controllable");
    await sliders.nth(1).focus();
    await sliders.nth(1).press("Home");
    await closeInfo(page);
    // Nearby must not activate on a single small GPS reading.
    assert.equal(await page.locator('.guidance[data-phase="nearby"]').count(), 0);
    await phase(page, "nearby");
    assert.equal(await page.getByText("Approximate location", { exact: true }).count(), 1,
      "Nearby retains an accessible estimate marker");
    assert.match(await page.locator(".distance").innerText(), /~\s*5 m/);
    assert.equal(await page.locator(".direction-status").innerText(), "nearby");
    await page.locator(".location-dot.nearby").waitFor();
    assert.equal(await page.locator(".direction-arrow").count(), 0);
    await palette(page, "green");
    await findingFits(page, "Stop demo");
    await screenshot(page, name + "-demo-nearby");
    await openInfo(page);
    await page.getByRole("slider").nth(1).focus();
    await page.getByRole("slider").nth(1).press("End");
    await page.getByLabel("Poor accuracy", { exact: true }).check();
    await closeInfo(page);
    await phase(page, "weak");
    await page.getByText("Weak signal", { exact: true }).waitFor();
    await palette(page, "black");
    assert.equal(await page.locator(".direction-arrow").count(), 0);
    await findingFits(page, "Stop demo");
    await screenshot(page, name + "-demo-weak");
    await openInfo(page);
    await page.getByLabel("Poor accuracy", { exact: true }).uncheck();
    await page.getByLabel("Connection lost", { exact: true }).check();
    await closeInfo(page);
    await phase(page, "weak");
    await palette(page, "black");
    await openInfo(page);
    await page.getByLabel("Connection lost", { exact: true }).uncheck();
    await page.getByLabel("Stale location", { exact: true }).check();
    await closeInfo(page);
    await phase(page, "weak");
    await palette(page, "black");
    await findingFits(page, "Stop demo");
    untouched(traffic);
    assert.equal((await metrics(page)).watches, 0, "Demo never requests GPS");
    assert.equal((await metrics(page)).compassRequests, 0, "Demo never requests compass");
    await page.getByRole("button", { name: "Stop demo", exact: true }).click();
    await page.getByText("The simulated session has ended.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to Yonder", exact: true }).click();

    await enterSetup(page);
    untouched(traffic);
    assert.equal((await metrics(page)).watches, 0, "Opening preflight cannot start sensors");
    assert.equal((await metrics(page)).compassRequests, 0);
    await noOverflow(page);
    await inViewport(page, page.getByRole("button", { name: "Enable location", exact: true }));
    await inViewport(page, page.getByRole("button", { name: "Enable compass", exact: true }));
    await inViewport(page, page.getByRole("button", { name: "Create session", exact: true }));
    await screenshot(page, name + "-preflight");
    await page.getByRole("button", { name: "Enable location", exact: true }).click();
    assert.equal((await metrics(page)).watches, 1);
    assert.equal((await metrics(page)).compassRequests, 0, "Location gesture cannot request compass");
    assert(await page.getByRole("button", { name: "Create session", exact: true }).isDisabled());
    untouched(traffic);
    await setSensors(page, { locationMode: "denied" });
    await page.getByText(/Location permission was denied or revoked/).waitFor();
    assert(await page.getByRole("button", { name: "Create session", exact: true }).isDisabled());
    untouched(traffic);
    await setSensors(page, { locationMode: "ready" });
    await page.getByRole("button", { name: "Enable location", exact: true }).click();
    assert(await page.getByRole("button", { name: "Create session", exact: true }).isDisabled(),
      "Location alone cannot pass the compass gate");
    await page.getByRole("button", { name: "Enable compass", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".permission-setup .primary")?.disabled === false);
    assert.deepEqual((await metrics(page)).absoluteRequests, [true], "Compass requests the absolute permission");
    untouched(traffic);
    const watches = (await metrics(page)).watches;
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    await page.getByRole("button", { name: "Share my location", exact: true }).waitFor();
    assert.equal(traffic.createBodies.length, 1);
    assert.equal(traffic.messages.filter(message => message.type === "location").length, 0,
      "Pairing with locally enabled sensors still cannot transmit before consent");
    assert.equal((await metrics(page)).watches, watches, "Preflight GPS survives into Live");
    await page.getByRole("button", { name: "Share my location", exact: true }).click();
    await phase(page, "direction");
    await palette(page, "green");
    assert.match(await page.locator(".distance").innerText(), /~\s*100 m/);
    assert.match(await page.locator(".quality").innerText(), /Accuracy about ±10 m/);
    await findingFits(page, "Stop sharing");
    await screenshot(page, name + "-live-direction");
    assert(traffic.messages.some(message => message.type === "location"));
    assert(traffic.messages.findIndex(message => message.type === "consent") <
      traffic.messages.findIndex(message => message.type === "location"), "Consent precedes every first location");
    assert(traffic.requests.concat(traffic.socketUrls).every(url =>
      !url.includes("synthetic-test-token") && !/[?&](?:latitude|longitude|token)=/.test(url)),
      "Credentials and coordinates stay out of request and socket URLs");
    assert(traffic.createBodies.every(body => !/latitude|longitude|heading/.test(body)),
      "Session creation does not transmit local sensor readings");
    await openInfo(page);
    await page.getByRole("button", { name: "Refresh location", exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh compass", exact: true }).waitFor();
    await closeInfo(page);
    await stopLive(page);
    await context.close();

    // A separate denied-compass fixture proves fallback is explicit and remains black.
    const fallbackContext = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await sensorFixture(fallbackContext);
    const fallbackPage = await fallbackContext.newPage();
    const fallbackTraffic = await mockSession(fallbackPage);
    await fallbackPage.goto(base);
    await setSensors(fallbackPage, { compassMode: "denied" });
    await fallbackPage.getByRole("button", { name: "Join session", exact: true }).click();
    await fallbackPage.getByLabel("Invite code", { exact: true }).fill("ABCD2345");
    untouched(fallbackTraffic);
    await enterSetup(fallbackPage, "Join session");
    await fallbackPage.getByRole("button", { name: "Enable compass", exact: true }).click();
    const withoutCompass = fallbackPage.getByRole("button", { name: "Continue without compass", exact: true });
    await withoutCompass.waitFor();
    assert(await withoutCompass.isDisabled(), "Distance-only fallback still requires location");
    untouched(fallbackTraffic);
    await setSensors(fallbackPage, { locationMode: "ready" });
    await fallbackPage.getByRole("button", { name: "Enable location", exact: true }).click();
    await fallbackPage.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(button =>
      button.textContent === "Continue without compass")?.disabled);
    assert(await fallbackPage.getByRole("button", { name: "Join session", exact: true }).isDisabled());
    await withoutCompass.click();
    untouched(fallbackTraffic);
    await fallbackPage.getByRole("button", { name: "Join session", exact: true }).click();
    await fallbackPage.getByRole("button", { name: "Share my location", exact: true }).waitFor();
    assert.equal(fallbackTraffic.messages.filter(message => message.type === "location").length, 0);
    await fallbackPage.getByRole("button", { name: "Share my location", exact: true }).click();
    await fallbackPage.getByText("Compass unavailable", { exact: true }).waitFor();
    await phase(fallbackPage, "weak");
    await palette(fallbackPage, "black");
    assert.equal(await fallbackPage.locator(".direction-arrow").count(), 0);
    assert.match(await fallbackPage.locator(".distance").innerText(), /~\s*100 m/);
    await findingFits(fallbackPage, "Stop sharing");
    await screenshot(fallbackPage, name + "-live-no-compass");
    await stopLive(fallbackPage);
    await fallbackContext.close();
    console.log("PASS " + name + ": isolated demo, direction/nearby/weak phases, full viewport fit, explicit permission gate, consent privacy, continuous sensors and distance-only fallback");
  }
} finally {
  await browser.close();
}
