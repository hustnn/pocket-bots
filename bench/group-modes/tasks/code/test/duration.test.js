import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseDuration } from "../src/duration.js";

test("parses seconds", () => assert.equal(parseDuration("90s"), 90_000));
test("parses combined units", () => assert.equal(parseDuration("1h30m"), 5_400_000));
test("parses with spaces and days", () => assert.equal(parseDuration("2d 4h"), 187_200_000));
test("parses milliseconds", () => assert.equal(parseDuration("250ms"), 250));
test("parses fractions", () => assert.equal(parseDuration("1.5h"), 5_400_000));
test("rejects malformed input", () => {
  for (const bad of ["", "abc", "5x", "h1"]) assert.throws(() => parseDuration(bad));
});
test("formats largest units first", () => assert.equal(formatDuration(5_400_000), "1h 30m"));
test("formats zero and sub-second", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(250), "250ms");
});
test("formats every unit", () => assert.equal(formatDuration(90_061_000), "1d 1h 1m 1s"));
