# textkit

Four small utilities, each in its own module under `src/`, each with its tests under `test/`.
Run `npm test` (Node's built-in test runner). No dependencies.

- `src/slugify.js` — `slugify(text, { maxLength })`: URL slugs.
- `src/duration.js` — `parseDuration(text)` and `formatDuration(ms)`.
- `src/semver.js` — `compare(a, b)` and `satisfies(version, range)` (Semantic Versioning 2.0.0).
- `src/wrap.js` — `wrapText(text, width)`: greedy word wrap.
