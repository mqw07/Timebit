import assert from "node:assert/strict";
import test from "node:test";
import { formatStudyDuration, studiedTodayMs } from "../extension/core/study-time.js";
import { applyCommand, createInitialState, reconcile } from "../extension/core/timer.js";

const minute = 60_000;
const noon = new Date(2026, 10, 21, 12).getTime();

test("today includes running and partial studies while excluding pauses, breaks, and waiting", () => {
  let state = createInitialState();
  const at = (minutes) => noon + minutes * minute;
  function apply(type, minutes, options = {}) {
    state = applyCommand(state, { type, ...options }, at(minutes)).state;
  }

  apply("timer.start", 0);
  assert.deepEqual(state.studyIntervals, []);
  assert.equal(studiedTodayMs(state, at(1)), minute);
  apply("timer.pause", 2);
  assert.equal(studiedTodayMs(state, at(7)), 2 * minute);
  apply("timer.start", 7);
  apply("timer.skip", 10);
  assert.equal(studiedTodayMs(state, at(12)), 5 * minute);
  apply("timer.start", 12);
  assert.equal(studiedTodayMs(state, at(13)), 5 * minute);
  apply("timer.skip", 13);
  apply("timer.start", 14);
  apply("timer.reset", 18);
  assert.equal(studiedTodayMs(state, at(19)), 9 * minute);
  apply("timer.start", 20);
  apply("mode.select", 21, { mode: "cascade" });

  assert.deepEqual(state.studyIntervals, [[0, 2], [7, 10], [14, 18], [20, 21]].map(([start, end]) => ({
    startAt: at(start), endAt: at(end),
  })));
  assert.equal(studiedTodayMs(state, at(30)), 10 * minute);
  assert.equal(state.timer.completedStudyBlocks, 0);
});

test("a study straddling local midnight only contributes its overlap with the displayed day", () => {
  const startAt = new Date(2026, 10, 21, 23, 58).getTime();
  const midnight = new Date(2026, 10, 22).getTime();
  const { state: running } = applyCommand(createInitialState(), { type: "timer.start" }, startAt);
  assert.equal(studiedTodayMs(running, midnight - minute), minute);
  assert.equal(studiedTodayMs(running, midnight), 0);
  assert.equal(studiedTodayMs(running, midnight + 2 * minute), 2 * minute);

  const done = reconcile(running, midnight + 60 * minute);
  assert.deepEqual(done.studyIntervals, [{ startAt, endAt: running.timer.endsAt }]);
  assert.equal(studiedTodayMs(done, midnight + 70 * minute), 23 * minute);
  assert.equal(studiedTodayMs(done, new Date(2026, 10, 23).getTime()), 0);
});

test("the footer format shows partial minutes and pads minutes after an hour", () => {
  assert.equal(formatStudyDuration(0), "0 min");
  assert.equal(formatStudyDuration(2_100), "2 sec");
  assert.equal(formatStudyDuration(7 * minute), "7 min");
  assert.equal(formatStudyDuration(65 * minute), "1 hr 05 min");
});
