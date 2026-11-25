export function activeStudyInterval(timer, now) {
  if (timer.status !== "running" || timer.phase !== "study" || timer.studyStartedAt == null) return null;

  const startAt = timer.studyStartedAt;
  const endAt = Math.min(now, timer.endsAt);
  return endAt > startAt ? { startAt, endAt } : null;
}

export function studiedTodayMs(state, now) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const start = new Date(year, month, day).getTime();
  const end = new Date(year, month, day + 1).getTime();
  const overlap = ({ startAt, endAt }) => Math.max(0, Math.min(endAt, end) - Math.max(startAt, start));

  const recorded = (state.studyIntervals ?? []).reduce((total, interval) => total + overlap(interval), 0);
  const active = activeStudyInterval(state.timer, now);
  return recorded + (active ? overlap(active) : 0);
}

export function formatStudyDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds === 0) return "0 min";
  if (seconds < 60) return `${seconds} sec`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${String(minutes % 60).padStart(2, "0")} min`;
}
