export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1) return "<1ms";
  const milliseconds = Math.round(durationMs);
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) {
    const seconds = Math.floor(milliseconds / 1_000);
    const remainder = milliseconds % 1_000;
    return `${seconds}s${remainder ? `${remainder}ms` : ""}`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m${seconds ? `${seconds}s` : ""}`;
}
