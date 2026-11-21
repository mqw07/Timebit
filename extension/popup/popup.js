import { MODE_NAMES, PHASE_NAMES, MINUTE_MS } from "../core/modes.js";
import { nextPhase, remainingMs, STATE_KEY } from "../core/timer.js";

const byId = (id) => document.getElementById(id);
const views = [...document.querySelectorAll("[data-view]")];
const forms = [...document.forms];

let state;
let page = "timer";
let busy = false;
let readAfter = 0;

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

function openPage(nextPage, focus = true) {
  page = nextPage;
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
  for (const view of views) view.hidden = view.dataset.view !== page;
  if (focus) document.querySelector(`[data-view="${page}"] h1, [data-view="${page}"] select`)?.focus();
}

function formatCountdown(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateCountdown(now) {
  const { timer } = state;
  const remaining = remainingMs(timer, now);
  const text = formatCountdown(remaining);
  const countdown = byId("countdown");
  if (countdown.textContent !== text) countdown.textContent = text;
  countdown.toggleAttribute("data-wide", text.length > 5);
  const progress = byId("progress");
  const percent = 100 * remaining / timer.durationMs;
  progress.style.strokeDasharray = percent >= 100 ? "none" : `${percent} 100`;
  progress.style.visibility = percent > 0 ? "visible" : "hidden";
}

function render() {
  const { timer, settings } = state;
  const pomodoro = settings.pomodoro;
  const cascade = settings.cascade;
  const running = timer.status === "running";
  const study = timer.phase === "study";
  const block = timer.mode === "pomodoro"
    ? Math.min(timer.pomodoroCycle + 1, pomodoro.longBreakEvery)
    : timer.cascadeIndex + 1;
  const total = timer.mode === "pomodoro" ? pomodoro.longBreakEvery : cascade.study.length;
  const label = study ? "Focus" : timer.phase === "shortBreak" ? "Short break" : "Long break";
  byId("phase").textContent = `${timer.status === "paused" ? "Paused · " : ""}${label}${study ? ` · Block ${block} of ${total}` : ""}`;
  const upcoming = nextPhase(timer, settings);
  byId("next").textContent = `Next: ${upcoming.durationMs / MINUTE_MS} min ${PHASE_NAMES[upcoming.phase]}`;
  byId("mode").value = timer.mode;
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
  updateCountdown(Date.now());
}

function adopt(next) {
  if (state && next.revision < state.revision) return;
  const first = !state;
  state = next;
  render();
  if (first) openPage("timer", false);
}

async function send(command, form) {
  if (busy) return;
  busy = true;
  const message = byId("message");
  const retry = byId("retry");
  const controls = [...document.querySelectorAll("[data-command], [type=submit], #mode")];
  for (const control of controls) control.disabled = true;
  message.textContent = "";
  retry.hidden = true;
  try {
    const response = await chrome.runtime.sendMessage({ app: "timebit", command });
    if (response?.state) adopt(response.state);
    if (!response?.state) {
      throw new Error(response?.error ?? "The timer is unavailable. Try again.");
    }
    if (response.error) message.textContent = response.error;
    else if (response.errors && form) showErrors(form, response.errors);
    else if (form && page === form.dataset.mode) {
      openPage("modes");
      message.textContent = "Settings saved.";
    }
  } catch (error) {
    message.textContent = error.message || "The timer is unavailable. Try again.";
    retry.hidden = false;
    readAfter = Date.now() + 2_000;
  } finally {
    for (const control of controls) control.disabled = false;
    busy = false;
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
  send({ type: "mode.select", mode: event.target.value, expectedRevision: state.revision });
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
    send({ type: "mode.save", mode, values, expectedRevision: state.revision }, form);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATE_KEY]?.newValue) adopt(changes[STATE_KEY].newValue);
});

setInterval(() => {
  if (state?.timer.status !== "running") return;
  const now = Date.now();
  if (page === "timer") updateCountdown(now);
  if (state.timer.endsAt <= now && now >= readAfter) send({ type: "state.get" });
}, 250);

send({ type: "state.get" });
