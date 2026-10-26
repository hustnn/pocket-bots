import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, satisfies } from "../src/semver.js";

test("orders by major, minor, patch", () => {
  assert.equal(compare("1.0.0", "2.0.0"), -1);
  assert.equal(compare("1.10.0", "1.9.9"), 1);
  assert.equal(compare("1.2.3", "1.2.3"), 0);
});
test("puts a prerelease before its release", () => assert.equal(compare("1.0.0-alpha", "1.0.0"), -1));
test("compares prerelease identifiers", () => {
  assert.equal(compare("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compare("1.0.0-beta.11", "1.0.0-beta.2"), 1);
  assert.equal(compare("1.0.0-alpha", "1.0.0-alpha.1"), -1);
});
test("ignores build metadata", () => assert.equal(compare("1.0.0+build.5", "1.0.0"), 0));
test("caret ranges", () => {
  assert.equal(satisfies("1.4.2", "^1.2.3"), true);
  assert.equal(satisfies("2.0.0", "^1.2.3"), false);
  assert.equal(satisfies("0.2.5", "^0.2.3"), true);
  assert.equal(satisfies("0.3.0", "^0.2.3"), false);
});
test("tilde ranges", () => {
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
});
test("comparator sets", () => {
  assert.equal(satisfies("1.5.0", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfies("2.0.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfies("1.2.3", "1.2.3"), true);
});
test("prereleases don't satisfy a plain range", () => assert.equal(satisfies("1.5.0-rc.1", "^1.2.3"), false));
