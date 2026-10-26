/**
 * A URL slug: lower case ASCII letters and digits joined by single dashes. Accents are removed
 * ("crème" → "creme"); every other run of characters becomes one dash; no dash at either end.
 * With maxLength, the slug is cut to at most that many characters at a dash boundary when it can be.
 */
export function slugify(text, { maxLength } = {}) {
  throw new Error("not implemented");
}
