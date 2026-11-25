import { applyCommand, createInitialState, reconcile, STATE_KEY } from "../core/timer.js";
import { applyTaskCommand } from "../core/tasks.js";

export function createController(storage, {
  now = Date.now, syncAlarms = async () => {}, publishFeedback = async () => {}, playChime = async () => {},
  syncBlocking,
} = {}) {
  let queue = Promise.resolve();

  function scheduleAlarms({ timer, planner }) {
    return syncAlarms(timer, timer.status === "finished" ? null : planner?.finishAt);
  }

  async function repairAlarms(state) {
    try {
      await scheduleAlarms(state);
    } catch (error) {
      console.error("Timebit could not synchronize its timer alarms.", error);
    }
  }

  async function handle(command, context) {
    const { [STATE_KEY]: saved } = await storage.get(STATE_KEY);
    if (saved !== undefined && saved?.schemaVersion !== 1) {
      throw new Error("Unsupported Timebit storage version.");
    }

    const previous = saved ?? createInitialState();
    const timestamp = now();
    const current = reconcile(previous, timestamp);
    const preview = command?.type === "sound.preview";
    const distractionCommand = typeof command?.type === "string" && command.type.startsWith("distractions.");
    let result = { state: current };
    if (command?.type !== "state.get" && !preview) {
      if (typeof command?.type === "string" && command.type.startsWith("tasks.")) {
        result = applyTaskCommand(current, command, timestamp);
      } else if (distractionCommand || command?.expectedRevision === current.revision) {
        result = applyCommand(current, command, timestamp);
      } else {
        result = { state: current, error: "The timer changed. Try again." };
      }
    }

    const { timer } = result.state;
    const starting = timer.status === "running" && current.timer.status !== "running";
    if (starting) {
      // Arm the alarms before committing a new run so a failed start cannot leave an unscheduled timer.
      try {
        await scheduleAlarms(result.state);
        await storage.set({ [STATE_KEY]: result.state });
      } catch (error) {
        await repairAlarms(previous);
        throw error;
      }
    } else {
      if (result.state !== previous) {
        await storage.set({ [STATE_KEY]: result.state });
      }
      // Persist pauses and completions before clearing alarms. A queued wake then sees the new state.
      await repairAlarms(result.state);
    }

    if (syncBlocking) {
      try {
        result.activeBlockedSites = await syncBlocking(result.state, previous, context);
      } catch (error) {
        console.warn("Timebit could not synchronize distraction blocking.", error);
        if (distractionCommand) result.error ??= "Could not update website blocking. Try again.";
      }
    }

    const { delivery } = current;
    const alreadyClaimed = previous.delivery?.phaseId === delivery?.phaseId && previous.delivery?.runId === delivery?.runId;
    const completion = delivery && !alreadyClaimed ? current.timer : null;
    await publishFeedback(result.state, { now: now(), completion });
    if (preview && completion?.completedPhase !== "study") {
      try {
        await playChime(result.state.settings);
      } catch (error) {
        console.warn("Timebit could not preview the completion sound.", error);
        return { ...result, error: "Timebit could not play the chime. Try again." };
      }
    }
    return result;
  }

  return (command, context) => {
    const result = queue.then(() => handle(command, context));
    queue = result.catch(() => {});
    return result;
  };
}
