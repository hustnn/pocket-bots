/** -1, 0 or 1: precedence of two versions per Semantic Versioning 2.0.0 (build metadata ignored). */
export function compare(a, b) {
  throw new Error("not implemented");
}

/**
 * Whether a version satisfies a range: an exact version, ^x.y.z, ~x.y.z, or comparators
 * (>=, >, <=, <, =) separated by spaces, all of which must hold.
 */
export function satisfies(version, range) {
  throw new Error("not implemented");
}
