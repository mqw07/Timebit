import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BADGE_REFRESH_ALARM, PHASE_END_ALARM } from "../extension/background/alarms.js";
import { COMPLETION_NOTIFICATION } from "../extension/background/feedback.js";
import { POPUP_ROUTE_KEY } from "../extension/core/navigation.js";

const require = createRequire(import.meta.url);
const { chromium, expect } = require(process.env.TIMEBIT_PLAYWRIGHT || "playwright/test");
const extensionPath = process.env.TIMEBIT_EXTENSION || fileURLToPath(new URL("../extension", import.meta.url));
let loadedExtensionPath = extensionPath;
const overtime = /^-\d{2,}:\d{2}$/;
let profile;
let context;
let cdp;
let popupUrl;
let popup;
let observer;
let errors;

async function openPopup() {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(popupUrl);
  await expect(page.getByRole("combobox", { name: "Timing mode" })).toBeEnabled();
  return page;
}

async function launchChrome() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--disable-background-networking"],
    timeout: 15_000,
  });
  cdp = await context.browser().newBrowserCDPSession();
}

async function storageObserver() {
  // This static extension document exposes storage without running the popup script.
  if (!observer || observer.isClosed()) {
    observer = await context.newPage();
    await observer.goto(new URL("../assets/timbit.svg", popupUrl).href);
  }
  return observer;
}

async function readStoredTimer() {
  const page = await storageObserver();
  return page.evaluate(async () => (await chrome.storage.local.get("timebit")).timebit?.timer);
}

async function workerTargetFor(workerUrl) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.find(({ url, type }) => url === workerUrl && type === "service_worker");
}

async function badgeText() {
  const page = await storageObserver();
  return page.evaluate(() => chrome.action.getBadgeText({}));
}

async function notificationIds() {
  const page = await storageObserver();
  return page.evaluate(async () => Object.keys(await chrome.notifications.getAll()));
}

async function toolbarPopups() {
  const page = await storageObserver();
  return page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["POPUP"] }));
}

async function findDocument(url) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.find((info) => info.url === url);
}

async function evaluateDocument(url, expression) {
  const target = await findDocument(url);
  if (!target) return;

  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId });
  let receive;
  try {
    const response = new Promise((resolve) => {
      receive = (event) => {
        if (event.sessionId !== sessionId) return;
        const reply = JSON.parse(event.message);
        if (reply.id === 1) resolve(reply.result?.result.value);
      };
      cdp.on("Target.receivedMessageFromTarget", receive);
    });
    await cdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
    });
    return await Promise.race([response, delay(1_000)]);
  } finally {
    cdp.off("Target.receivedMessageFromTarget", receive);
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
}

function readChime() {
  return evaluateDocument(new URL("../offscreen/audio.html", popupUrl).href, `(() => {
    const audio = document.querySelector('audio');
    return { volume: audio.volume, played: audio.currentTime > 0, duration: audio.duration };
  })()`);
}

async function restartWithoutAlarms(waitUntil = 0, prepareState) {
  await popup.evaluate(async (names) => {
    await Promise.all(names.map((name) => chrome.alarms.clear(name)));
  }, [PHASE_END_ALARM, BADGE_REFRESH_ALARM]);
  await popup.close();
  if (prepareState) await prepareState(await storageObserver());
  await context.close();
  if (waitUntil > Date.now()) await delay(waitUntil - Date.now());
  await launchChrome();
  // Chrome's DevTools-loaded extensions must be loaded again in the restarted browser.
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: loadedExtensionPath });
  assert.equal(new URL(popupUrl).hostname, id);
}

before(async () => {
  profile = await mkdtemp(join(tmpdir(), "timebit-chrome-"));
  await launchChrome();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
  popupUrl = `chrome-extension://${id}/popup/popup.html`;
});

