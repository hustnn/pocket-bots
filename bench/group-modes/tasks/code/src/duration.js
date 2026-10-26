/**
 * Parses "90s", "1h30m", "2d 4h", "250ms", "1.5h" into milliseconds. Units: d, h, m, s, ms.
 * Throws an Error on empty or malformed input.
 */
export function parseDuration(text) {
  throw new Error("not implemented");
}

/**
 * Formats milliseconds with the largest units first, skipping zero units, space separated:
 * 5400000 → "1h 30m", 0 → "0s", 250 → "250ms", 90061000 → "1d 1h 1m 1s".
 */
export function formatDuration(ms) {
  throw new Error("not implemented");
}
