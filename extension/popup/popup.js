import { MODE_NAMES, PHASE_NAMES, MINUTE_MS, DEFAULT_SOUND_VOLUME } from "../core/modes.js";
import { POPUP_ROUTE_KEY } from "../core/navigation.js";
import { buildPlanSchedule, createPlanPattern, localFinishTime, validatePlanDraft } from "../core/planner.js";
import { formatStudyDuration, studiedTodayMs } from "../core/study-time.js";
import { formatCountdown, formatOvertime, nextPhase, overtimeMs, remainingMs, STATE_KEY } from "../core/timer.js";
import { createChecklists } from "./checklist.js";
import { createDistractionControls } from "./distractions.js";
import { renderProgress } from "./progress.js";

const byId = (id) => document.getElementById(id);
const views = new Map([...document.querySelectorAll("[data-view]")].map((view) => [view.dataset.view, view]));
const forms = [...document.querySelectorAll("form[data-mode]")];
const plannerForm = byId("planner-form");
const renderChecklists = createChecklists((command, status) => send(command, { status }));
const renderDistractionControls = createDistractionControls((command, options) => send(command, options));

let state;
let page = "timer";
let busy = false;
let pendingCommand;
let readAfter = 0;
let toolbarPopup = false;
let initialRoute = "timer";

function planDraft(now) {
  const { finish, mode, study, shortBreak } = plannerForm.elements;
  return { finishAt: localFinishTime(finish.value, now), mode: mode.value,
    study: study.valueAsNumber, shortBreak: shortBreak.valueAsNumber };
}

function previewPlan(now) {
  const draft = planDraft(now);
  const errors = validatePlanDraft(draft, now);
  const { finish } = errors;
  const budget = draft.finishAt - now;
  byId("plan-available").textContent = finish
    ? (plannerForm.elements.finish.value ? finish : "Choose a finish time later today.")
    : `${Math.floor(budget / MINUTE_MS)} min available`;
  const summary = byId("plan-summary");
  if (Object.keys(errors).length) {
    summary.textContent = "";
    return;
  }
  const pattern = createPlanPattern(draft, state.settings[draft.mode]);
  const studies = buildPlanSchedule(pattern, budget).filter(({ phase }) => phase === "study");
  const studyTime = studies.reduce((total, { durationMs }) => total + durationMs, 0);
  summary.textContent = `${studies.length} study ${studies.length === 1 ? "block" : "blocks"} · ${formatStudyDuration(studyTime)} study · ${formatStudyDuration(budget - studyTime)} breaks`;
}

function loadPlanPreferences() {
  const { mode, study, shortBreak } = plannerForm.elements;
  const settings = state.settings[mode.value];
  study.value = Math.max(1, Array.isArray(settings.study) ? settings.study[0] : settings.study);
  shortBreak.value = Math.max(1, settings.shortBreak);
}

