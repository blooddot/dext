/** Keep provider diagnostics in the message so they survive UI/history serialization. */
export function codexErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = value as Record<string, unknown>;
  const message = typeof error.message === "string" && error.message ? error.message : fallback;
  const details = Object.fromEntries(Object.entries(error).filter(([key, field]) => key !== "message" && field != null));
  return Object.keys(details).length ? `${message}\n\nCodex error details:\n${JSON.stringify(details, null, 2)}` : message;
}