after(async () => {
  try {
    await context?.close();
  } finally {
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

beforeEach(async () => {
  errors = [];
  for (const page of context.pages()) await page.close();
  const cleanup = await openPopup();
  await cleanup.evaluate(async ({ id, routeKey }) => {
    await chrome.storage.local.clear();
    await chrome.storage.session.remove(routeKey);
    await chrome.notifications.clear(id);
  }, { id: COMPLETION_NOTIFICATION, routeKey: POPUP_ROUTE_KEY });
  await cleanup.close();
  popup = await openPopup();
});

function gear() {
  return popup.getByRole("button", { name: "Settings", exact: true });
}

async function editor(mode) {
  await gear().click();
  await popup.getByRole("button", { name: "Timing modes", exact: true }).click();
  await popup.getByRole("button", { name: `Edit ${mode} settings`, exact: false }).click();
  await expect(popup.getByRole("heading", { name: mode, exact: true })).toBeVisible();
}

async function soundSettings() {
  await gear().click();
  await popup.getByRole("button", { name: "Notifications & sound", exact: true }).click();
}

async function backToTimer() {
  await popup.getByRole("button", { name: "Back to settings", exact: true }).click();
  await popup.getByRole("button", { name: "Back to timer", exact: true }).click();
}

async function save() {
  await popup.getByRole("button", { name: "Save changes" }).click();
  await expect(popup.getByRole("heading", { name: "Timing modes" })).toBeVisible();
}

test("Chrome loads the unpacked extension, icons, worker and ready popup", async () => {
  await expect(popup.getByRole("timer")).toHaveText("25:00");
  await expect(popup.locator("#phase")).toHaveText("Focus · Block 1 of 3");
  await expect(popup.locator("#next")).toHaveText("Next: 5 min short break");
  const details = await popup.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    const paths = Object.values(manifest.icons);
    const sizes = await Promise.all(paths.map(async (path) => {
      const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL(path))).blob());
      return [bitmap.width, bitmap.height];
    }));
    return {
      popup: manifest.action.default_popup,
      version: manifest.manifest_version,
      sizes,
      loadedHeaderIcon: document.querySelector(".mark").naturalWidth > 0,
      scrollWidth: document.body.scrollWidth,
      backgroundColor: getComputedStyle(document.documentElement).backgroundColor,
    };
  });
  assert.deepEqual(details, {
    popup: "popup/popup.html", version: 3,
    sizes: [[16, 16], [32, 32], [48, 48], [128, 128]],
    loadedHeaderIcon: true, scrollWidth: 390, backgroundColor: "rgb(233, 237, 242)",
  });
  if (process.env.TIMEBIT_SCREENSHOT) {
    await popup.locator("body").screenshot({ path: process.env.TIMEBIT_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
});

test("the settings hub connects its pages and a tab restores its route on reload", async () => {
  await gear().click();
  await expect(popup.getByRole("heading", { name: "Settings", exact: true })).toBeFocused();
  await popup.getByRole("button", { name: "Manage tasks", exact: true }).click();
  await expect(popup.getByRole("heading", { name: "Manage tasks" })).toBeFocused();
  await expect(popup).toHaveURL(`${popupUrl}#settings/tasks`);
  await popup.reload();
  await expect(popup.getByRole("heading", { name: "Manage tasks" })).toBeVisible();
  await popup.getByRole("button", { name: "Back to settings" }).click();
  await popup.getByRole("button", { name: "Notifications & sound" }).click();
  await expect(popup.getByRole("heading", { name: "Notifications & sound" })).toBeFocused();

  const second = await openPopup();
  await second.getByRole("button", { name: "Manage tasks" }).click();
  await second.getByRole("button", { name: "Back to timer" }).click();
  await expect(second.getByRole("timer")).toBeVisible();
  await expect(popup.getByRole("heading", { name: "Notifications & sound" })).toBeVisible();
  await backToTimer();
  await expect(popup).toHaveURL(popupUrl);
  await popup.goto(`${popupUrl}#unknown`);
  await expect(popup.getByRole("timer")).toBeVisible();
  await expect(popup).toHaveURL(popupUrl);
  assert.deepEqual(errors, []);
});

test("Pomodoro validates inline, saves custom durations, and restores them when reopened", async () => {
  await editor("Pomodoro");
  await expect(popup.getByRole("spinbutton")).toHaveCount(4);
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0");
  await popup.getByLabel("Long break every").fill("2.5");
  await popup.getByRole("button", { name: "Save changes" }).click();
  await expect(popup.getByText("Enter a positive number of minutes.")).toBeVisible();
  await expect(popup.getByText("Enter a whole number of study blocks.")).toBeVisible();
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("12.5");
  await popup.getByLabel("Short break").fill("3");
  await popup.getByRole("spinbutton", { name: "Long break", exact: true }).fill("9");
  await popup.getByLabel("Long break every").fill("2");
  await save();
  await expect(popup.getByText("12.5 min study · 3 min breaks")).toBeVisible();
  await popup.close();
  popup = await openPopup();
  await expect(popup.getByRole("timer")).toHaveText("12:30");
  await expect(popup.locator("#phase")).toHaveText("Focus · Block 1 of 2");
  await expect(popup.locator("#next")).toHaveText("Next: 3 min short break");
  assert.deepEqual(errors, []);
});

test("Cascade rejects a non-descending sequence and applies one shared break", async () => {
  await editor("Cascade");
  await expect(popup.getByRole("spinbutton")).toHaveCount(7);
  await popup.getByLabel("Study block 2 in minutes").fill("55");
  await popup.getByRole("button", { name: "Save changes" }).click();
  await expect(popup.getByRole("alert")).toHaveText("Block 2: Enter less time than the previous block.");
  await popup.getByLabel("Study block 2 in minutes").fill("45");
  await popup.getByLabel("Break between blocks").fill("8");
  await popup.getByRole("spinbutton", { name: "Long break", exact: true }).fill("22");
  await save();
  await expect(popup.getByText("50 → 45 → 30 → 20 → 10 min study")).toBeVisible();
  await backToTimer();
  await popup.getByRole("combobox", { name: "Timing mode" }).selectOption("cascade");
  for (const time of ["50:00", "08:00", "45:00", "08:00", "30:00", "08:00", "20:00", "08:00", "10:00", "22:00", "50:00"]) {
    await expect(popup.getByRole("timer")).toHaveText(time);
    await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    if (time === "22:00") await expect(popup.locator("#phase")).toHaveText("Long break");
    await popup.getByRole("button", { name: "Skip current phase" }).click();
  }
  const stored = await popup.evaluate(async () => (await chrome.storage.local.get("timebit")).timebit);
  assert.equal(stored.timer.completedStudyBlocks, 0);
  assert.deepEqual(errors, []);
});

test("popup controls and storage changes stay in sync across simultaneous views", async () => {
  const second = await openPopup();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(second.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await expect.poll(badgeText).toBe("25");
  await second.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect(popup.locator("#phase")).toContainText("Paused");
  await expect.poll(badgeText).toBe("Ⅱ");
  const title = await popup.evaluate(() => chrome.action.getTitle({}));
  assert.match(title, /study paused · [0-9]+:[0-9]{2} left/);
  await popup.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(second.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await second.getByRole("button", { name: "Reset current phase" }).click();
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await expect(popup.getByRole("timer")).toHaveText("25:00");
  await expect.poll(badgeText).toBe("");
  assert.deepEqual(errors, []);
});

test("a short study enters overtime with an empty ring and starts the queued break on demand", async () => {
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.035");
  await save();
  await backToTimer();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  await expect(popup.locator("#progress")).toHaveCSS("visibility", "hidden");
  const heading = popup.getByRole("heading", { name: "Study block complete" });
  await expect(heading).toBeVisible();
  assert.equal(await heading.evaluate(async (element) => {
    const { fontWeight, fontSize } = getComputedStyle(element);
    const [font] = await document.fonts.load(`${fontWeight} ${fontSize} "Libre Baskerville"`, element.textContent);
    return font?.status;
  }), "loaded");
  await expect(popup.locator("#study-today")).toHaveText("Today · 2 sec studied");
  const oldCountdown = await popup.getByRole("timer").textContent();
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await popup.close();
  popup = await openPopup();
  await expect(popup.locator("#phase")).toHaveText("Next: Short break · 05:00");
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  await expect(popup.getByRole("timer")).not.toHaveText(oldCountdown);
  const stored = await popup.evaluate(async () => (await chrome.storage.local.get("timebit")).timebit.timer);
  assert.equal(stored.completedStudyBlocks, 1);
  assert.equal(stored.endsAt, null);
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await expect(popup.locator("#overtime-label")).toBeHidden();
  await expect(popup.getByRole("timer")).toHaveText(/^0[45]:\d{2}$/);
  assert.deepEqual(errors, []);
});

test("a background alarm wakes a stopped worker, plays the chime, and falls back to a notification", async () => {
  await soundSettings();
  await popup.getByRole("checkbox", { name: "Open study check-in" }).uncheck();
  await popup.getByRole("slider", { name: "Volume" }).fill("62");
  await expect(popup.getByRole("slider", { name: "Volume" })).toBeEnabled();
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.12");
  await save();
  await backToTimer();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const workerUrl = new URL("../background/service-worker.js", popupUrl).href;
  const workerTarget = await workerTargetFor(workerUrl);
  assert.ok(workerTarget);
  await popup.close();
  await cdp.send("Target.closeTarget", { targetId: workerTarget.targetId });
  await expect.poll(() => workerTargetFor(workerUrl), { timeout: 4_000 }).toBeUndefined();
  assert.equal((await readStoredTimer()).status, "running");
  await expect.poll(readStoredTimer, { timeout: 40_000 }).toMatchObject({
    status: "ready",
    phase: "shortBreak",
    completedStudyBlocks: 1,
    endsAt: null,
  });
  await expect.poll(badgeText).toBe("0");
  await expect.poll(notificationIds).toContain(COMPLETION_NOTIFICATION);
  await expect.poll(readChime).toMatchObject({ volume: 0.62, played: true, duration: 1.1 });
  assert.deepEqual(await toolbarPopups(), []);
  popup = await openPopup();
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
});

test("the toolbar restores its route until a pending check-in takes priority after dismissal", async () => {
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.12");
  await save();
  const page = await storageObserver();
  await popup.close();

  const showPopup = () => page.evaluate(() => chrome.action.openPopup());
  const currentView = () => evaluateDocument(popupUrl, "document.querySelector('[data-view]:not([hidden])')?.dataset.view");
  const dismissPopup = async () => {
    const target = await findDocument(popupUrl);
    assert.ok(target);
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
    await expect.poll(toolbarPopups).toHaveLength(0);
  };

  await showPopup();
  await expect.poll(currentView).toBe("timer");
  await evaluateDocument(popupUrl, "document.querySelector('.gear').click()");
  await expect.poll(currentView).toBe("settings");
  await evaluateDocument(popupUrl, "document.querySelector('[data-page=notifications]').click()");
  await expect.poll(currentView).toBe("notifications");
  await expect.poll(() => page.evaluate(async (key) => (await chrome.storage.session.get(key))[key]?.route, POPUP_ROUTE_KEY))
    .toBe("notifications");
  await dismissPopup();

  await showPopup();
  await expect.poll(currentView).toBe("notifications");
  await page.evaluate(async (id) => {
    const { openTimerFromNotification } = await import(chrome.runtime.getURL("background/feedback.js"));
    await openTimerFromNotification(chrome, id);
  }, COMPLETION_NOTIFICATION);
  await expect.poll(currentView).toBe("timer");
  await evaluateDocument(popupUrl, "document.querySelector('.gear').click()");
  await expect.poll(() => page.evaluate(async (key) => (await chrome.storage.session.get(key))[key]?.route, POPUP_ROUTE_KEY))
    .toBe("settings");
  await dismissPopup();

  const started = await page.evaluate(async () => {
    const send = (command) => chrome.runtime.sendMessage({ app: "timebit", command });
    const { state } = await send({ type: "state.get" });
    return send({ type: "timer.start", expectedRevision: state.revision });
  });
  assert.equal(started.state.timer.status, "running");
  await expect.poll(toolbarPopups, { timeout: 20_000 }).toHaveLength(1);
  await expect.poll(currentView).toBe("timer");
  await expect.poll(() => evaluateDocument(popupUrl, "document.querySelector('#check-in-heading').hidden")).toBe(false);
  await expect.poll(() => evaluateDocument(popupUrl, "document.querySelector('#countdown').textContent")).toMatch(overtime);
  assert.deepEqual(await notificationIds(), []);
  await expect.poll(readStoredTimer).toMatchObject({ phase: "shortBreak", status: "ready", endsAt: null });
  await dismissPopup();
  await showPopup();
  await expect.poll(() => evaluateDocument(popupUrl, "document.querySelector('#check-in-heading').hidden")).toBe(false);
  await expect.poll(() => evaluateDocument(popupUrl, "document.querySelector('#countdown').textContent")).toMatch(overtime);
  assert.equal((await readStoredTimer()).status, "ready");
  await dismissPopup();
});

test("the chime previews at the selected volume and mute and check-in preferences persist", async () => {
  await soundSettings();
  const volume = popup.getByRole("slider", { name: "Volume" });
  const mute = popup.getByRole("checkbox", { name: "Mute sounds" });
  const checkIn = popup.getByRole("checkbox", { name: "Open study check-in" });
  const preview = popup.getByRole("button", { name: "Preview chime" });
  await expect(volume).toHaveValue("35");
  await volume.fill("71");
  await expect(volume).toHaveAttribute("aria-valuetext", "71%");
  await preview.click();
  await expect.poll(readChime).toMatchObject({ volume: 0.71, played: true, duration: 1.1 });
  await mute.check();
  await expect(preview).toBeDisabled();
  await checkIn.uncheck();
  await expect(checkIn).toBeEnabled();
  await popup.close();
  popup = await openPopup();
  await soundSettings();
  await expect(popup.getByRole("slider", { name: "Volume" })).toHaveValue("71");
  await expect(popup.getByRole("checkbox", { name: "Mute sounds" })).toBeChecked();
  await expect(popup.getByRole("button", { name: "Preview chime" })).toBeDisabled();
  await expect(popup.getByRole("checkbox", { name: "Open study check-in" })).not.toBeChecked();
  assert.deepEqual(errors, []);
});

test("the countdown badge drops at the minute boundary while the popup is closed", async () => {
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("1.05");
  await save();
  await backToTimer();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(badgeText).toBe("2");
  await popup.close();
  await expect.poll(badgeText, { timeout: 40_000 }).toBe("1");
});

test("the notification setting persists and suppresses desktop alerts", async () => {
  await soundSettings();
  const option = popup.getByRole("checkbox", { name: "Completion notifications" });
  await expect(option).toBeChecked();
  await option.uncheck();
  await expect.poll(() => popup.evaluate(async () => {
    const { timebit } = await chrome.storage.local.get("timebit");
    return timebit?.settings.completionNotifications;
  })).toBe(false);
  await popup.close();
  popup = await openPopup();
  await soundSettings();
  await expect(popup.getByRole("checkbox", { name: "Completion notifications" })).not.toBeChecked();
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.035");
  await save();
  await backToTimer();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(badgeText).toBe("0");
  assert.deepEqual(await notificationIds(), []);
});

test("a muted study and break preserve tasks, and break completion exposes only the next study", async () => {
  await soundSettings();
  await popup.getByRole("checkbox", { name: "Mute sounds" }).check();
  await popup.getByRole("checkbox", { name: "Open study check-in" }).uncheck();
  await expect(popup.getByRole("checkbox", { name: "Open study check-in" })).toBeEnabled();
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.035");
  await popup.getByLabel("Short break", { exact: true }).fill("0.035");
  await save();
  await restartWithoutAlarms();
  popup = await openPopup();

  await popup.getByRole("textbox", { name: "New task" }).fill("Review joins");
  await popup.getByRole("button", { name: "Add task" }).click();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("heading", { name: "Study block complete" })).toBeVisible();
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  const studied = await popup.locator("#study-today").textContent();
  await expect.poll(notificationIds).toContain(COMPLETION_NOTIFICATION);
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  assert.equal(await readChime(), undefined);
  await popup.getByRole("checkbox", { name: "Review joins" }).check();
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await popup.close();
  popup = await openPopup();
  await expect(popup.getByRole("heading", { name: "Study block complete" })).toBeVisible();
  await expect(popup.getByRole("checkbox", { name: "Review joins" })).toBeChecked();

  await soundSettings();
  await popup.getByRole("checkbox", { name: "Open study check-in" }).check();
  await expect(popup.getByRole("checkbox", { name: "Open study check-in" })).toBeEnabled();
  await backToTimer();
  await popup.evaluate((id) => chrome.notifications.clear(id), COMPLETION_NOTIFICATION);
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(readStoredTimer).toMatchObject({ phase: "study", status: "ready", completedStudyBlocks: 1, endsAt: null });
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  await expect(popup.locator("#phase")).toHaveText(/^Next: Focus/);
  await expect(popup.locator("#study-today")).toHaveText(studied);
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await expect(popup.getByRole("heading", { name: "Study block complete" })).toBeHidden();
  await expect(popup.getByRole("checkbox", { name: "Review joins" })).toBeChecked();
  await expect.poll(notificationIds).toContain(COMPLETION_NOTIFICATION);
  assert.equal(await readChime(), undefined);
  assert.deepEqual(await toolbarPopups(), []);
  assert.deepEqual(errors, []);
});

test("reloading Timebit after restarting Chrome completes an overdue run with no alarms", async () => {
  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.07");
  await save();
  await backToTimer();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  const { endsAt } = await readStoredTimer();
  await restartWithoutAlarms(endsAt + 100);

  await expect.poll(readStoredTimer, { timeout: 10_000 }).toMatchObject({
    status: "ready",
    phase: "shortBreak",
    endsAt: null,
    expiredAt: endsAt,
    completedStudyBlocks: 1,
  });
  popup = await openPopup();
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  assert.equal((await readStoredTimer()).completedStudyBlocks, 1);
  assert.deepEqual(errors, []);
});

test("reloading Timebit after restarting Chrome restores the alarm for a pending deadline", async () => {
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const beforeRestart = await readStoredTimer();
  await restartWithoutAlarms();
  const page = await storageObserver();

  await expect.poll(
    () => page.evaluate(async (name) => (await chrome.alarms.get(name))?.scheduledTime, PHASE_END_ALARM),
    { timeout: 10_000 },
  ).toBe(beforeRestart.endsAt);
  const refresh = await page.evaluate((name) => chrome.alarms.get(name), BADGE_REFRESH_ALARM);
  assert.equal(refresh.periodInMinutes, 1);
  assert.deepEqual(await readStoredTimer(), beforeRestart);
  assert.deepEqual(errors, []);
});

test("the checklist stays editable across timer, check-in and task manager views and survives a restart", async () => {
  const second = await openPopup();
  await second.getByRole("button", { name: "Manage tasks" }).click();
  await expect(second.getByRole("heading", { name: "Manage tasks" })).toBeVisible();

  const literal = '<img src="missing-image">';
  await popup.getByRole("textbox", { name: "New task" }).fill(literal);
  await popup.getByRole("button", { name: "Add task" }).click();
  await expect(second.getByRole("checkbox", { name: literal })).toBeVisible();
  await expect(second.locator(".task-row img")).toHaveCount(0);
  await second.getByRole("button", { name: `Edit ${literal}` }).click();
  await second.getByRole("textbox", { name: "Task name" }).fill("Read chapter");
  await second.getByRole("button", { name: "Save task" }).click();
  await expect(popup.getByRole("checkbox", { name: "Read chapter" })).toBeVisible();

  await editor("Pomodoro");
  await popup.getByRole("spinbutton", { name: "Study", exact: true }).fill("0.035");
  await save();
  await backToTimer();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("heading", { name: "Study block complete" })).toBeVisible();
  await expect(popup.getByRole("timer")).toHaveText(overtime);
  await popup.getByRole("checkbox", { name: "Read chapter" }).check();
  await expect(second.getByRole("checkbox", { name: "Read chapter" })).toBeChecked();

  await restartWithoutAlarms();
  popup = await openPopup();
  await expect(popup.getByRole("heading", { name: "Study block complete" })).toBeVisible();
  const reading = popup.getByRole("checkbox", { name: "Read chapter" });
  await expect(reading).toBeChecked();
  await reading.uncheck();
  await expect(reading).not.toBeChecked();
  await popup.getByRole("textbox", { name: "New task" }).fill("Take notes");
  await popup.getByRole("button", { name: "Add task" }).click();

  await popup.getByRole("button", { name: "Manage tasks" }).click();
  await popup.getByRole("checkbox", { name: "Take notes" }).check();
  await popup.getByRole("button", { name: "Clear completed" }).click();
  await expect(popup.getByRole("checkbox", { name: "Take notes" })).toHaveCount(0);
  await expect(reading).toBeVisible();

  await popup.getByRole("textbox", { name: "New task" }).fill("Review outline");
  await popup.getByRole("button", { name: "Add task" }).click();
  await popup.getByRole("button", { name: "Delete Review outline" }).click();
  await expect(popup.getByRole("checkbox", { name: "Review outline" })).toHaveCount(0);
  const clearAll = popup.getByRole("button", { name: "Clear all", exact: true });
  await clearAll.click();
  const confirm = popup.getByRole("dialog", { name: "Clear all tasks?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(reading).toBeVisible();
  await clearAll.click();
  await confirm.getByRole("button", { name: "Clear all tasks" }).click();
  await expect(reading).toHaveCount(0);
  await popup.getByRole("button", { name: "Timer", exact: false }).click();
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
});

test("finish-by form validates today's deadline and uses mode-specific preferences", async () => {
  await popup.evaluate(() => {
    const now = new Date(2026, 10, 24, 15, 30).getTime();
    Date.now = () => now;
  });
  await popup.getByRole("combobox", { name: "Timing mode" }).selectOption("planner");
  await expect(popup.getByRole("heading", { name: "Plan your time" })).toBeFocused();
  const finish = popup.getByLabel("Finish by");
  await expect(finish).toHaveValue("");
  await finish.fill("15:00");
  await popup.getByRole("button", { name: "Use this plan" }).click();
  await expect(popup.locator("#plan-error")).toHaveText("Choose a finish time later today.");
  await expect(finish).toBeFocused();
  await finish.fill("17:00");
  await expect(popup.locator("#plan-available")).toHaveText("90 min available");
  await expect(popup.locator("#plan-summary")).toHaveText("3 study blocks · 1 hr 20 min study · 10 min breaks");
  const mode = popup.getByRole("combobox", { name: "Timing mode" });
  await mode.selectOption("cascade");
  await expect(popup.getByRole("spinbutton", { name: "Study", exact: true })).toHaveValue("50");
  const shortBreak = popup.getByLabel("Break", { exact: true });
  await expect(shortBreak).toHaveValue("10");
  await shortBreak.fill("0");
  await popup.getByRole("button", { name: "Use this plan" }).click();
  await expect(popup.locator("#plan-error")).toHaveText("Enter a duration of at least one minute.");
  await expect(shortBreak).toBeFocused();
  await popup.getByRole("button", { name: "Back to timer" }).click();
  await expect(popup.getByRole("timer")).toHaveText("25:00");
  assert.deepEqual(errors, []);
});

test("a finish-by plan starts manually, survives a Chrome restart, and completes with overtime", async (t) => {
  const deadline = await popup.evaluate(() => {
    const finishAt = Math.ceil((Date.now() + 4 * 60_000) / 60_000) * 60_000;
    const finish = new Date(finishAt);
    if (finish.getDate() !== new Date().getDate()) return null;
    const time = [finish.getHours(), finish.getMinutes()].map((value) => String(value).padStart(2, "0")).join(":");
    return { finishAt, time };
  });
  if (!deadline) {
    t.skip("This same-day browser test needs four minutes before midnight.");
    return;
  }
  const { finishAt, time } = deadline;
  await gear().click();
  await popup.getByRole("button", { name: "Plan your time" }).click();
  await popup.getByLabel("Finish by").fill(time);
  await expect(popup.locator("#plan-summary")).toContainText("1 study block");
  await popup.getByRole("button", { name: "Use this plan" }).click();
  await expect(popup.getByRole("combobox", { name: "Timing mode" })).toHaveValue("planner");
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  const ready = await readStoredTimer();
  assert.equal(ready.status, "ready");
  assert.equal(ready.endsAt, null);
  const phaseAlarm = () => popup.evaluate(async (name) => (await chrome.alarms.get(name))?.scheduledTime, PHASE_END_ALARM);
  await expect.poll(phaseAlarm).toBe(finishAt);

  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  assert.equal((await readStoredTimer()).endsAt, finishAt);
  await popup.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await restartWithoutAlarms();
  popup = await openPopup();
  await expect(popup.getByRole("combobox", { name: "Timing mode" })).toHaveValue("planner");
  await expect(popup.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect.poll(phaseAlarm).toBe(finishAt);
  await popup.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  assert.equal((await readStoredTimer()).endsAt, finishAt);

  // Put the saved final phase and deadline in the past to simulate browser downtime.
  await restartWithoutAlarms(0, (page) => page.evaluate(async () => {
    const { timebit } = await chrome.storage.local.get("timebit");
    const endsAt = Date.now() - 5_000;
    await chrome.storage.local.set({
      timebit: {
        ...timebit, revision: timebit.revision + 1,
        timer: { ...timebit.timer, endsAt, studyStartedAt: endsAt - 60_000 },
        planner: { ...timebit.planner, finishAt: endsAt },
        settings: { ...timebit.settings, openStudyCheckIn: false },
      },
    });
  }));
  const final = await openPopup();
  await expect(final.getByText("Plan complete", { exact: true })).toBeVisible();
  await expect(final.getByRole("heading", { name: "Study block complete" })).toBeVisible();
  await expect(final.getByRole("timer")).toHaveText(overtime);
  await expect(final.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
  await expect(final.getByRole("button", { name: "New plan" })).toBeVisible();
  await expect.poll(notificationIds).toContain(COMPLETION_NOTIFICATION);
  await expect.poll(readStoredTimer).toMatchObject({ status: "finished", completedStudyBlocks: 1 });
  assert.deepEqual(errors, []);
});

test("checklist actions are preserved while an earlier save is still pending", async () => {
  for (const task of ["Read chapter", "Take notes"]) {
    await popup.getByRole("textbox", { name: "New task" }).fill(task);
    await popup.getByRole("button", { name: "Add task" }).click();
    await expect(popup.getByRole("checkbox", { name: task })).toBeVisible();
  }

  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    const firstSave = new Promise((resolve) => { window.releaseTaskSave = resolve; });
    chrome.runtime.sendMessage = async (message) => {
      if (message.command?.type === "tasks.setCompleted") await firstSave;
      return send(message);
    };
  });
  const readChapter = popup.getByRole("checkbox", { name: "Read chapter" });
  await readChapter.check();
  await popup.getByRole("button", { name: "Delete Take notes" }).click();
  await popup.evaluate(() => window.releaseTaskSave());

  const second = await openPopup();
  await expect(second.getByRole("checkbox", { name: "Read chapter" })).toBeChecked();
  await expect(second.getByRole("checkbox", { name: "Take notes" })).toHaveCount(0);
  assert.deepEqual(errors, []);
});

async function distractionSettings() {
  await gear().click();
  await popup.getByRole("button", { name: "Distraction sites" }).click();
}

test("saved presets and custom sites work even when Chrome denies permission", async () => {
  await popup.evaluate(() => {
    chrome.permissions.request = async (requested) => {
      window.requestedSites = requested.origins;
      return false;
    };
  });
  await distractionSettings();
  await expect(popup.getByRole("list", { name: "Distraction sites" }).getByRole("listitem")).toHaveCount(3);
  await popup.getByRole("button", { name: "Remove youtube.com" }).click();
  await expect(popup.getByText("youtube.com", { exact: true })).toHaveCount(0);
  await popup.getByRole("button", { name: "Add YouTube" }).click();
  await expect(popup.getByText("youtube.com", { exact: true })).toBeVisible();
  const input = popup.getByRole("textbox", { name: "Add a website" });
  await input.fill("https://VIDEO.localhost/path");
  await popup.getByRole("button", { name: "Add site" }).click();
  await expect(popup.getByText("video.localhost", { exact: true })).toBeVisible();
  await popup.getByRole("checkbox", { name: "Block distractions" }).check();
  await expect(popup.getByRole("button", { name: "Grant access to video.localhost" })).toBeVisible();
  await expect(popup.locator("#distraction-message")).toContainText("stay unblocked");
  assert.deepEqual((await popup.evaluate(() => window.requestedSites)).sort(),
    ["*://*.instagram.com/*", "*://*.reddit.com/*", "*://*.video.localhost/*", "*://*.youtube.com/*"]);
  await backToTimer();
  await expect(popup.getByRole("checkbox", { name: "Block distractions" })).toBeChecked();
  await expect(popup.getByRole("button", { name: "Manage site access" })).toBeVisible();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  assert.deepEqual(await popup.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), []);
  assert.deepEqual(errors, []);
});

test("Chrome redirects granted main-frame visits during study and removes blocking on transitions", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(`
        self.addEventListener("install", () => self.skipWaiting());
        self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
        self.addEventListener("fetch", (event) => {
          if (new URL(event.request.url).pathname === "/offline") {
            event.respondWith(new Response("<h1>Service worker page</h1>", { headers: { "Content-Type": "text/html" } }));
          }
        });
      `);
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Original page</h1>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = (host, path = "/") => `http://${host}:${server.address().port}${path}`;

  // Headless Chrome leaves the native permission prompt pending. Give only the test
  // domains to a temporary extension copy so Chrome runs the actual request rules.
  const fixture = await mkdtemp(join(tmpdir(), "timebit-hosts-"));
  t.after(async () => {
    await context?.close();
    await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
  });
  await cp(extensionPath, fixture, { recursive: true });
  const manifestPath = join(fixture, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["*://*.video.localhost/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  loadedExtensionPath = fixture;
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: loadedExtensionPath });
  popupUrl = `chrome-extension://${id}/popup/popup.html`;
  const blockedUrl = `chrome-extension://${id}/redirect/index.html#video.localhost`;
  popup = await openPopup();
  await popup.evaluate(async () => {
    const send = (command) => chrome.runtime.sendMessage({ app: "timebit", command });
    const { state } = await send({ type: "state.get" });
    await send({ type: "mode.save", mode: "pomodoro", expectedRevision: state.revision,
      values: { study: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 1 } });
    await send({ type: "distractions.add", domain: "video.localhost" });
    await send({ type: "distractions.set", enabled: true });
  });
  await popup.getByRole("textbox", { name: "New task" }).fill("Review notes");
  await popup.getByRole("button", { name: "Add task" }).click();

  const allowed = await context.newPage();
  await allowed.goto(url("notvideo.localhost"));
  const existing = await context.newPage();
  await existing.goto(url("video.localhost"));
  await existing.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await existing.goto(url("video.localhost", "/offline"));
  await expect(existing.getByRole("heading", { name: "Service worker page" })).toBeVisible();
  await allowed.bringToFront();
  await popup.evaluate(async () => {
    const send = (command) => chrome.runtime.sendMessage({ app: "timebit", command });
    const { state } = await send({ type: "state.get" });
    await send({ type: "timer.start", expectedRevision: state.revision });
  });
  await expect(existing).toHaveURL(blockedUrl);
  await expect(existing.getByRole("heading", { name: "Don’t give up." })).toBeVisible();
  await expect(existing.getByRole("timer")).toHaveText(/^2[34]:\d\d$|^25:00$/);
  await existing.getByRole("checkbox", { name: "Review notes" }).check();
  await expect(popup.getByRole("checkbox", { name: "Review notes" })).toBeChecked();
  await existing.getByRole("button", { name: "Return to study" }).click();
  await expect.poll(() => allowed.evaluate(() => document.visibilityState)).toBe("visible");
  assert.equal(allowed.url(), url("notvideo.localhost"));

  const fresh = await context.newPage();
  const response = await fresh.goto(url("sub.video.localhost", "/visit"));
  assert.equal(response.request().redirectedFrom()?.url(), url("sub.video.localhost", "/visit"));
  await expect(fresh).toHaveURL(blockedUrl);
  await fresh.goto(url("video.localhost", "/offline"), { waitUntil: "commit" }).catch(() => {});
  await expect(fresh).toHaveURL(blockedUrl);

  await popup.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(existing.getByRole("heading", { name: "Keep going." })).toBeVisible();
  await fresh.goto(url("sub.video.localhost"));
  await expect(fresh.getByRole("heading", { name: "Original page" })).toBeVisible();
  const history = await context.newPage();
  await history.goto(url("video.localhost", "/cached"));
  await history.goto(url("notvideo.localhost"));
  await popup.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(fresh).toHaveURL(blockedUrl);
  await history.goBack({ waitUntil: "commit" }).catch((error) => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await expect(history).toHaveURL(blockedUrl);

  // During browser downtime the live study expires. Its long break must remain
  // unblocked, as do the waiting state and the next running break.
  await restartWithoutAlarms(0, (page) => page.evaluate(async () => {
    const { timebit } = await chrome.storage.local.get("timebit");
    await chrome.storage.local.set({
      timebit: { ...timebit, timer: { ...timebit.timer, endsAt: Date.now() - 100 },
        settings: { ...timebit.settings, openStudyCheckIn: false } },
    });
  }));
  popup = await openPopup();
  await expect(popup.getByText(/Next: Long break/)).toBeVisible();
  assert.deepEqual(await popup.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), []);
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  const next = await context.newPage();
  await next.goto(url("video.localhost"));
  await expect(next.getByRole("heading", { name: "Original page" })).toBeVisible();
  await popup.getByRole("button", { name: "Skip current phase" }).click();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(next).toHaveURL(blockedUrl);
  await distractionSettings();
  await popup.getByRole("button", { name: "Remove video.localhost" }).click();
  await expect(next.getByRole("heading", { name: "Keep going." })).toBeVisible();
  await next.goto(url("video.localhost"));
  await expect(next.getByRole("heading", { name: "Original page" })).toBeVisible();
  assert.deepEqual(errors, []);
});
