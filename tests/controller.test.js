import assert from "node:assert/strict";
import test from "node:test";
import { BADGE_REFRESH_ALARM, PHASE_END_ALARM, syncTimerAlarms } from "../extension/background/alarms.js";
import { createController } from "../extension/background/controller.js";
import { createInitialState, STATE_KEY } from "../extension/core/timer.js";

function setup(initial) {
  let saved = initial;
  let now = 10_000;
  let writes = 0;
  let rejectWrite = false;
  let rejectAlarmCreation = false;
  const scheduled = new Map();
  const alarms = {
    async get(name) { return scheduled.get(name); },
    async create(name, { when, delayInMinutes, periodInMinutes }) {
      if (rejectAlarmCreation && name === PHASE_END_ALARM) throw new Error("Alarm creation failed");
      scheduled.set(name, { scheduledTime: when ?? now + delayInMinutes * 60_000, periodInMinutes });
    },
    async clear(name) { return scheduled.delete(name); },
  };
  const startWorker = () => createController(storage, {
    now: () => now,
    syncAlarms: (timer) => syncTimerAlarms(alarms, timer),
  });
  const storage = {
    async get(key) {
      assert.equal(key, STATE_KEY);
      return { [key]: structuredClone(saved) };
    },
    async set(values) {
      if (rejectWrite) throw new Error("Storage write failed");
      saved = structuredClone(values[STATE_KEY]);
      writes += 1;
    },
  };
  return {
    dispatch: startWorker(),
    restart: startWorker,
    advance: (milliseconds) => { now += milliseconds; },
    writeCount: () => writes,
    setRejectWrite: (value) => { rejectWrite = value; },
    failCompletionAlarm: () => { rejectAlarmCreation = true; },
    scheduled,
  };
}

test("concurrent timer commands cannot apply to the same revision twice", async () => {
  const { dispatch, writeCount } = setup();
  const command = { type: "timer.skip", expectedRevision: 0 };
  const [first, second] = await Promise.all([dispatch(command), dispatch(command)]);
  assert.equal(first.state.timer.phase, "shortBreak");
  assert.equal(first.state.timer.completedStudyBlocks, 0);
  assert.match(second.error, /timer changed/);
  assert.deepEqual(second.state, first.state);
  assert.equal(writeCount(), 1);
});

test("worker recreation restores settings and a running deadline without ticking storage", async () => {
  const { dispatch, restart, advance, writeCount } = setup();
  await dispatch({
    type: "mode.save", mode: "pomodoro", expectedRevision: 0,
    values: { study: 10, shortBreak: 4, longBreak: 8, longBreakEvery: 3 },
  });
  const started = await dispatch({ type: "timer.start", expectedRevision: 1 });
  advance(60_000);
  const read = await restart()({ type: "state.get" });
  assert.deepEqual(read.state, started.state);
  assert.equal(writeCount(), 2);
});

test("overdue reconciliation wins over a stale reset or pause command", async () => {
  const { dispatch, restart, advance, writeCount } = setup();
  await dispatch({ type: "timer.start", expectedRevision: 0 });
  advance(25 * 60_000);
  const restoredWorker = restart();
  const reset = await restoredWorker({ type: "timer.reset", expectedRevision: 1 });
  const pause = await restoredWorker({ type: "timer.pause", expectedRevision: 1 });
  for (const result of [pause, reset]) {
    assert.match(result.error, /timer changed/);
    assert.equal(result.state.timer.status, "ready");
    assert.equal(result.state.timer.phase, "shortBreak");
    assert.equal(result.state.timer.completedStudyBlocks, 1);
  }
  assert.equal(writeCount(), 2);
});

test("invalid settings create field errors and leave other persisted data intact", async () => {
  const initial = { ...createInitialState(), tasks: [{ id: "example", done: false }] };
  const { dispatch, writeCount } = setup(initial);
  const invalid = await dispatch({
    type: "mode.save", mode: "cascade", expectedRevision: 0,
    values: { study: [50, 60, 30, 20, 10], shortBreak: 0, longBreak: 12 },
  });
  assert.ok(invalid.errors.study1);
  assert.ok(invalid.errors.shortBreak);
  assert.deepEqual(invalid.state, initial);
  assert.equal(writeCount(), 0);
});

test("a failed write leaves persisted state intact and the command queue usable", async () => {
  const { dispatch, setRejectWrite, writeCount } = setup();
  setRejectWrite(true);
  await assert.rejects(dispatch({ type: "timer.start", expectedRevision: 0 }), /Storage write failed/);
  assert.equal((await dispatch({ type: "state.get" })).state.revision, 0);
  setRejectWrite(false);
  const result = await dispatch({ type: "timer.start", expectedRevision: 0 });
  assert.equal(result.state.timer.status, "running");
  assert.equal(writeCount(), 1);
});

