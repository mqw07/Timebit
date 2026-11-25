import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings, MINUTE_MS, validateModeSettings } from "../extension/core/modes.js";
import { applyCommand, createInitialState, formatOvertime, nextPhase, overtimeMs, reconcile, remainingMs } from "../extension/core/timer.js";

const now = 1_800_000_000_000;
const minutes = (value) => value * MINUTE_MS;
const apply = (state, type, extra = {}, time = now) =>
  applyCommand(state, { type, ...extra }, time).state;

function finish(state) {
  const running = apply(state, "timer.start");
  return reconcile(running, running.timer.endsAt);
}

test("starts with an unstarted 25-minute Pomodoro and isolated defaults", () => {
  const state = createInitialState();
  assert.equal(state.timer.mode, "pomodoro");
  assert.equal(state.timer.phase, "study");
  assert.equal(state.timer.status, "ready");
  assert.equal(state.timer.endsAt, null);
  assert.equal(remainingMs(state.timer, now), minutes(25));
  state.settings.cascade.study[0] = 100;
  assert.equal(createInitialState().settings.cascade.study[0], 50);
});

test("Pomodoro inserts its long break after the third completion and repeats", () => {
  let state = createInitialState();
  for (const [phase, duration, count] of [
    ["shortBreak", 5, 1], ["study", 25, 1],
    ["shortBreak", 5, 2], ["study", 25, 2],
    ["longBreak", 15, 3], ["study", 25, 3], ["shortBreak", 5, 4],
  ]) {
    state = finish(state);
    assert.equal(state.timer.phase, phase);
    assert.equal(state.timer.durationMs, minutes(duration));
    assert.equal(state.timer.completedStudyBlocks, count);
    assert.equal(state.timer.status, "ready");
    assert.equal(state.timer.endsAt, null);
  }
});

test("skipping a Pomodoro study does not move the long-break cycle forward", () => {
  const afterTwo = finish(finish(finish(finish(createInitialState()))));
  const preview = nextPhase(afterTwo.timer, afterTwo.settings);
  assert.equal(preview.phase, "longBreak");
  assert.equal(afterTwo.timer.completedStudyBlocks, 2);
  const skipped = apply(afterTwo, "timer.skip");
  assert.equal(skipped.timer.phase, "shortBreak");
  assert.equal(skipped.timer.completedStudyBlocks, 2);
  assert.equal(skipped.timer.pomodoroCycle, 2);
  assert.equal(finish(finish(skipped)).timer.phase, "longBreak");
});

test("skipping the Pomodoro long break starts a new cycle without clearing totals", () => {
  let state = createInitialState();
  for (let index = 0; index < 5; index += 1) state = finish(state);
  state = apply(state, "timer.skip");
  assert.equal(state.timer.pomodoroCycle, 0);
  assert.equal(state.timer.completedStudyBlocks, 3);
  assert.equal(finish(state).timer.phase, "shortBreak");
});

test("Cascade uses one short break duration and wraps after the final long break", () => {
  let state = apply(createInitialState(), "mode.select", { mode: "cascade" });
  const expected = [
    ["study", 50, 0], ["shortBreak", 10, 1], ["study", 40, 1], ["shortBreak", 10, 2],
    ["study", 30, 2], ["shortBreak", 10, 3], ["study", 20, 3], ["shortBreak", 10, 4],
    ["study", 10, 4], ["longBreak", 25, 5], ["study", 50, 5],
  ];
  for (const [phase, duration, count] of expected) {
    assert.equal(state.timer.phase, phase);
    assert.equal(state.timer.durationMs, minutes(duration));
    assert.equal(state.timer.completedStudyBlocks, count);
    assert.equal(state.timer.status, "ready");
    state = finish(state);
  }
});

test("Cascade advances position on skip without crediting the study", () => {
  let state = apply(createInitialState(), "mode.select", { mode: "cascade" });
  for (let index = 0; index < 9; index += 1) state = apply(state, "timer.skip");
  assert.equal(state.timer.phase, "longBreak");
  assert.equal(state.timer.completedStudyBlocks, 0);
  state = apply(state, "timer.skip");
  assert.equal(state.timer.cascadeIndex, 0);
  assert.equal(remainingMs(state.timer, now), minutes(50));
});

test("pause freezes elapsed time and resume schedules the saved remainder", () => {
  const running = apply(createInitialState(), "timer.start");
  const paused = apply(running, "timer.pause", {}, now + minutes(2));
  assert.equal(paused.timer.status, "paused");
  assert.equal(paused.timer.endsAt, null);
  assert.equal(remainingMs(paused.timer, now + minutes(60)), minutes(23));
  assert.equal(reconcile(paused, now + minutes(60)), paused);
  const resumed = apply(paused, "timer.start", {}, now + minutes(60));
  assert.equal(resumed.timer.endsAt, now + minutes(83));
});

test("reset restores the full current phase and leaves it ready", () => {
  const shortBreak = finish(createInitialState());
  const running = apply(shortBreak, "timer.start");
  const paused = apply(running, "timer.pause", {}, now + minutes(2));
  const reset = apply(paused, "timer.reset");
  assert.equal(reset.timer.phase, "shortBreak");
  assert.equal(reset.timer.status, "ready");
  assert.equal(reset.timer.completedStudyBlocks, 1);
  assert.equal(remainingMs(reset.timer, now), minutes(5));
});

test("a late read completes only the expired running phase, exactly once", () => {
  const running = apply(createInitialState(), "timer.start");
  assert.equal(reconcile(running, running.timer.endsAt - 1), running);
  assert.equal(remainingMs(running.timer, now - minutes(1)), minutes(25));
  assert.equal(remainingMs(running.timer, now + minutes(400)), 0);
  const recovered = reconcile(running, now + minutes(400));
  assert.equal(recovered.timer.completedStudyBlocks, 1);
  assert.equal(recovered.timer.phase, "shortBreak");
  assert.equal(recovered.timer.status, "ready");
  assert.equal(reconcile(recovered, now + minutes(400)), recovered);
});

