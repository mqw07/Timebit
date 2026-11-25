import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanSchedule, createPlanPattern, localFinishTime, validatePlanDraft } from "../extension/core/planner.js";
import { defaultSettings, MINUTE_MS as minute } from "../extension/core/modes.js";

const afternoon = new Date(2026, 10, 24, 15, 30).getTime();
const draft = {
  mode: "pomodoro", finishAt: localFinishTime("17:00", afternoon), study: 25, shortBreak: 5,
};

test("a finish time uses today's local calendar and never rolls into tomorrow", () => {
  assert.equal(draft.finishAt, new Date(2026, 10, 24, 17).getTime());
  assert.deepEqual(validatePlanDraft(draft, afternoon), {});
  for (const time of ["", "24:00", "25:30", "17:79", "3:30", "09:00", "15:30"]) {
    assert.match(validatePlanDraft({ ...draft, finishAt: localFinishTime(time, afternoon) }, afternoon).finish, /later today/);
  }
  assert.match(validatePlanDraft({ ...draft, finishAt: new Date(2026, 10, 25, 17).getTime() }, afternoon).finish, /later today/);
});

test("a plan needs at least one minute and valid study and break preferences", () => {
  const invalid = { ...draft, mode: "other", study: 0.5, shortBreak: Infinity };
  assert.deepEqual(Object.keys(validatePlanDraft(invalid, afternoon)), ["mode", "study", "shortBreak"]);
  assert.match(validatePlanDraft({ ...draft, finishAt: afternoon + 59_999 }, afternoon).finish, /at least one minute/);
  assert.deepEqual(validatePlanDraft({ ...draft, finishAt: afternoon + 60_000, study: 1.5, shortBreak: 1 }, afternoon), {});
});

const settings = defaultSettings();
const pomodoro = createPlanPattern(draft, settings.pomodoro);
const lengths = (schedule) => schedule.map(({ durationMs }) => durationMs / minute);

test("Pomodoro fits the 90-minute example and queues long breaks only before further study", () => {
  assert.deepEqual(lengths(buildPlanSchedule(pomodoro, 90 * minute)), [25, 5, 25, 5, 30]);
  const longer = buildPlanSchedule(pomodoro, 101 * minute);
  assert.deepEqual(lengths(longer), [25, 5, 25, 5, 25, 15, 1]);
  assert.equal(longer.at(-2).phase, "longBreak");
  assert.deepEqual(lengths(buildPlanSchedule(pomodoro, 100 * minute)), [25, 5, 25, 5, 40]);
});

test("Cascade scales saved study lengths and uses one preferred short break", () => {
  const cascade = createPlanPattern({ study: 40, shortBreak: 8 }, settings.cascade);
  const schedule = buildPlanSchedule(cascade, 200 * minute);
  assert.deepEqual(lengths(schedule), [40, 8, 32, 8, 24, 8, 16, 8, 8, 25, 23]);
  assert.equal(schedule.at(-2).phase, "longBreak");
  assert.equal(schedule.at(-1).phase, "study");
});

test("generated schedules fill short, exact and long budgets deterministically", () => {
  const cascade = createPlanPattern({ study: 10, shortBreak: 1 }, settings.cascade);
  for (const pattern of [pomodoro, cascade]) {
    for (const budget of [minute, 3 * minute, 25 * minute, 30 * minute, 31 * minute, 90 * minute + 17_311, 24 * 60 * minute]) {
      const phases = buildPlanSchedule(pattern, budget);
      assert.deepEqual(phases, buildPlanSchedule(pattern, budget));
      assert.equal(phases.reduce((total, { durationMs }) => total + durationMs, 0), budget);
      assert.equal(phases[0].phase, "study");
      assert.equal(phases.at(-1).phase, "study");
      for (const [index, phase] of phases.entries()) {
        assert.ok(Number.isSafeInteger(phase.durationMs) && phase.durationMs >= minute);
        assert.equal(phase.phase === "study", index % 2 === 0);
      }
    }
    for (const budget of [minute - 1, 0, -1, Infinity, NaN]) assert.deepEqual(buildPlanSchedule(pattern, budget), []);
  }
});
