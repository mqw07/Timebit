import { MINUTE_MS, PHASE_NAMES } from "../core/modes.js";
import { POPUP_ROUTE_KEY } from "../core/navigation.js";
import { formatCountdown, remainingMs } from "../core/timer.js";

export const COMPLETION_NOTIFICATION = "timebit:phase-complete";
const POPUP_PATH = "popup/popup.html";

export function toolbarFeedback(timer, now) {
  if (timer.status === "finished") return { text: "0", title: "Timebit · Finish-by plan complete" };
  const remaining = remainingMs(timer, now);
  const time = formatCountdown(remaining);
  const phase = PHASE_NAMES[timer.phase];
  if (timer.status === "running") {
    return { text: String(Math.ceil(remaining / MINUTE_MS)), title: `Timebit · ${phase} · ${time} left` };
  }
  if (timer.status === "paused") {
    return { text: "Ⅱ", title: `Timebit · ${phase} paused · ${time} left` };
  }
  return {
    text: timer.completedPhase ? "0" : "",
    title: `Timebit · ${phase} ready · ${time} · Press Start`,
  };
}

async function updateToolbar(action, timer, now) {
  const { text, title } = toolbarFeedback(timer, now);
  await Promise.all([
    action.setBadgeBackgroundColor({ color: "#F6F8FB" }),
    action.setBadgeTextColor({ color: "#17191D" }),
    action.setBadgeText({ text }),
    action.setTitle({ title }),
  ]);
}

async function notifyCompletion(api, completion) {
  if (await api.notifications.getPermissionLevel() !== "granted") return;
  const next = completion.phase === "study" ? "Study block" : PHASE_NAMES[completion.phase];
  const finished = completion.completedPhase === "study" ? "Study block" : PHASE_NAMES[completion.completedPhase];
  await api.notifications.create(COMPLETION_NOTIFICATION, {
    type: "basic",
    iconUrl: api.runtime.getURL("assets/icon-128.png"),
    title: `${finished[0].toUpperCase()}${finished.slice(1)} complete`,
    message: completion.status === "finished" ? "Your finish-by plan has ended."
      : `${next[0].toUpperCase()}${next.slice(1)} is ready. Open Timebit to start it.`,
  });
}

function toolbarPopups(api) {
  return api.runtime.getContexts({
    contextTypes: ["POPUP"], documentUrls: [api.runtime.getURL(POPUP_PATH)],
  });
}

async function openStudyCheckIn(api) {
  try {
    const window = await api.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!window?.focused || !Number.isInteger(window.id) || window.id < 0 || window.state === "minimized") return false;
    if (!(await toolbarPopups(api)).length) await api.action.openPopup({ windowId: window.id });
    return true;
  } catch {
    return false;
  }
}

async function showCompletion(api, settings, completion) {
  if (completion.completedPhase === "study" && settings.openStudyCheckIn !== false && await openStudyCheckIn(api)) return;
  if (settings.completionNotifications !== false) await notifyCompletion(api, completion);
}

export async function publishTimerFeedback(api, state, { now, completion }, playChime = async () => {}) {
  const updates = [updateToolbar(api.action, state.timer, now)];
  if (completion) {
    updates.push(showCompletion(api, state.settings, completion));
    if (completion.completedPhase === "study") updates.push(playChime(state.settings));
  }
  for (const result of await Promise.allSettled(updates)) {
    if (result.status === "rejected") console.warn("Timebit could not display timer feedback.", result.reason);
  }
}

export async function openTimerFromNotification(api, id) {
  if (id !== COMPLETION_NOTIFICATION) return;
  try {
    await api.storage.session.set({
      [POPUP_ROUTE_KEY]: { route: "timer", notificationRequest: crypto.randomUUID() },
    });
    if (!(await toolbarPopups(api)).length) await api.action.openPopup();
  } catch {
    await api.tabs.create({ url: api.runtime.getURL(POPUP_PATH) });
  }
}