test("refuses to overwrite a storage schema it does not understand", async () => {
  const { dispatch, writeCount } = setup({ schemaVersion: 2 });
  await assert.rejects(dispatch({ type: "state.get" }), /Unsupported Timebit storage version/);
  assert.equal(writeCount(), 0);
});

test("start and resume arm the persisted deadline, while pause and reset clear both alarms", async () => {
  const { dispatch, scheduled, advance } = setup();
  const running = await dispatch({ type: "timer.start", expectedRevision: 0 });
  assert.equal(scheduled.get(PHASE_END_ALARM).scheduledTime, running.state.timer.endsAt);
  assert.equal(scheduled.get(BADGE_REFRESH_ALARM).periodInMinutes, 1);

  advance(90_000);
  const paused = await dispatch({ type: "timer.pause", expectedRevision: 1 });
  assert.equal(paused.state.timer.pausedRemainingMs, 25 * 60_000 - 90_000);
  assert.equal(scheduled.size, 0);
  advance(360_000);
  const resumed = await dispatch({ type: "timer.start", expectedRevision: 2 });
  assert.equal(resumed.state.timer.endsAt, running.state.timer.endsAt + 360_000);
  assert.equal(scheduled.get(PHASE_END_ALARM).scheduledTime, resumed.state.timer.endsAt);

  const reset = await dispatch({ type: "timer.reset", expectedRevision: 3 });
  assert.equal(reset.state.timer.status, "ready");
  assert.equal(scheduled.size, 0);
});

test("startup replaces missing or stale alarms without changing a running timer", async () => {
  const { dispatch, restart, scheduled, advance, writeCount } = setup();
  const started = await dispatch({ type: "timer.start", expectedRevision: 0 });
  scheduled.set(PHASE_END_ALARM, { scheduledTime: 12_345 });
  scheduled.delete(BADGE_REFRESH_ALARM);
  advance(60_000);
  const recovered = await restart()({ type: "state.get" });
  assert.deepEqual(recovered.state, started.state);
  assert.equal(scheduled.get(PHASE_END_ALARM).scheduledTime, started.state.timer.endsAt);
  assert.equal(scheduled.get(BADGE_REFRESH_ALARM).periodInMinutes, 1);
  assert.equal(writeCount(), 1);
});

test("late and duplicate wakeups advance only the expired run and cancel its alarms", async () => {
  const { dispatch, restart, scheduled, advance, writeCount } = setup();
  await dispatch({ type: "timer.start", expectedRevision: 0 });
  advance(3 * 60 * 60_000);
  const wake = restart();
  const [first, second] = await Promise.all([wake({ type: "state.get" }), wake({ type: "state.get" })]);
  assert.deepEqual(second.state, first.state);
  assert.equal(first.state.timer.completedStudyBlocks, 1);
  assert.equal(first.state.timer.phase, "shortBreak");
  assert.equal(first.state.timer.status, "ready");
  assert.equal(scheduled.size, 0);
  assert.equal(writeCount(), 2);
});

test("an early wake after a mode change or skip cannot complete the new phase", async () => {
  const { dispatch, scheduled, advance } = setup();
  await dispatch({ type: "timer.start", expectedRevision: 0 });
  advance(24 * 60_000);
  await dispatch({ type: "mode.select", mode: "cascade", expectedRevision: 1 });
  assert.equal(scheduled.size, 0);
  await dispatch({ type: "timer.start", expectedRevision: 2 });
  advance(60_000);
  const early = await dispatch({ type: "state.get" });
  assert.equal(early.state.timer.mode, "cascade");
  assert.equal(early.state.timer.status, "running");
  assert.equal(early.state.timer.completedStudyBlocks, 0);
  const skipped = await dispatch({ type: "timer.skip", expectedRevision: 3 });
  assert.equal(skipped.state.timer.status, "ready");
  assert.equal(scheduled.size, 0);
});

test("a failed completion alarm leaves the timer unstarted and clears partial scheduling", async () => {
  const { dispatch, scheduled, failCompletionAlarm, writeCount } = setup();
  failCompletionAlarm();
  await assert.rejects(dispatch({ type: "timer.start", expectedRevision: 0 }), /Alarm creation failed/);
  assert.equal((await dispatch({ type: "state.get" })).state.timer.status, "ready");
  assert.equal(scheduled.size, 0);
  assert.equal(writeCount(), 0);
});
