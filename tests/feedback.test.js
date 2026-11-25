import assert from "node:assert/strict";
import test from "node:test";
import { COMPLETION_NOTIFICATION, openTimerFromNotification, publishTimerFeedback, toolbarFeedback } from "../extension/background/feedback.js";
import { applyCommand, createInitialState, reconcile } from "../extension/core/timer.js";
import { POPUP_ROUTE_KEY } from "../extension/core/navigation.js";

const now = 10_000;

test("toolbar rounds up running minutes and uses the same seconds as the popup", () => {
  const { state } = applyCommand(createInitialState(), { type: "timer.start" }, now);
  assert.equal(toolbarFeedback(state.timer, now).text, "25");
  assert.equal(toolbarFeedback(state.timer, now + 59_999).text, "25");
  assert.deepEqual(toolbarFeedback(state.timer, now + 60_000), {
    text: "24", title: "Timebit · study · 24:00 left",
  });
  assert.equal(toolbarFeedback(state.timer, state.timer.endsAt - 1).text, "1");
});

test("the pause marker and completion zero clear after starting, skipping or resetting", () => {
  const ready = createInitialState();
  assert.equal(toolbarFeedback(ready.timer, now).text, "");
  const running = applyCommand(ready, { type: "timer.start" }, now).state;
  const elapsed = now + 75_000;
  const paused = applyCommand(running, { type: "timer.pause" }, elapsed).state;
  assert.deepEqual(toolbarFeedback(paused.timer, elapsed + 90_000), {
    text: "Ⅱ", title: "Timebit · study paused · 23:45 left",
  });

  const deadline = running.timer.endsAt;
  const completed = reconcile(running, deadline);
  assert.deepEqual(toolbarFeedback(completed.timer, deadline), {
    text: "0", title: "Timebit · short break ready · 05:00 · Press Start",
  });
  const edited = applyCommand(completed, {
    type: "mode.save", mode: "pomodoro", values: { ...ready.settings.pomodoro, shortBreak: 4 },
  }, deadline).state;
  assert.equal(toolbarFeedback(edited.timer, deadline).text, "0");
  assert.equal(toolbarFeedback(applyCommand(completed, { type: "timer.start" }, deadline).state.timer, deadline).text, "5");
  for (const type of ["timer.skip", "timer.reset"]) {
    const next = applyCommand(completed, { type }, deadline).state;
    assert.equal(toolbarFeedback(next.timer, deadline).text, "");
  }
});

function mockFeedback() {
  const alerts = [];
  const popups = [];
  const api = {
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
      async setBadgeText() {},
      async setTitle() {},
      async openPopup(options) { popups.push(options); },
    },
    windows: { async getLastFocused() { return { id: 11, focused: false, state: "normal" }; } },
    notifications: {
      async getPermissionLevel() { return "granted"; },
      async create(...args) { alerts.push(args); },
    },
    runtime: {
      getURL: (path) => `chrome-extension://timebit/${path}`,
      async getContexts() { return []; },
    },
  };
  return { api, alerts, popups };
}

test("notifications respect preferences and OS permission and describe the next phase", async () => {
  const { api, alerts, popups } = mockFeedback();
  const state = createInitialState();
  const completion = { completedPhase: "study", phase: "longBreak" };
  await publishTimerFeedback(api, state, { now, completion });
  assert.equal(alerts[0][0], COMPLETION_NOTIFICATION);
  assert.equal(alerts[0][1].title, "Study block complete");
  assert.match(alerts[0][1].message, /Long break is ready/);
  await publishTimerFeedback(api, state, { now, completion: { completedPhase: "longBreak", phase: "study" } });
  assert.equal(alerts[1][1].title, "Long break complete");
  assert.match(alerts[1][1].message, /Study block is ready/);
  const disabled = applyCommand(state, { type: "notifications.set", enabled: false }, now).state;
  await publishTimerFeedback(api, disabled, { now, completion });
  api.notifications.getPermissionLevel = async () => "denied";
  await publishTimerFeedback(api, state, { now, completion });
  await publishTimerFeedback(api, state, { now, completion: null });
  assert.equal(alerts.length, 2);
  assert.equal(popups.length, 0);
});

test("study check-ins open only in focused Chrome and fall back when popup opening fails", async () => {
  const { api, alerts, popups } = mockFeedback();
  const state = createInitialState();
  const completion = { completedPhase: "study", phase: "shortBreak" };
  const sounds = [];
  const playChime = async (settings) => sounds.push(settings.soundVolume);
  api.windows.getLastFocused = async () => ({ id: 11, focused: true, state: "normal" });
  await publishTimerFeedback(api, state, { now, completion }, playChime);
  assert.deepEqual(popups, [{ windowId: 11 }]);
  assert.equal(alerts.length, 0);

  api.runtime.getContexts = async () => [{ contextType: "POPUP" }];
  await publishTimerFeedback(api, state, { now, completion }, playChime);
  assert.equal(popups.length, 1);
  assert.equal(alerts.length, 0);

  api.runtime.getContexts = async () => [];
  api.action.openPopup = async () => { throw new Error("Chrome could not open the popup"); };
  await publishTimerFeedback(api, state, { now, completion }, playChime);
  assert.equal(alerts.length, 1);

  api.action.openPopup = async (options) => popups.push(options);
  const disabled = applyCommand(state, { type: "check-in.set", enabled: false }, now).state;
  await publishTimerFeedback(api, disabled, { now, completion }, playChime);
  await publishTimerFeedback(api, state, { now, completion: { completedPhase: "longBreak", phase: "study" } }, playChime);
  assert.equal(popups.length, 1);
  assert.equal(alerts.length, 3);
  assert.deepEqual(sounds, [35, 35, 35, 35]);
});

test("clicking a completion alert opens the popup or falls back to the timer tab", async () => {
  let opens = 0;
  const tabs = [];
  const routes = [];
  const api = {
    action: { async openPopup() { assert.equal(routes.at(-1)[POPUP_ROUTE_KEY].route, "timer"); opens += 1; } },
    runtime: { getURL: (path) => `chrome-extension://timebit/${path}`, async getContexts() { return []; } },
    storage: { session: { async set(values) { routes.push(values); } } },
    tabs: { async create(details) { tabs.push(details); } },
  };

  await openTimerFromNotification(api, "other");
  assert.equal(opens, 0);
  assert.equal(routes.length, 0);
  await openTimerFromNotification(api, COMPLETION_NOTIFICATION);
  assert.equal(opens, 1);
  assert.equal(tabs.length, 0);
  api.runtime.getContexts = async () => [{ contextType: "POPUP" }];
  await openTimerFromNotification(api, COMPLETION_NOTIFICATION);
  assert.equal(opens, 1);
  assert.equal(tabs.length, 0);
  assert.notEqual(routes[0][POPUP_ROUTE_KEY].notificationRequest, routes[1][POPUP_ROUTE_KEY].notificationRequest);
  api.runtime.getContexts = async () => [];
  api.action.openPopup = async () => { throw new Error("No active window"); };
  await openTimerFromNotification(api, COMPLETION_NOTIFICATION);
  assert.deepEqual(tabs, [{ url: "chrome-extension://timebit/popup/popup.html" }]);
});
