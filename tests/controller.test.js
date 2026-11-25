import assert from "node:assert/strict";
import test from "node:test";
import { BADGE_REFRESH_ALARM, PHASE_END_ALARM, syncTimerAlarms } from "../extension/background/alarms.js";
import { createController } from "../extension/background/controller.js";
import { createInitialState, STATE_KEY } from "../extension/core/timer.js";

function setup(initial, initialTime = 10_000) {
  let saved = initial;
  let now = initialTime;
  let writes = 0;
  let rejectWrite = false;
  let rejectAlarmCreation = false;
  const completions = [];
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
    syncAlarms: (timer, planFinishAt) => syncTimerAlarms(alarms, timer, now, planFinishAt),
    publishFeedback: async (state, { completion }) => {
      if (!completion) return;
      assert.deepEqual(saved, state);
      completions.push(completion);
    },
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
    completions,
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

const planStart = new Date(2026, 10, 24, 15, 30).getTime();
const minute = 60_000;
const planInputs = { mode: "pomodoro", study: 25, shortBreak: 5 };

function planSession(minutes, initial) {
  const finishAt = planStart + minutes * minute;
  const harness = setup(initial, planStart);
  let worker = harness.dispatch;
  let state;
  async function command(type, fields) {
    const result = await worker({ type, expectedRevision: state?.revision ?? 0, ...fields });
    assert.equal(result.error, undefined);
    state = result.state;
    return state;
  }
  return {
    ...harness, finishAt, command,
    use: (overrides) => command("planner.use", { draft: { ...planInputs, finishAt, ...overrides } }),
    reload: () => { worker = harness.restart(); return command("state.get"); },
  };
}

test("a delayed manual start refits the plan and still leaves each subsequent phase stopped", async () => {
  const session = planSession(90);
  const plan = await session.use();
  assert.equal(plan.timer.status, "ready");
  assert.equal(session.scheduled.get(PHASE_END_ALARM).scheduledTime, session.finishAt);

  session.advance(20 * minute);
  const started = await session.command("timer.start");
  assert.deepEqual(started.planner.phases.map(({ durationMs }) => durationMs / minute), [25, 5, 25, 5, 10]);
  assert.equal(started.timer.endsAt, planStart + 45 * minute);
  session.advance(25 * minute);
  const rest = await session.reload();
  assert.equal(rest.timer.phase, "shortBreak");
  assert.equal(rest.timer.status, "ready");
  assert.equal(rest.timer.endsAt, null);
  assert.equal(rest.timer.completedStudyBlocks, 1);
  assert.equal(rest.timer.expiredAt, started.timer.endsAt);
  assert.equal(rest.planner.finishAt, session.finishAt);
  assert.equal(session.scheduled.get(PHASE_END_ALARM).scheduledTime, session.finishAt);
});

test("a break that no longer fits is replaced by a stopped final study and requires another Start", async () => {
  const session = planSession(35);
  await session.use();
  await session.command("timer.start");
  session.advance(25 * minute);
  await session.command("state.get");
  session.advance(6 * minute);
  const adjusted = await session.command("timer.start");
  assert.equal(adjusted.timer.phase, "study");
  assert.equal(adjusted.timer.status, "ready");
  assert.equal(adjusted.timer.durationMs, 4 * minute);
  assert.equal(adjusted.planner.adjusted, true);

  const started = await session.command("timer.start");
  assert.equal(started.timer.endsAt, session.finishAt);
  session.advance(6 * minute);
  const finished = await session.reload();
  assert.equal(finished.timer.status, "finished");
  assert.equal(finished.timer.expiredAt, session.finishAt);
  assert.equal(finished.timer.completedStudyBlocks, 2);
  assert.deepEqual(finished.planner.phases, []);
  assert.deepEqual(await session.command("timer.start"), finished);
  assert.equal(session.completions.length, 2);
  assert.equal(session.scheduled.size, 0);
});

test("resuming a paused study can shorten it to the same deadline and earns one completion", async () => {
  const session = planSession(20);
  await session.use();
  await session.command("timer.start");
  session.advance(5 * minute);
  const paused = await session.command("timer.pause");
  assert.equal(paused.timer.pausedRemainingMs, 15 * minute);
  assert.equal(session.scheduled.get(PHASE_END_ALARM).scheduledTime, session.finishAt);
  session.advance(14.5 * minute);
  const resumed = await session.command("timer.start");
  assert.equal(resumed.timer.endsAt, session.finishAt);
  session.advance(minute);
  const done = await session.reload();
  assert.equal(done.timer.status, "finished");
  assert.equal(done.timer.completedStudyBlocks, 1);
  assert.deepEqual(done.studyIntervals.map(({ startAt, endAt }) => endAt - startAt), [5 * minute, minute / 2]);
  assert.equal(session.completions.length, 1);
});

test("resuming a paused break cannot consume the last remaining study time", async () => {
  const session = planSession(34);
  await session.use();
  await session.command("timer.start");
  session.advance(25 * minute);
  await session.command("state.get");
  await session.command("timer.start");
  session.advance(minute);
  const paused = await session.command("timer.pause");
  assert.equal(paused.timer.pausedRemainingMs, 4 * minute);
  session.advance(4 * minute);
  const adjusted = await session.command("timer.start");
  assert.equal(adjusted.timer.phase, "study");
  assert.equal(adjusted.timer.status, "ready");
  assert.equal(adjusted.timer.durationMs, 4 * minute);
});

test("less than a minute left never starts an unstarted study", async () => {
  const session = planSession(2);
  await session.use();
  session.advance(90_000);
  const done = await session.command("timer.start");
  assert.equal(done.timer.status, "finished");
  assert.equal(done.timer.endsAt, null);
  assert.equal(done.planner.tooLittleTime, true);
  assert.equal(done.timer.completedStudyBlocks, 0);
  assert.equal(session.completions.length, 0);
});

test("a waiting or paused plan expires across restart without recording an uncompleted study", async () => {
  for (const pause of [false, true]) {
    const session = planSession(20);
    await session.use();
    if (pause) {
      await session.command("timer.start");
      session.advance(minute);
      await session.command("timer.pause");
    }
    session.advance(20 * minute);
    const done = await session.reload();
    assert.equal(done.timer.status, "finished");
    assert.equal(done.timer.completedStudyBlocks, 0);
    assert.equal(done.timer.expiredAt, session.finishAt);
    assert.equal(session.completions.length, 0);
    assert.equal(session.scheduled.size, 0);
  }
});

test("skipping records elapsed time without crediting a block, and clock changes keep the absolute deadline", async () => {
  const session = planSession(50);
  await session.use({ mode: "cascade", study: 30 });
  await session.command("timer.start");
  session.advance(5 * minute);
  const skipped = await session.command("timer.skip");
  assert.equal(skipped.timer.phase, "shortBreak");
  assert.equal(skipped.timer.status, "ready");
  assert.equal(skipped.timer.completedStudyBlocks, 0);
  assert.deepEqual(skipped.studyIntervals, [{ startAt: planStart, endAt: planStart + 5 * minute }]);
  session.advance(-3 * minute);
  const started = await session.command("timer.start");
  assert.ok(started.timer.endsAt < session.finishAt);
  assert.equal(started.planner.finishAt, session.finishAt);
  session.advance(90 * minute);
  const done = await session.reload();
  assert.equal(done.timer.status, "finished");
  assert.equal(done.timer.completedStudyBlocks, 0);
  assert.equal(session.completions.length, 1);
});

test("invalid replacement preserves the current timer and switching to the plan's preset exits the plan", async () => {
  const session = planSession(90);
  await session.use();
  const running = await session.command("timer.start");
  const invalid = await session.dispatch({
    type: "planner.use", draft: { ...planInputs, finishAt: planStart - 1 }, expectedRevision: running.revision,
  });
  assert.match(invalid.error, /later today/);
  assert.deepEqual(invalid.state, running);
  session.advance(minute);
  const preset = await session.command("mode.select", { mode: "pomodoro" });
  assert.equal(preset.planner, null);
  assert.equal(preset.timer.status, "ready");
  assert.equal(preset.timer.durationMs, 25 * minute);
  assert.equal(preset.studyIntervals.length, 1);
  assert.equal(session.scheduled.size, 0);
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

  advance(105_000);
  const paused = await dispatch({ type: "timer.pause", expectedRevision: 1 });
  assert.equal(paused.state.timer.pausedRemainingMs, 25 * 60_000 - 105_000);
  assert.equal(scheduled.size, 0);
  advance(360_000);
  const resumed = await dispatch({ type: "timer.start", expectedRevision: 2 });
  assert.equal(resumed.state.timer.endsAt, running.state.timer.endsAt + 360_000);
  assert.equal(scheduled.get(PHASE_END_ALARM).scheduledTime, resumed.state.timer.endsAt);
  assert.equal(scheduled.get(BADGE_REFRESH_ALARM).scheduledTime, resumed.state.timer.endsAt - 23 * 60_000);

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
  const { dispatch, restart, scheduled, advance, writeCount, completions } = setup();
  const { state: running } = await dispatch({ type: "timer.start", expectedRevision: 0 });
  advance(3 * 60 * 60_000);
  const wake = restart();
  const [first, second] = await Promise.all([wake({ type: "state.get" }), wake({ type: "state.get" })]);
  assert.deepEqual(second.state, first.state);
  assert.equal(first.state.timer.completedStudyBlocks, 1);
  assert.equal(first.state.timer.phase, "shortBreak");
  assert.equal(first.state.timer.status, "ready");
  assert.equal(first.state.timer.expiredAt, running.timer.endsAt);
  assert.deepEqual(first.state.studyIntervals, [{ startAt: running.timer.studyStartedAt, endAt: running.timer.endsAt }]);
  assert.equal(scheduled.size, 0);
  assert.equal(writeCount(), 2);
  await restart()({ type: "state.get" });
  assert.deepEqual(completions, [first.state.timer]);
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

test("a Phase 1.3 timer can accept concurrent task commands through completion and restart", async () => {
  const { tasks, tasksRevision, ...legacy } = createInitialState();
  const { dispatch, advance, restart, completions } = setup(legacy);
  const [first, started, second] = await Promise.all([
    dispatch({ type: "tasks.add", text: "  Read chapter  " }),
    dispatch({ type: "timer.start", expectedRevision: 0 }),
    dispatch({ type: "tasks.add", text: "Take notes" }),
  ]);
  const [task, notes] = second.state.tasks;
  assert.deepEqual(task, { ...first.state.tasks[0], text: "Read chapter", completed: false });
  assert.notEqual(task.id, notes.id);
  assert.deepEqual(second.state.timer, started.state.timer);

  advance(25 * 60_000);
  const worker = restart();
  const completed = await worker({ type: "tasks.setCompleted", id: task.id, completed: true });
  assert.equal(completed.state.timer.completedPhase, "study");
  assert.equal(completed.state.timer.status, "ready");
  assert.equal(completions.length, 1);
  assert.equal(completed.state.tasks[0].completed, true);
  assert.equal(completed.state.tasks[0].createdAt, task.createdAt);
  assert.ok(completed.state.tasks[0].updatedAt > task.updatedAt);
  const reset = await worker({ type: "timer.reset", expectedRevision: completed.state.revision });
  const switched = await worker({ type: "mode.select", mode: "cascade", expectedRevision: reset.state.revision });
  assert.deepEqual(switched.state.tasks, completed.state.tasks);
  assert.deepEqual((await restart()({ type: "state.get" })).state, switched.state);
});

test("a stale task edit or bulk clear cannot overwrite task changes from another view", async () => {
  const { dispatch } = setup();
  const added = await dispatch({ type: "tasks.add", text: "First draft" });
  const { id, text: previousText } = added.state.tasks[0];
  const edited = await dispatch({ type: "tasks.edit", id, previousText, text: "Final draft" });
  const staleEdit = await dispatch({ type: "tasks.edit", id, previousText, text: "Old draft" });
  const staleClear = await dispatch({ type: "tasks.clearAll", expectedTasksRevision: added.state.tasksRevision });
  assert.match(staleEdit.error, /edited in another view/);
  assert.match(staleClear.error, /task list changed/);
  assert.deepEqual(staleEdit.state, edited.state);
  assert.deepEqual(staleClear.state, edited.state);
});

test("a resumed run claims one completion before feedback and the next phase has its own identity", async () => {
  const { dispatch, advance, restart, completions } = setup();
  const { state: started } = await dispatch({ type: "timer.start", expectedRevision: 0 });
  const { state: paused } = await dispatch({ type: "timer.pause", expectedRevision: started.revision });
  const { state: resumed } = await dispatch({ type: "timer.start", expectedRevision: paused.revision });
  assert.equal(resumed.timer.phaseId, started.timer.phaseId);
  assert.notEqual(resumed.timer.runId, started.timer.runId);
  advance(resumed.timer.durationMs);

  const worker = restart();
  const { state: studyComplete } = await worker({ type: "state.get" });
  assert.deepEqual(studyComplete.delivery, { phaseId: resumed.timer.phaseId, runId: resumed.timer.runId });
  assert.equal(studyComplete.timer.status, "ready");
  assert.notEqual(studyComplete.timer.phaseId, resumed.timer.phaseId);
  await restart()({ type: "state.get" });
  assert.deepEqual(completions, [studyComplete.timer]);

  const { state: breakStarted } = await worker({ type: "timer.start", expectedRevision: studyComplete.revision });
  advance(breakStarted.timer.durationMs);
  const { state: breakComplete } = await worker({ type: "state.get" });
  assert.deepEqual(breakComplete.delivery, { phaseId: breakStarted.timer.phaseId, runId: breakStarted.timer.runId });
  assert.equal(breakComplete.timer.completedPhase, "shortBreak");
  assert.deepEqual(completions, [studyComplete.timer, breakComplete.timer]);
});

test("a saved Phase 2.1 running timer gets a delivery claim without replay on restart", async () => {
  const { delivery, ...legacy } = createInitialState();
  const { phaseId, runId, ...timer } = legacy.timer;
  legacy.timer = { ...timer, status: "running", endsAt: 10_000 };
  legacy.revision = 7;
  const { dispatch, restart, completions } = setup(legacy);
  const { state } = await dispatch({ type: "state.get" });
  assert.deepEqual(state.delivery, { phaseId: 0, runId: 7 });
  assert.equal(state.timer.completedPhase, "study");
  assert.deepEqual((await restart()({ type: "state.get" })).state, state);
  assert.deepEqual(completions, [state.timer]);
});

test("updating an active study starts tracking at the first read and records it once after a restart", async () => {
  const { studyIntervals, ...legacy } = createInitialState();
  const { studyStartedAt, expiredAt, ...timer } = legacy.timer;
  legacy.timer = { ...timer, status: "running", runId: 4, endsAt: 40_000, completedStudyBlocks: 6 };
  legacy.revision = 4;
  const { dispatch, advance, restart, completions } = setup(legacy);

  const { state } = await dispatch({ type: "state.get" });
  assert.equal(state.timer.studyStartedAt, 10_000);
  advance(60_000);
  const { state: completed } = await restart()({ type: "state.get" });
  assert.deepEqual(completed.studyIntervals, [{ startAt: 10_000, endAt: 40_000 }]);
  assert.equal(completed.timer.completedStudyBlocks, 7);
  assert.deepEqual((await restart()({ type: "state.get" })).state, completed);
  assert.equal(completions.length, 1);
});
