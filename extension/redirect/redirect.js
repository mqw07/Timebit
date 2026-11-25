import { normalizeDomain, shouldBlock } from "../core/distractions.js";
import { formatCountdown, remainingMs, STATE_KEY } from "../core/timer.js";
import { createChecklists } from "../popup/checklist.js";
import { renderProgress } from "../popup/progress.js";

// This resource accepts public navigations. Only show local tasks in a top-level tab.
if (window.top === window) initialize();

function initialize() {
  const byId = (id) => document.getElementById(id);
  const message = byId("message");
  const domain = normalizeDomain(location.hash.slice(1));
  const renderTasks = createChecklists(send);
  let state;
  let activeSites = [];
  let refreshPending;
  let refreshAgain = false;
  let checkExpiry = false;

  function adopt(next) {
    if (state && (next.revision < state.revision || (next.tasksRevision ?? 0) < (state.tasksRevision ?? 0))) return;
    state = next;
    renderTasks(state.tasks ?? [], state.tasksRevision ?? 0);
    byId("focus-tasks").hidden = false;
  }

  async function send(command, status = message) {
    status.textContent = "";
    try {
      const response = await chrome.runtime.sendMessage({ app: "timebit", command });
      if (response?.state) adopt(response.state);
      if (response?.error || (!response?.state && !response?.ok)) {
        throw new Error(response?.error ?? "Could not reach the timer. Try again.");
      }
      return true;
    } catch (error) {
      status.textContent = error.message;
      return false;
    }
  }

  function render(now) {
    const active = state && shouldBlock(state, now) && activeSites.includes(domain);
    const reason = byId("reason");
    const text = active ? `${domain} is blocked during this study block.` : "This site is available again.";
    if (reason.textContent !== text) reason.textContent = text;
    byId("heading").textContent = active ? "Don’t give up." : "Keep going.";
    byId("focus-time").hidden = !active;
    byId("site-help").hidden = !active;
    if (!active) return;

    const time = remainingMs(state.timer, now);
    const countdown = byId("countdown");
    const formatted = formatCountdown(time);
    if (countdown.textContent !== formatted) countdown.textContent = formatted;
    countdown.toggleAttribute("data-wide", formatted.length > 5);
    renderProgress(byId("progress"), time, state.timer.durationMs);
  }

  async function refresh() {
    if (refreshPending) {
      refreshAgain = true;
      return;
    }
    refreshPending = true;
    try {
      const response = await chrome.runtime.sendMessage({ app: "timebit", command: { type: "state.get" } });
      if (!response?.state || !response.activeBlockedSites) throw new Error("Could not check the study timer. Try again.");
      adopt(response.state);
      activeSites = response.activeBlockedSites;
      checkExpiry = shouldBlock(state, Date.now());
      render(Date.now());
    } catch (error) {
      message.textContent = error.message;
    } finally {
      refreshPending = false;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    }
  }

  byId("return-to-study").addEventListener("click", () => send({ type: "distractions.return" }));
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes[STATE_KEY]?.newValue;
    if (area !== "local" || !next) return;
    const timerChanged = next.revision !== state?.revision;
    adopt(next);
    if (timerChanged) refresh();
  });
  chrome.permissions.onAdded.addListener(refresh);
  chrome.permissions.onRemoved.addListener(refresh);
  window.addEventListener("pageshow", refresh);
  setInterval(() => {
    if (!state) return;
    const now = Date.now();
    render(now);
    if (checkExpiry && !shouldBlock(state, now)) {
      checkExpiry = false;
      refresh();
    }
  }, 250);
  document.body.hidden = false;
  refresh();
}