test("study and break overtime are based on the original deadline and keep the next phase ready", () => {
  const running = apply(createInitialState(), "timer.start");
  const late = running.timer.endsAt + 133_900;
  const studyDone = reconcile(running, late);
  assert.equal(studyDone.timer.expiredAt, running.timer.endsAt);
  assert.equal(formatOvertime(overtimeMs(studyDone.timer, late)), "-02:13");
  assert.equal(studyDone.timer.status, "ready");
  assert.equal(remainingMs(studyDone.timer, late), minutes(5));
  assert.equal(reconcile(studyDone, late + minutes(20)), studyDone);

  for (const command of ["timer.reset", "timer.skip", "mode.select"]) {
    const next = apply(studyDone, command, { mode: "cascade" }, late);
    assert.equal(overtimeMs(next.timer, late), null);
    assert.equal(next.timer.status, "ready");
    assert.equal(next.studyIntervals, studyDone.studyIntervals);
  }
  const breakRunning = apply(studyDone, "timer.start", {}, late);
  assert.equal(overtimeMs(breakRunning.timer, late), null);
  assert.equal(breakRunning.timer.endsAt, late + minutes(5));
  const breakDone = reconcile(breakRunning, breakRunning.timer.endsAt + 3_000);
  assert.equal(breakDone.timer.completedPhase, "shortBreak");
  assert.equal(breakDone.timer.phase, "study");
  assert.equal(breakDone.timer.status, "ready");
  assert.equal(overtimeMs(breakDone.timer, breakRunning.timer.endsAt + 3_000), 3_000);
  assert.equal(breakDone.studyIntervals, studyDone.studyIntervals);
});

test("changing mode prepares its first phase and preserves counts and tasks", () => {
  const tasks = [{ id: "example", done: false }];
  const running = apply({ ...finish(createInitialState()), tasks }, "timer.start");
  const changed = apply(running, "mode.select", { mode: "cascade" });
  assert.equal(changed.settings.selectedMode, "cascade");
  assert.equal(changed.timer.status, "ready");
  assert.equal(changed.timer.durationMs, minutes(50));
  assert.equal(changed.timer.completedStudyBlocks, 1);
  assert.equal(changed.tasks, tasks);
  const back = apply(changed, "mode.select", { mode: "pomodoro" });
  assert.equal(back.timer.pomodoroCycle, 0);
});

test("saving settings applies new lengths to future phases without changing running or paused snapshots", () => {
  const running = apply(createInitialState(), "timer.start");
  const values = { study: 40, shortBreak: 7, longBreak: 20, longBreakEvery: 2 };
  const edited = apply(running, "mode.save", { mode: "pomodoro", values });
  assert.equal(edited.timer, running.timer);
  const paused = apply(edited, "timer.pause", {}, now + minutes(2));
  const editedAgain = apply(paused, "mode.save", { mode: "pomodoro", values });
  assert.equal(editedAgain.timer, paused.timer);
  const next = reconcile(edited, running.timer.endsAt);
  assert.equal(next.timer.durationMs, minutes(7));
  const nextStudy = finish(next);
  assert.equal(nextStudy.timer.durationMs, minutes(40));
  assert.equal(finish(nextStudy).timer.phase, "longBreak");
});

test("saving the active ready mode refreshes the loaded duration without starting", () => {
  const state = createInitialState();
  const values = { ...state.settings.pomodoro, study: 12.5 };
  const edited = apply(state, "mode.save", { mode: "pomodoro", values });
  assert.equal(edited.timer.durationMs, minutes(12.5));
  assert.equal(edited.timer.status, "ready");
});

test("invalid commands and redundant controls leave timer state unchanged", () => {
  const state = createInitialState();
  assert.equal(apply(state, "timer.pause"), state);
  const running = apply(state, "timer.start");
  assert.equal(apply(running, "timer.start"), running);
  assert.equal(apply(running, "mode.select", { mode: "pomodoro" }), running);
  assert.match(applyCommand(state, { type: "mode.select", mode: "invalid" }, now).error, /valid timing mode/);
  assert.match(applyCommand(state, { type: "invalid" }, now).error, /Unknown/);
});

for (const value of [0, -5, NaN, Infinity, "25", null, 1e-15, Number.MAX_VALUE]) {
  test(`rejects invalid duration ${String(value)}`, () => {
    const values = { ...defaultSettings().pomodoro, study: value };
    assert.ok(validateModeSettings("pomodoro", values).study);
  });
}

test("validates both forms, including cadence and adjacent Cascade durations", () => {
  const defaults = defaultSettings();
  assert.deepEqual(validateModeSettings("pomodoro", defaults.pomodoro), {});
  assert.deepEqual(validateModeSettings("cascade", defaults.cascade), {});
  const cadence = validateModeSettings("pomodoro", { ...defaults.pomodoro, longBreakEvery: 1.5 });
  assert.ok(cadence.longBreakEvery);
  const cascade = validateModeSettings("cascade", { ...defaults.cascade, study: [50, 50, 30, 40, 0] });
  assert.deepEqual(Object.keys(cascade).sort(), ["study1", "study3", "study4"]);
  assert.ok(validateModeSettings("cascade", { ...defaults.cascade, study: [10] }).study);
  assert.ok(validateModeSettings("cascade", { ...defaults.cascade, study: Array(5) }).study0);
  assert.ok(validateModeSettings("unrecognized", {}).form);
  assert.ok(validateModeSettings(["pomodoro"], defaults.pomodoro).form);
});
