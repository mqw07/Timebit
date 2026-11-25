export function renderProgress(progress, remaining, duration) {
  const percent = duration ? 100 * remaining / duration : 0;
  progress.style.strokeDasharray = percent >= 100 ? "none" : `${percent} 100`;
  progress.style.visibility = percent > 0 ? "visible" : "hidden";
}
