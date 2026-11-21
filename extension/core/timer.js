import { defaultSettings, isMode, phaseMinutes, toDurationMs, validateModeSettings } from "./modes.js";

export const STATE_KEY = "timebit";

function readyPhase(timer, settings, phase = timer.phase) {
  const next = { ...timer, phase, status: "ready", endsAt: null, pausedRemainingMs: null };
  return { ...next, durationMs: toDurationMs(phaseMinutes(next, settings)) };
}

export function createInitialState() {
  const settings = defaultSettings();
  return {
    schemaVersion: 1,
    revision: 0,
    settings,
    timer: readyPhase({
      mode: settings.selectedMode,
      cascadeIndex: 0,
      pomodoroCycle: 0,
      completedStudyBlocks: 0,
    }, settings, "study"),
  };
}

export function remainingMs(timer, now) {
  if (timer.status === "running") {
    return Math.max(0, Math.min(timer.durationMs, timer.endsAt - now));
  }
  return timer.status === "paused" ? timer.pausedRemainingMs : timer.durationMs;
}

function advance(timer, settings, completed) {
  const finishedStudy = timer.phase === "study" && completed;
  const next = {
    ...timer,
    completedStudyBlocks: timer.completedStudyBlocks + Number(finishedStudy),
  };
  if (timer.mode === "pomodoro") {
    if (timer.phase === "study") {
      next.pomodoroCycle += Number(finishedStudy);
      const phase = next.pomodoroCycle >= settings.pomodoro.longBreakEvery ? "longBreak" : "shortBreak";
      return readyPhase(next, settings, phase);
    }
    if (timer.phase === "longBreak") next.pomodoroCycle = 0;
  } else {
    if (timer.phase === "study") {
      const finalBlock = timer.cascadeIndex === settings.cascade.study.length - 1;
      return readyPhase(next, settings, finalBlock ? "longBreak" : "shortBreak");
    }
    next.cascadeIndex = timer.phase === "longBreak" ? 0 : timer.cascadeIndex + 1;
  }
  return readyPhase(next, settings, "study");
}

export function nextPhase(timer, settings) {
  return advance(timer, settings, true);
}

function update(state, changes) {
  return { ...state, ...changes, revision: state.revision + 1 };
}

export function reconcile(state, now) {
  if (state.timer.status === "running" && state.timer.endsAt <= now) {
    return update(state, { timer: nextPhase(state.timer, state.settings) });
  }
  return state;
}

export function applyCommand(state, command, now) {
  const { timer, settings } = state;
  switch (command.type) {
    case "timer.start":
      if (timer.status === "running") return { state };
      return { state: update(state, {
        timer: { ...timer, status: "running", endsAt: now + remainingMs(timer, now), pausedRemainingMs: null },
      }) };
    case "timer.pause":
      if (timer.status !== "running") return { state };
      return { state: update(state, { timer: {
        ...timer,
        status: "paused",
        endsAt: null,
        pausedRemainingMs: remainingMs(timer, now),
      } }) };
    case "timer.reset":
      return { state: update(state, {
        timer: { ...timer, status: "ready", endsAt: null, pausedRemainingMs: null },
      }) };
    case "timer.skip":
      return { state: update(state, { timer: advance(timer, settings, false) }) };
    case "mode.select": {
      if (!isMode(command.mode)) return { state, error: "Choose a valid timing mode." };
      if (timer.mode === command.mode) return { state };
      const nextSettings = { ...settings, selectedMode: command.mode };
      return { state: update(state, {
        settings: nextSettings,
        timer: readyPhase({
          ...timer, mode: command.mode, cascadeIndex: 0, pomodoroCycle: 0,
        }, nextSettings, "study"),
      }) };
    }
    case "mode.save": {
      const { mode, values } = command;
      const errors = validateModeSettings(mode, values);
      if (Object.keys(errors).length) return { state, errors };
      const { study, shortBreak, longBreak } = values;
      const modeSettings = { study, shortBreak, longBreak };
      if (mode === "pomodoro") modeSettings.longBreakEvery = values.longBreakEvery;
      else modeSettings.study = [...study];
      const nextSettings = { ...settings, [mode]: modeSettings };
      return { state: update(state, {
        settings: nextSettings,
        timer: timer.mode === mode && timer.status === "ready"
          ? readyPhase(timer, nextSettings)
          : timer,
      }) };
    }
    default:
      return { state, error: "Unknown Timebit command." };
  }
}
