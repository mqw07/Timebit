import { MINUTE_MS } from "../core/modes.js";
import { remainingMs } from "../core/timer.js";

export const PHASE_END_ALARM = "timebit:phase-end";
export const BADGE_REFRESH_ALARM = "timebit:badge-refresh";

export async function syncTimerAlarms(alarms, timer, now = Date.now(), planFinishAt) {
  const running = timer.status === "running";
  const deadline = running ? timer.endsAt : planFinishAt;
  const phaseEnd = deadline ? alarms.get(PHASE_END_ALARM).then((alarm) => {
    if (alarm?.scheduledTime !== deadline || alarm.periodInMinutes != null) {
      return alarms.create(PHASE_END_ALARM, { when: deadline });
    }
  }) : alarms.clear(PHASE_END_ALARM);
  const badge = running ? syncBadgeAlarm(alarms, timer, now) : alarms.clear(BADGE_REFRESH_ALARM);
  const updates = await Promise.allSettled([phaseEnd, badge]);
  const failed = updates.find(({ status }) => status === "rejected");
  if (failed) throw failed.reason;
}

async function syncBadgeAlarm(alarms, timer, now) {
  const refresh = await alarms.get(BADGE_REFRESH_ALARM);
  if (refresh?.periodInMinutes !== 1) {
    const minutesLeft = Math.ceil(remainingMs(timer, now) / MINUTE_MS);
    const when = timer.endsAt - Math.max(0, minutesLeft - 1) * MINUTE_MS;
    await alarms.create(BADGE_REFRESH_ALARM, { when, periodInMinutes: 1 });
  }
}
