import { createController } from "./controller.js";
import { BADGE_REFRESH_ALARM, PHASE_END_ALARM, syncTimerAlarms } from "./alarms.js";

const dispatch = createController(chrome.storage.local, {
  syncAlarms: (timer) => syncTimerAlarms(chrome.alarms, timer),
});

function reconcileTimer() {
  // An alarm only wakes the worker. The persisted deadline determines whether the phase ended.
  dispatch({ type: "state.get" }).catch((error) => {
    console.error("Timebit could not reconcile its background timer.", error);
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.app !== "timebit") return;

  dispatch(message.command).then(reply, (error) => {
    console.error("Timebit could not update its state.", error);
    reply({ error: "Timebit could not update the timer. Try again." });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === PHASE_END_ALARM || name === BADGE_REFRESH_ALARM) reconcileTimer();
});
chrome.runtime.onStartup.addListener(reconcileTimer);
chrome.runtime.onInstalled.addListener(reconcileTimer);

reconcileTimer();
