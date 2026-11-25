import { createController } from "./controller.js";
import { BADGE_REFRESH_ALARM, PHASE_END_ALARM, syncTimerAlarms } from "./alarms.js";
import { openTimerFromNotification, publishTimerFeedback } from "./feedback.js";
import { createChimePlayer } from "./sound.js";
import { createBlocking } from "./blocking.js";
import { REDIRECT_PATH, webUrl } from "../core/distractions.js";

const playChime = createChimePlayer(chrome);
const blocking = createBlocking(chrome);
const dispatch = createController(chrome.storage.local, {
  syncAlarms: (timer, planFinishAt) => syncTimerAlarms(chrome.alarms, timer, Date.now(), planFinishAt),
  publishFeedback: (state, event) => publishTimerFeedback(chrome, state, event, playChime),
  playChime,
  syncBlocking: blocking.sync,
});

function reconcileTimer(context) {
  // An alarm only wakes the worker. The persisted deadline determines whether the phase ended.
  dispatch({ type: "state.get" }, context).catch((error) => {
    console.error("Timebit could not reconcile its background timer.", error);
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.app !== "timebit") return;

  async function handle() {
    if (message.command?.type !== "distractions.return") return dispatch(message.command);
    const origin = sender.url?.split("#")[0];
    if (origin !== chrome.runtime.getURL(REDIRECT_PATH) || !sender.tab?.id) return { error: "Open the study timer from Timebit." };
    const { state } = await dispatch({ type: "state.get" });
    await blocking.returnToStudy(sender.tab, state);
    return { ok: true };
  }

  handle().then(reply, (error) => {
    console.error("Timebit could not update its state.", error);
    reply({ error: "Timebit could not update its data. Try again." });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === PHASE_END_ALARM || name === BADGE_REFRESH_ALARM) reconcileTimer();
});
chrome.runtime.onStartup.addListener(reconcileTimer);
chrome.runtime.onInstalled.addListener(reconcileTimer);
chrome.permissions.onAdded.addListener(() => reconcileTimer());
chrome.permissions.onRemoved.addListener(() => reconcileTimer());
chrome.tabs.onActivated.addListener(({ tabId }) => reconcileTimer({ tabId, activated: true }));
chrome.tabs.onReplaced.addListener((tabId) => reconcileTimer({ tabId }));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (webUrl(change.url) || (change.status === "complete" && webUrl(tab.url))) reconcileTimer({ tabId });
});
chrome.notifications.onClicked.addListener((id) => {
  openTimerFromNotification(chrome, id).catch((error) => {
    console.warn("Timebit could not open the timer.", error);
  });
});

reconcileTimer();