function openPlanner() {
  const { planner, timer } = state;
  const { finish, mode, study, shortBreak } = plannerForm.elements;
  mode.value = timer.mode;
  loadPlanPreferences();
  finish.value = "";
  if (planner) {
    study.value = planner.study;
    shortBreak.value = planner.shortBreak;
    const date = new Date(planner.finishAt);
    const localTime = [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
    if (localFinishTime(localTime, Date.now()) === planner.finishAt && planner.finishAt > Date.now()) finish.value = localTime;
  }
  byId("plan-error").textContent = "";
  previewPlan(Date.now());
}

function addInput(container, mode, name, label, unit, sequence = false) {
  const input = document.createElement("input");
  input.id = `${mode}-${name}`;
  input.name = name;
  input.type = "number";
  input.inputMode = "decimal";
  input.step = name === "longBreakEvery" ? "1" : "any";
  input.required = true;
  const errorId = sequence ? "sequence-error" : `${input.id}-error`;
  input.setAttribute("aria-describedby", errorId);

  if (sequence) {
    input.setAttribute("aria-label", label);
    container.append(input);
    return;
  }

  const row = document.createElement("div");
  row.className = "field";
  const caption = document.createElement("label");
  caption.htmlFor = input.id;
  caption.textContent = label;
  const suffix = document.createElement("span");
  suffix.className = "unit";
  suffix.textContent = unit;
  const error = document.createElement("p");
  error.id = errorId;
  error.className = "field-error";
  error.hidden = true;
  row.append(caption, input, suffix, error);
  container.append(row);
}

for (const form of forms) {
  const mode = form.dataset.mode;
  const fields = form.querySelector("[data-fields]");
  if (mode === "cascade") {
    const sequence = form.querySelector("[data-sequence]");
    for (let index = 0; index < 5; index += 1) {
      addInput(sequence, mode, `study${index}`, `Study block ${index + 1} in minutes`, "", true);
    }
  } else {
    addInput(fields, mode, "study", "Study", "min");
  }
  addInput(fields, mode, "shortBreak", mode === "cascade" ? "Break between blocks" : "Short break", "min");
  addInput(fields, mode, "longBreak", "Long break", "min");
  if (mode === "pomodoro") addInput(fields, mode, "longBreakEvery", "Long break every", "study blocks");
}

function showErrors(form, errors = {}) {
  const inputs = [...form.querySelectorAll("input")];
  let sequenceError = errors.study;
  for (const input of inputs) {
    const error = errors[input.name];
    input.setAttribute("aria-invalid", String(Boolean(error)));
    if (input.name.startsWith("study") && form.dataset.mode === "cascade") {
      if (error && !sequenceError) sequenceError = `Block ${Number(input.name.at(-1)) + 1}: ${error}`;
      continue;
    }
    const message = byId(`${input.id}-error`);
    message.textContent = error ?? "";
    message.hidden = !error;
  }
  if (form.dataset.mode === "cascade") {
    const message = byId("sequence-error");
    message.textContent = sequenceError ?? "";
    message.hidden = !sequenceError;
  }
  inputs.find((input) => input.getAttribute("aria-invalid") === "true")?.focus();
}

function openPage(requestedRoute, { focus = true, remember = true } = {}) {
  const route = views.has(requestedRoute) || requestedRoute === "settings/tasks" ? requestedRoute : "timer";
  const tasksFromSettings = route === "settings/tasks";
  page = tasksFromSettings ? "tasks" : route;
  if (page === "planner") openPlanner();
  if (page === "tasks") {
    const back = byId("tasks-back");
    back.dataset.page = tasksFromSettings ? "settings" : "timer";
    back.setAttribute("aria-label", `Back to ${back.dataset.page}`);
    back.querySelector("span").textContent = tasksFromSettings ? "Settings" : "Timer";
  }
  const form = forms.find((item) => item.dataset.mode === page);
  if (form) {
    const values = state.settings[page];
    for (const input of form.querySelectorAll("input")) {
      input.value = page === "cascade" && input.name.startsWith("study")
        ? values.study[Number(input.name.at(-1))]
        : values[input.name];
    }
    showErrors(form);
  }
  for (const [name, view] of views) view.hidden = name !== page;
  document.body.scrollTop = 0;
  document.scrollingElement.scrollTop = 0;
  if (focus) views.get(page).querySelector("h1:not([hidden]), select")?.focus();

  if (toolbarPopup) {
    if (remember) chrome.storage.session.set({ [POPUP_ROUTE_KEY]: { route } }).catch(() => {});
  } else {
    const url = new URL(location.href);
    url.hash = route === "timer" ? "" : route;
    if (url.href !== location.href) history.replaceState(null, "", url);
  }
}

function openPendingCheckIn() {
  if (page === "timer" || state.timer.completedPhase !== "study" || state.settings.openStudyCheckIn === false) return;
  const dialog = document.querySelector("dialog[open]");
  if (dialog) dialog.addEventListener("close", openPendingCheckIn, { once: true });
  else openPage("timer");
}

function updateTimerDisplay(now) {
  const { timer } = state;
  const overtime = overtimeMs(timer, now);
  const remaining = overtime === null ? remainingMs(timer, now) : 0;
  const text = overtime === null ? formatCountdown(remaining) : formatOvertime(overtime);
  const countdown = byId("countdown");
  if (countdown.textContent !== text) countdown.textContent = text;
  countdown.toggleAttribute("data-wide", text.length > (overtime === null ? 5 : 6));
  renderProgress(byId("progress"), remaining, timer.durationMs);

  const footer = byId("study-today");
  const total = `Today · ${formatStudyDuration(studiedTodayMs(state, now))} studied`;
  if (footer.textContent !== total) footer.textContent = total;
}

function showVolume() {
  const slider = byId("sound-volume");
  const label = `${slider.value}%`;
  slider.style.setProperty("--volume", label);
  slider.setAttribute("aria-valuetext", label);
  byId("sound-volume-value").value = label;
}

function renderFeedbackSettings(settings) {
  const volume = settings.soundVolume ?? DEFAULT_SOUND_VOLUME;
  const muted = settings.soundMuted === true;
  byId("completion-notifications").checked = settings.completionNotifications !== false;
  byId("open-study-check-in").checked = settings.openStudyCheckIn !== false;
  byId("mute-sounds").checked = muted;
  const slider = byId("sound-volume");
  if (!slider.matches(":active")) slider.value = volume;
  showVolume();
  byId("preview-chime").disabled = busy || muted || volume === 0;
}

function render() {
  const { timer, settings, planner } = state;
  const pomodoro = settings.pomodoro;
  const cascade = settings.cascade;
  const running = timer.status === "running";
  const finished = timer.status === "finished";
  const study = timer.phase === "study";
  const block = timer.mode === "pomodoro"
    ? Math.min(timer.pomodoroCycle + 1, pomodoro.longBreakEvery)
    : timer.cascadeIndex + 1;
  const total = timer.mode === "pomodoro" ? pomodoro.longBreakEvery : cascade.study.length;
  const label = study ? "Focus" : timer.phase === "shortBreak" ? "Short break" : "Long break";
  const checkIn = timer.completedPhase === "study";
  const overtime = timer.expiredAt != null;
  byId("check-in-heading").hidden = !checkIn;
  byId("overtime-label").hidden = !overtime;
  const upcoming = planner ? planner.phases[1] : nextPhase(timer, settings);
  byId("next").hidden = checkIn || overtime || !upcoming;
  const skip = document.querySelector('[data-command="timer.skip"]');
  skip.title = checkIn && !study ? "Skip break" : "Skip current phase";
  skip.setAttribute("aria-label", skip.title);
  const blockNumber = planner ? (planner.phases[0]?.index ?? 0) + 1 : block;
  const phase = `${label}${study ? ` · Block ${blockNumber}${planner ? "" : ` of ${total}`}` : ""}`;
  byId("phase").textContent = finished ? "Plan complete"
    : overtime ? `Next: ${phase} · ${formatCountdown(timer.durationMs)}`
      : `${timer.status === "paused" ? "Paused · " : ""}${phase}`;
  const duration = upcoming && (planner ? formatStudyDuration(upcoming.durationMs) : `${upcoming.durationMs / MINUTE_MS} min`);
  byId("next").textContent = upcoming ? `Next: ${duration} ${PHASE_NAMES[upcoming.phase]}` : "";
  byId("mode").value = planner ? "planner" : timer.mode;
  document.querySelector(".timer-controls").hidden = finished;
  byId("plan-info").hidden = !planner;
  const planNotice = byId("plan-adjusted");
  planNotice.hidden = finished ? !planner?.tooLittleTime : !planner?.adjusted;
  planNotice.textContent = finished ? "There is less than a minute left for a new study block." : "Plan adjusted to fit your deadline.";
  byId("edit-plan").textContent = finished ? "New plan" : "Edit plan";
  if (planner) {
    const finish = new Date(planner.finishAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    byId("plan-deadline").textContent = `Finish by ${finish}`;
  }
  const replace = byId("plan-replace");
  replace.hidden = finished || (!planner && timer.status === "ready");
  replace.textContent = planner ? "Applying a new plan replaces the current plan." : "Applying a plan replaces the current timer.";
  renderFeedbackSettings(settings);
  renderDistractionControls(settings);
  byId("primary").dataset.command = running ? "timer.pause" : "timer.start";
  byId("primary-label").textContent = running ? "Pause" : timer.status === "paused" ? "Resume" : "Start";
  byId("play-icon").toggleAttribute("hidden", running);
  byId("pause-icon").toggleAttribute("hidden", !running);

  byId("pomodoro-summary").textContent = `${pomodoro.study} min study · ${pomodoro.shortBreak} min breaks`;
  byId("pomodoro-long").textContent = `${pomodoro.longBreak} min long break every ${pomodoro.longBreakEvery} ${pomodoro.longBreakEvery === 1 ? "block" : "blocks"}`;
  byId("cascade-summary").textContent = `${cascade.study.join(" → ")} min study`;
  byId("cascade-breaks").textContent = `${cascade.shortBreak} min breaks · ${cascade.longBreak} min long break`;
  for (const card of document.querySelectorAll(".mode-card")) {
    const selected = card.dataset.page === timer.mode;
    card.toggleAttribute("data-active", selected);
    const name = MODE_NAMES[card.dataset.page];
    card.setAttribute("aria-label", `Edit ${name} settings${selected ? ", current mode" : ""}`);
  }
  renderChecklists(state.tasks ?? [], state.tasksRevision ?? 0);
  updateTimerDisplay(Date.now());
}

function adopt(next) {
  if (state && (next.revision < state.revision || (next.tasksRevision ?? 0) < (state.tasksRevision ?? 0))) return;
  const first = !state;
  const newCheckIn = next.timer.completedPhase === "study" && next.delivery?.runId !== state?.delivery?.runId;
  state = next;
  render();
  if (first) {
    const readyAfterCompletion = toolbarPopup && Boolean(next.timer.completedPhase);
    const route = readyAfterCompletion ? "timer" : initialRoute;
    openPage(route, { focus: readyAfterCompletion || route !== "timer", remember: false });
  } else if (toolbarPopup && newCheckIn) {
    openPendingCheckIn();
  }
}

async function send(command, options) {
  // An automatic refresh can wait. Preserve deliberate actions taken while a save is in flight.
  if (command.type === "state.get" && pendingCommand) return false;
  const dispatch = () => sendCommand(command, options);
  const pending = pendingCommand ? pendingCommand.then(dispatch, dispatch) : dispatch();
  pendingCommand = pending;
  try {
    return await pending;
  } finally {
    if (pendingCommand === pending) pendingCommand = undefined;
  }
}

async function sendCommand(command, { form, status = byId("message") } = {}) {
  busy = true;
  const retry = byId("retry");
  const volumeFocused = document.activeElement === byId("sound-volume");
  const controls = [...document.querySelectorAll("[data-command], [type=submit], #mode, [data-feedback-setting], [data-block-setting]")];
  for (const control of controls) control.disabled = true;
  status.textContent = "";
  retry.hidden = true;
  try {
    const response = await chrome.runtime.sendMessage({ app: "timebit", command });
    if (response?.state) adopt(response.state);
    if (!response?.state) {
      throw new Error(response?.error ?? "The timer is unavailable. Try again.");
    }
    if (response.error) {
      status.textContent = response.error;
      return false;
    }
    if (response.errors && form) {
      showErrors(form, response.errors);
      return false;
    }
    if (form && page === form.dataset.mode) {
      openPage("modes");
      status.textContent = "Settings saved.";
    }
    if (command.type === "planner.use" && page === "planner") openPage("timer");
    return true;
  } catch (error) {
    status.textContent = error.message || "Timebit is unavailable. Try again.";
    retry.hidden = status !== byId("message");
    readAfter = Date.now() + 2_000;
    return false;
  } finally {
    for (const control of controls) control.disabled = false;
    busy = false;
    if (state) renderFeedbackSettings(state.settings);
    if (volumeFocused && page === "notifications" && document.activeElement === document.body) byId("sound-volume").focus();
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "retry") send({ type: "state.get" });
  else if (state && button.dataset.page) {
    byId("message").textContent = "";
    openPage(button.dataset.page);
  } else if (state && button.dataset.command) {
    send({ type: button.dataset.command, expectedRevision: state.revision });
  }
});

byId("mode").addEventListener("change", (event) => {
  if (event.target.value === "planner") {
    event.target.value = state.planner ? "planner" : state.timer.mode;
    openPage("planner");
    return;
  }
  send({ type: "mode.select", mode: event.target.value, expectedRevision: state.revision });
});

plannerForm.addEventListener("input", () => {
  byId("plan-error").textContent = "";
  previewPlan(Date.now());
});
plannerForm.elements.mode.addEventListener("change", () => {
  loadPlanPreferences();
  previewPlan(Date.now());
});
plannerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const now = Date.now();
  const draft = planDraft(now);
  const [error] = Object.entries(validatePlanDraft(draft, now));
  const status = byId("plan-error");
  if (error) {
    status.textContent = error[1];
    plannerForm.elements.namedItem(error[0]).focus();
    return;
  }
  send({ type: "planner.use", draft, expectedRevision: state.revision }, { status });
});

