import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BADGE_REFRESH_ALARM, PHASE_END_ALARM } from "../extension/background/alarms.js";

const require = createRequire(import.meta.url);
const { chromium, expect } = require(process.env.TIMEBIT_PLAYWRIGHT || "playwright/test");
const extensionPath = fileURLToPath(new URL("../extension", import.meta.url));
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
  await expect(page.getByRole("button", { name: /^(Start|Pause|Resume)$/ })).toBeEnabled();
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

async function restartWithoutAlarms(waitUntil = 0) {
  await popup.evaluate(async (names) => {
    await Promise.all(names.map((name) => chrome.alarms.clear(name)));
  }, [PHASE_END_ALARM, BADGE_REFRESH_ALARM]);
  await popup.close();
  await context.close();
  if (waitUntil > Date.now()) await delay(waitUntil - Date.now());
  await launchChrome();
  // Chrome's DevTools-loaded extensions must be loaded again in the restarted browser.
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
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
  await cleanup.evaluate(() => chrome.storage.local.clear());
  await cleanup.close();
  popup = await openPopup();
});

function gear() {
  return popup.getByRole("button", { name: "Timing settings" });
}

async function editor(mode) {
  await gear().click();
  await popup.getByRole("button", { name: `Edit ${mode} settings`, exact: false }).click();
  await expect(popup.getByRole("heading", { name: mode, exact: true })).toBeVisible();
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

test("Pomodoro validates inline, saves custom durations, and restores them when reopened", async () => {
  await editor("Pomodoro");
  await expect(popup.getByRole("spinbutton")).toHaveCount(4);
  await popup.getByLabel("Study", { exact: true }).fill("0");
  await popup.getByLabel("Long break every").fill("2.5");
  await popup.getByRole("button", { name: "Save changes" }).click();
  await expect(popup.getByText("Enter a positive number of minutes.")).toBeVisible();
  await expect(popup.getByText("Enter a whole number of study blocks.")).toBeVisible();
  await popup.getByLabel("Study", { exact: true }).fill("12.5");
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
  await popup.getByRole("button", { name: "Timer", exact: false }).click();
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
  await second.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect(popup.locator("#phase")).toContainText("Paused");
  await popup.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(second.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await second.getByRole("button", { name: "Reset current phase" }).click();
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await expect(popup.getByRole("timer")).toHaveText("25:00");
  assert.deepEqual(errors, []);
});

test("a short real countdown completes once and queues a manual break", async () => {
  await editor("Pomodoro");
  await popup.getByLabel("Study", { exact: true }).fill("0.035");
  await save();
  await popup.getByRole("button", { name: "Timer", exact: false }).click();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(popup.getByRole("timer")).toHaveText("05:00");
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await popup.close();
  popup = await openPopup();
  await expect(popup.locator("#phase")).toHaveText("Short break");
  const stored = await popup.evaluate(async () => (await chrome.storage.local.get("timebit")).timebit.timer);
  assert.equal(stored.completedStudyBlocks, 1);
  assert.equal(stored.endsAt, null);
  assert.deepEqual(errors, []);
});

test("a background alarm completes the timer without reopening the popup", async () => {
  await editor("Pomodoro");
  await popup.getByLabel("Study", { exact: true }).fill("0.025");
  await save();
  await popup.getByRole("button", { name: "Timer", exact: false }).click();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await popup.close();
  await expect.poll(readStoredTimer, { timeout: 40_000 }).toMatchObject({
    status: "ready",
    phase: "shortBreak",
    completedStudyBlocks: 1,
    endsAt: null,
  });
  popup = await openPopup();
  await expect(popup.getByRole("timer")).toHaveText("05:00");
  await expect(popup.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
});

test("reloading Timebit after restarting Chrome completes an overdue run with no alarms", async () => {
  await editor("Pomodoro");
  await popup.getByLabel("Study", { exact: true }).fill("0.07");
  await save();
  await popup.getByRole("button", { name: "Timer", exact: false }).click();
  await popup.getByRole("button", { name: "Start", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  const { endsAt } = await readStoredTimer();
  await restartWithoutAlarms(endsAt + 100);

  await expect.poll(readStoredTimer, { timeout: 10_000 }).toMatchObject({
    status: "ready",
    phase: "shortBreak",
    endsAt: null,
    completedStudyBlocks: 1,
  });
  popup = await openPopup();
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
