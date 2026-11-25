import { isMode, MINUTE_MS, toDurationMs } from "./modes.js";

// A same-day plan is at most a local day's work, even after a clock correction.
const MAX_PLAN_MS = 26 * 60 * MINUTE_MS;

export function localFinishTime(value, now) {
  const time = /^(\d{2}):(\d{2})$/.exec(value);
  if (!time) return NaN;
  const [, hour, minute] = time.map(Number);
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  // On a spring-forward day, Date can roll a nonexistent local time forward.
  return date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : NaN;
}

export function validatePlanDraft({ mode, finishAt, study, shortBreak }, now) {
  const errors = {};
  const endOfDay = new Date(now);
  endOfDay.setHours(24, 0, 0, 0);
  if (!Number.isSafeInteger(finishAt) || finishAt <= now || finishAt >= endOfDay.getTime()) {
    errors.finish = "Choose a finish time later today.";
  } else if (finishAt - now < MINUTE_MS) {
    errors.finish = "Allow at least one minute before your finish time.";
  }
  if (!isMode(mode)) errors.mode = "Choose Pomodoro or Cascade.";
  for (const [field, value] of [["study", study], ["shortBreak", shortBreak]]) {
    if (!Number.isFinite(value) || value < 1 || !Number.isSafeInteger(toDurationMs(value))) {
      errors[field] = "Enter a duration of at least one minute.";
    }
  }
  return errors;
}

export function createPlanPattern({ study, shortBreak }, modeSettings) {
  const minutes = Array.isArray(modeSettings.study)
    ? modeSettings.study.map((length) => Math.max(1, study * (length / modeSettings.study[0])))
    : [study];
  return {
    studyMs: minutes.map(toDurationMs),
    shortBreakMs: toDurationMs(shortBreak),
    longBreakMs: Math.max(MINUTE_MS, toDurationMs(modeSettings.longBreak)),
    longBreakEvery: modeSettings.longBreakEvery ?? minutes.length,
  };
}

function followingPlanPhase(pattern, { phase, index }) {
  if (phase !== "study") return { phase: "study", index: index + 1 };
  return { phase: (index + 1) % pattern.longBreakEvery === 0 ? "longBreak" : "shortBreak", index };
}

function preferredDuration(pattern, { phase, index }) {
  if (phase === "study") return pattern.studyMs[index % pattern.studyMs.length];
  return phase === "longBreak" ? pattern.longBreakMs : pattern.shortBreakMs;
}

export function buildPlanSchedule(pattern, budgetMs, first = { phase: "study", index: 0 }, resumeMs = null) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) return [];
  let available = Math.min(budgetMs, MAX_PLAN_MS);
  const phases = [];
  let cursor = first;
  // The first item may be a resume of a phase that has already run for part of its duration.
  while (available >= MINUTE_MS || (available > 0 && resumeMs !== null && cursor.phase === "study")) {
    const next = followingPlanPhase(pattern, cursor);
    const preferred = resumeMs ?? preferredDuration(pattern, cursor);
    if (cursor.phase === "study") {
      if (available - preferred < preferredDuration(pattern, next) + MINUTE_MS) {
        const durationMs = resumeMs === null ? available : Math.min(resumeMs, available);
        phases.push({ phase: cursor.phase, index: cursor.index, durationMs });
        break;
      }
    } else if (available - preferred < MINUTE_MS) {
      phases.push({ ...next, durationMs: available });
      break;
    }
    phases.push({ phase: cursor.phase, index: cursor.index, durationMs: preferred });
    available -= preferred;
    cursor = next;
    resumeMs = null;
  }
  return phases;
}