byId("completion-notifications").addEventListener("change", (event) => {
  send({ type: "notifications.set", enabled: event.target.checked, expectedRevision: state.revision });
});

byId("open-study-check-in").addEventListener("change", (event) => {
  send({ type: "check-in.set", enabled: event.target.checked, expectedRevision: state.revision });
});

byId("mute-sounds").addEventListener("change", (event) => {
  send({ type: "sound.mute", muted: event.target.checked, expectedRevision: state.revision });
});

byId("sound-volume").addEventListener("input", showVolume);
byId("sound-volume").addEventListener("change", (event) => {
  send({ type: "sound.volume", volume: event.target.valueAsNumber, expectedRevision: state.revision });
});

for (const form of forms) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const number = (name) => form.elements.namedItem(name).valueAsNumber;
    const mode = form.dataset.mode;
    const values = {
      study: mode === "cascade" ? Array.from({ length: 5 }, (_, i) => number(`study${i}`)) : number("study"),
      shortBreak: number("shortBreak"),
      longBreak: number("longBreak"),
    };
    if (mode === "pomodoro") values.longBreakEvery = number("longBreakEvery");
    showErrors(form);
    send({ type: "mode.save", mode, values, expectedRevision: state.revision }, { form });
  });
}

window.addEventListener("hashchange", () => {
  if (state && !toolbarPopup) openPage(location.hash.slice(1));
});

