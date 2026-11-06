/** Marks where a value was cut. A command's conclusion matters as much as its
 * start, so both ends are kept. */
export const TRUNCATION_MARKER = "\n... output truncated ...\n";

/** Keeps the first and last half of `maxLength`. Callers check the length first. */
export function truncateMiddle(value: string, maxLength: number, marker = TRUNCATION_MARKER): string {
  const head = Math.ceil(maxLength / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (maxLength - head))}`;
}
