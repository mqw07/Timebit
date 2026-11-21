export const PHASE_END_ALARM = "timebit:phase-end";
export const BADGE_REFRESH_ALARM = "timebit:badge-refresh";

export async function syncTimerAlarms(alarms, timer) {
  if (timer.status !== "running") {
    await Promise.all([alarms.clear(PHASE_END_ALARM), alarms.clear(BADGE_REFRESH_ALARM)]);
    return;
  }

  const [phaseEnd, refresh] = await Promise.all([
    alarms.get(PHASE_END_ALARM),
    alarms.get(BADGE_REFRESH_ALARM),
  ]);
  if (refresh?.periodInMinutes !== 1) {
    await alarms.create(BADGE_REFRESH_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }
  if (!phaseEnd || phaseEnd.scheduledTime !== timer.endsAt || phaseEnd.periodInMinutes != null) {
    await alarms.create(PHASE_END_ALARM, { when: timer.endsAt });
  }
}