setInterval(() => {
  if (!state) return;
  const now = Date.now();
  if (page === "timer") updateTimerDisplay(now);
  if (page === "planner") previewPlan(now);
  const phaseExpired = state.timer.status === "running" && state.timer.endsAt <= now;
  const planExpired = state.planner && state.timer.status !== "finished" && state.planner.finishAt <= now;
  if ((phaseExpired || planExpired) && now >= readAfter) send({ type: "state.get" });
}, 250);

chrome.action.getUserSettings().then(({ isOnToolbar }) => {
  byId("pin-hint").hidden = isOnToolbar;
}).catch(() => {});

async function initialize() {
  try {
    toolbarPopup = !(await chrome.tabs.getCurrent());
    if (toolbarPopup) {
      const { [POPUP_ROUTE_KEY]: saved } = await chrome.storage.session.get(POPUP_ROUTE_KEY);
      initialRoute = saved?.route ?? "timer";
    }
  } catch {
    // The timer stays usable when Chrome cannot restore a popup route.
  }
  if (!toolbarPopup) initialRoute = location.hash.slice(1) || "timer";
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STATE_KEY]?.newValue) adopt(changes[STATE_KEY].newValue);
    if (area === "session" && toolbarPopup && changes[POPUP_ROUTE_KEY]?.newValue?.notificationRequest) {
      initialRoute = "timer";
      if (state && page !== "timer") openPage("timer", { remember: false });
    }
  });
  await send({ type: "state.get" });
}

initialize();
