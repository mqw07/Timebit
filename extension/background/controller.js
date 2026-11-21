import { applyCommand, createInitialState, reconcile, STATE_KEY } from "../core/timer.js";

export function createController(storage, { now = Date.now, syncAlarms = async () => {} } = {}) {
  let queue = Promise.resolve();

  async function repairAlarms(timer) {
    try {
      await syncAlarms(timer);
    } catch (error) {
      console.error("Timebit could not synchronize its timer alarms.", error);
    }
  }

  async function handle(command) {
    const { [STATE_KEY]: saved } = await storage.get(STATE_KEY);
    if (saved !== undefined && saved?.schemaVersion !== 1) {
      throw new Error("Unsupported Timebit storage version.");
    }

    const previous = saved ?? createInitialState();
    const timestamp = now();
    const current = reconcile(previous, timestamp);
    let result = { state: current };
    if (command?.type !== "state.get") {
      if (command?.expectedRevision === current.revision) {
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
        await syncAlarms(timer);
        await storage.set({ [STATE_KEY]: result.state });
      } catch (error) {
        await repairAlarms(previous.timer);
        throw error;
      }
      return result;
    }

    if (result.state !== previous) {
      await storage.set({ [STATE_KEY]: result.state });
    }
    // Persist pauses and completions before clearing alarms. A queued wake then sees the new state.
    await repairAlarms(timer);
    return result;
  }

  return (command) => {
    const result = queue.then(() => handle(command));
    queue = result.catch(() => {});
    return result;
  };
}
