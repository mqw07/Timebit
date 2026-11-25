import { defaultSettings, isMode, MINUTE_MS, phaseMinutes, toDurationMs, validateModeSettings } from "./modes.js";
import { applyDistractionCommand } from "./distractions.js";
import { buildPlanSchedule, createPlanPattern, validatePlanDraft } from "./planner.js";
import { activeStudyInterval } from "./study-time.js";

export const STATE_KEY = "timebit";

function readyPhase(timer, settings, phase = timer.phase) {
  const next = { ...timer, phase };
  return readyTimer(next, phase, toDurationMs(phaseMinutes(next, settings)));
}

function readyTimer(timer, phase, durationMs) {
  return {
    ...timer, phase, status: "ready", runId: null,
    endsAt: null, pausedRemainingMs: null, completedPhase: null, expiredAt: null, studyStartedAt: null,
    durationMs,
  };
}

export function createInitialState() {
  const settings = defaultSettings();
  return {
    schemaVersion: 1,
    revision: 0,
    tasksRevision: 0,
    tasks: [],
    studyIntervals: [],
    settings,
    delivery: null,
    planner: null,
    timer: readyPhase({
      mode: settings.selectedMode,
      phaseId: 0,
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

export function formatCountdown(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function overtimeMs(timer, now) {
  return timer.expiredAt == null ? null : Math.max(0, now - timer.expiredAt);
}

export function formatOvertime(milliseconds) {
  return `-${formatCountdown(Math.floor(milliseconds / 1_000) * 1_000)}`;
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

function stopRun(state, timer, now, changes = {}) {
  const interval = activeStudyInterval(state.timer, now);
  const next = { ...changes, timer };
  if (interval) next.studyIntervals = [...(state.studyIntervals ?? []), interval];
  return update(state, next);
}

function queuePlanPhase(timer, phases, phaseId) {
  const next = phases[0];
  const ready = readyTimer({ ...timer, phaseId }, next?.phase ?? timer.phase, next?.durationMs ?? 0);
  return next ? ready : { ...ready, status: "finished" };
}

function refitPlan(planner, first, now, resumeMs = null) {
  if (!first) return { ...planner, phases: [] };
  const budget = planner.finishAt - now;
  const phases = buildPlanSchedule(planner.pattern, budget, first, resumeMs);
  const originalCount = planner.phases.length - planner.phases.indexOf(first);
  const adjusted = planner.adjusted || (
    phases.length !== originalCount ||
    phases[0]?.phase !== first.phase ||
    (resumeMs ?? first.durationMs) - (phases[0]?.durationMs ?? 0) >= MINUTE_MS
  );
  return { ...planner, phases, adjusted, tooLittleTime: budget > 0 && !phases.length };
}

function advancePlan(state, now) {
  const planner = refitPlan(state.planner, state.planner.phases[1], now);
  return { planner, timer: queuePlanPhase(state.timer, planner.phases, state.revision + 1) };
}

function startTimer(state, now) {
  const { timer } = state;
  if (timer.status === "running" || timer.status === "finished") return state;

  let planner = state.planner;
  let duration = remainingMs(timer, now);
  if (planner) {
    const first = planner.phases[0];
    planner = refitPlan(planner, first, now, timer.status === "paused" ? duration : null);
    if (!planner.phases.length || planner.phases[0].phase !== timer.phase) {
      const next = queuePlanPhase(timer, planner.phases, state.revision + 1);
      return update(state, { timer: next, planner });
    }
    duration = planner.phases[0].durationMs;
  }
  return update(state, {
    ...(planner && { planner }),
    timer: {
      ...timer, phaseId: timer.phaseId ?? 0, runId: state.revision + 1,
      durationMs: timer.status === "paused" ? timer.durationMs : duration,
      status: "running", endsAt: now + duration, pausedRemainingMs: null,
      completedPhase: null, expiredAt: null, studyStartedAt: timer.phase === "study" ? now : null,
    },
  });
}

function pauseTimer(state, now) {
  const { timer } = state;
  const remaining = remainingMs(timer, now);
  if (timer.status !== "running") return state;
  let planner = state.planner;
  if (planner) {
    planner = refitPlan(planner, planner.phases[0], now, remaining);
    if (!planner.phases.length || planner.phases[0].phase !== timer.phase) {
      const next = queuePlanPhase(timer, planner.phases, state.revision + 1);
      return stopRun(state, next, now, { planner });
    }
  }
  return stopRun(state, {
    ...timer, status: "paused", endsAt: null, pausedRemainingMs: remaining, studyStartedAt: null,
  }, now, planner ? { planner } : {});
}

export function reconcile(state, now) {
  const { timer, planner } = state;
  if (timer.status !== "running") {
    if (planner && timer.status !== "finished" && now >= planner.finishAt) {
      const finished = queuePlanPhase(timer, [], state.revision + 1);
      return update(state, {
        planner: { ...planner, phases: [] },
        timer: { ...finished, completedPhase: timer.completedPhase, expiredAt: timer.expiredAt ?? planner.finishAt },
      });
    }
    return state;
  }

  if (timer.endsAt <= now) {
    const planned = planner ? advancePlan(state, now) : null;
    const next = {
      ...(planned?.timer ?? nextPhase(timer, state.settings)), phaseId: state.revision + 1,
      completedPhase: timer.phase, expiredAt: timer.endsAt,
      ...(planned && { completedStudyBlocks: timer.completedStudyBlocks + Number(timer.phase === "study") }),
    };
    return stopRun(state, next, now, {
      ...(planned && { planner: planned.planner }),
      // Claim this run's alert in the same write as the natural completion.
      delivery: {
        phaseId: timer.phaseId ?? 0,
        runId: timer.runId ?? state.revision,
      },
    });
  }

  if (timer.phase === "study" && timer.studyStartedAt == null) {
    // An active timer from an earlier build starts recording at the first read after the update.
    return update(state, { timer: { ...timer, studyStartedAt: now } });
  }
  return state;
}

export function applyCommand(state, command, now) {
  const { timer, settings, planner } = state;
  switch (command.type) {
    case "distractions.set":
    case "distractions.add":
    case "distractions.remove":
      return applyDistractionCommand(state, command);
    case "timer.start":
      return { state: startTimer(state, now) };
    case "timer.pause":
      return { state: pauseTimer(state, now) };
    case "timer.reset":
      if (timer.status === "finished") return { state };
      return { state: stopRun(state, readyTimer({ ...timer, phaseId: state.revision + 1 }, timer.phase, timer.durationMs), now) };
    case "timer.skip": {
      if (timer.status === "finished") return { state };
      if (planner) {
        const next = advancePlan(state, now);
        return { state: stopRun(state, next.timer, now, { planner: next.planner }) };
      }
      return { state: stopRun(state, { ...advance(timer, settings, false), phaseId: state.revision + 1 }, now) };
    }
    case "planner.use": {
      const draft = command.draft ?? {};
      const errors = Object.values(validatePlanDraft(draft, now));
      if (errors.length) return { state, error: errors[0] };
      const { mode, finishAt, study, shortBreak } = draft;
      const pattern = createPlanPattern(draft, settings[mode]);
      const phases = buildPlanSchedule(pattern, finishAt - now);
      const next = queuePlanPhase({ ...timer, mode }, phases, state.revision + 1);
      return { state: stopRun(state, next, now, {
        planner: { mode, finishAt, study, shortBreak, pattern, phases, adjusted: false },
      }) };
    }
    case "mode.select": {
      if (!isMode(command.mode)) return { state, error: "Choose a valid timing mode." };
      if (!planner && timer.mode === command.mode) return { state };
      const nextSettings = { ...settings, selectedMode: command.mode };
      const next = readyPhase({
        ...timer, mode: command.mode, phaseId: state.revision + 1, cascadeIndex: 0, pomodoroCycle: 0,
      }, nextSettings, "study");
      return { state: stopRun(state, next, now, { settings: nextSettings, planner: null }) };
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
        timer: !planner && timer.mode === mode && timer.status === "ready"
          ? { ...timer, durationMs: toDurationMs(phaseMinutes(timer, nextSettings)) }
          : timer,
      }) };
    }
    case "notifications.set":
      if (typeof command.enabled !== "boolean") return { state, error: "Choose a valid notification preference." };
      if ((settings.completionNotifications !== false) === command.enabled) return { state };
      return { state: update(state, { settings: { ...settings, completionNotifications: command.enabled } }) };
    case "check-in.set":
      if (typeof command.enabled !== "boolean") return { state, error: "Choose a valid check-in preference." };
      if ((settings.openStudyCheckIn !== false) === command.enabled) return { state };
      return { state: update(state, { settings: { ...settings, openStudyCheckIn: command.enabled } }) };
    case "sound.mute":
      if (typeof command.muted !== "boolean") return { state, error: "Choose a valid mute preference." };
      if ((settings.soundMuted === true) === command.muted) return { state };
      return { state: update(state, { settings: { ...settings, soundMuted: command.muted } }) };
    case "sound.volume":
      if (!Number.isInteger(command.volume) || command.volume < 0 || command.volume > 100) {
        return { state, error: "Set a volume from 0 to 100%." };
      }
      if (settings.soundVolume === command.volume) return { state };
      return { state: update(state, { settings: { ...settings, soundVolume: command.volume } }) };
    default:
      return { state, error: "Unknown Timebit command." };
  }
}
