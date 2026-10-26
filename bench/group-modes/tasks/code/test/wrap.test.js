import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapText } from "../src/wrap.js";

test("wraps greedily", () => assert.equal(wrapText("the quick brown fox jumps", 10), "the quick\nbrown fox\njumps"));
test("splits words longer than the width", () => assert.equal(wrapText("abcdefghijkl", 5), "abcde\nfghij\nkl"));
test("keeps paragraphs", () => assert.equal(wrapText("a b\n\nc d", 3), "a b\n\nc d"));
test("collapses spaces", () => assert.equal(wrapText("a   b", 10), "a b"));
test("empty stays empty", () => assert.equal(wrapText("", 10), ""));
test("a word exactly the width fits", () => assert.equal(wrapText("abcde fgh", 5), "abcde\nfgh"));
