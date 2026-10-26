import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lower-cases and joins words with dashes", () => assert.equal(slugify("Hello, World!"), "hello-world"));
test("removes accents", () => assert.equal(slugify("  Crème brûlée  "), "creme-brulee"));
test("collapses runs of separators", () => assert.equal(slugify("a--b__c"), "a-b-c"));
test("keeps digits", () => assert.equal(slugify("100% Pure"), "100-pure"));
test("empty stays empty", () => assert.equal(slugify("***"), ""));
test("cuts at a dash boundary", () => assert.equal(slugify("The quick brown fox", { maxLength: 10 }), "the-quick"));
test("cuts a single long word hard", () => assert.equal(slugify("Supercalifragilistic", { maxLength: 5 }), "super"));
