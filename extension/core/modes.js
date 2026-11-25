export const MINUTE_MS = 60_000;
export const DEFAULT_SOUND_VOLUME = 35;
export const MODE_NAMES = Object.freeze({ pomodoro: "Pomodoro", cascade: "Cascade" });
export const PHASE_NAMES = Object.freeze({
  study: "study",
  shortBreak: "short break",
  longBreak: "long break",
});

export function defaultSettings() {
  return {
    selectedMode: "pomodoro",
    completionNotifications: true,
    openStudyCheckIn: true,
    soundMuted: false,
    soundVolume: DEFAULT_SOUND_VOLUME,
    pomodoro: { study: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 3 },
    cascade: { study: [50, 40, 30, 20, 10], shortBreak: 10, longBreak: 25 },
  };
}

export function isMode(mode) {
  return typeof mode === "string" && Object.hasOwn(MODE_NAMES, mode);
}

export function toDurationMs(minutes) {
  return Math.round(minutes * MINUTE_MS);
}

export function validateModeSettings(mode, values) {
  if (!isMode(mode) || !values || typeof values !== "object" || Array.isArray(values)) {
    return { form: "Choose a timing mode and enter its durations." };
  }

  const errors = {};
  function checkDuration(name, value) {
    if (!Number.isFinite(value) || value <= 0) {
      errors[name] = "Enter a positive number of minutes.";
      return false;
    }
    const durationMs = toDurationMs(value);
    if (durationMs < 1 || durationMs > Number.MAX_SAFE_INTEGER / 2) {
      errors[name] = "Enter a duration the timer can represent.";
      return false;
    }
    return true;
  }

  checkDuration("shortBreak", values.shortBreak);
  checkDuration("longBreak", values.longBreak);
  if (mode === "pomodoro") {
    checkDuration("study", values.study);
    if (!Number.isSafeInteger(values.longBreakEvery) || values.longBreakEvery < 1) {
      errors.longBreakEvery = "Enter a whole number of study blocks.";
    }
  } else if (!Array.isArray(values.study) || values.study.length !== 5) {
    errors.study = "Enter all five Cascade study durations.";
  } else {
    const valid = Array.from(values.study, (value, index) => checkDuration(`study${index}`, value));
    for (let index = 1; index < values.study.length; index += 1) {
      if (valid[index] && valid[index - 1] &&
          toDurationMs(values.study[index]) >= toDurationMs(values.study[index - 1])) {
        errors[`study${index}`] = "Enter less time than the previous block.";
      }
    }
  }
  return errors;
}

export function phaseMinutes(timer, settings) {
  const mode = settings[timer.mode];
  if (timer.phase === "study" && timer.mode === "cascade") {
    return mode.study[timer.cascadeIndex];
  }
  return mode[timer.phase];
}
