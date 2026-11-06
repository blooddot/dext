/** Ranking for the composer's `@` file picker. Kept free of vscode imports so
 * that the scoring is unit testable on its own. */

const SEGMENT_BOUNDARIES = "/-_. ";
const ADJACENT_BONUS = 8;
const BOUNDARY_BONUS = 6;
const BASENAME_BONUS = 20;
const LENGTH_PENALTY_DIVISOR = 8;

function segmentCount(path: string): number {
  let count = 1;
  for (const character of path) if (character === "/") count += 1;
  return count;
}

/** Scores a subsequence match, or returns undefined when the query does not
 * appear in the path at all. Higher is better. */
export function fileMatchScore(path: string, query: string): number | undefined {
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) return undefined;
    // A run of adjacent characters is what makes a hit look like the thing
    // that was typed rather than letters scattered down a long path.
    if (index === previous + 1) score += ADJACENT_BONUS;
    if (index === 0 || SEGMENT_BOUNDARIES.includes(haystack[index - 1] ?? "")) score += BOUNDARY_BONUS;
    previous = index;
    cursor = index + 1;
  }
  // People type file names far more often than directory names, so a match
  // that reaches the basename outranks one buried in the directory part.
  if (previous >= haystack.lastIndexOf("/") + 1) score += BASENAME_BONUS;
  return score - Math.floor(haystack.length / LENGTH_PENALTY_DIVISOR);
}

/** Picks the best `limit` paths for `query`. An empty query lists the shallowest
 * paths, which is the closest thing to "the files you would name first". */
export function rankFileMatches(
  paths: readonly string[],
  query: string,
  limit: number
): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [...paths]
      .sort((left, right) => segmentCount(left) - segmentCount(right) || left.localeCompare(right))
      .slice(0, limit);
  }
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = fileMatchScore(path, trimmed);
    if (score !== undefined) scored.push({ path, score });
  }
  return scored
    .sort((left, right) => right.score - left.score
      || left.path.length - right.path.length
      || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((item) => item.path);
}
