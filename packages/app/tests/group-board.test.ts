// The board's pure logic (shared/group-board.ts): refs and the rules for publishing, the ranking
// (BM25 plus citation weight) and what bots read.
import { describe, expect, it } from "vitest";
import {
  BOARD_CITE_STEP,
  BOARD_DECAY,
  boardEntryProblem,
  boardEntryText,
  boardSearchText,
  boardTokens,
  citationWeights,
  citersOf,
  claimKey,
  namesRef,
  parseBoardRef,
  rankBoard,
  type BoardEntry,
} from "../src/shared/group-board";

const entry = (number: number, subTask: string, refs: string[] = [], artifact = "result", rationale = refs.length ? `built on ${refs.join(", ")}` : "read the code"): BoardEntry => ({
  number,
  authorId: "alpha",
  round: null,
  subTask,
  artifact,
  rationale,
  refs,
  claim: null,
  createdAt: "2026-10-25T00:00:00.000Z",
});

describe("board refs and the rules for publishing", () => {
  it("reads entries and messages as refs, and nothing else", () => {
    expect(parseBoardRef("B3")).toEqual({ kind: "entry", number: 3 });
    expect(parseBoardRef("#12")).toEqual({ kind: "message", seq: 12 });
    for (const bad of ["B0", "b3", "B03", "#0", "msg:3", "B3x", "3"]) expect(parseBoardRef(bad)).toBeNull();
  });

  it("counts a ref as named only as a token of its own", () => {
    expect(namesRef("B1 gave the list", "B1")).toBe(true);
    expect(namesRef("as B12 found", "B1")).toBe(false);
    expect(namesRef("(B1)", "B1")).toBe(true);
    expect(namesRef("#12 asked for it", "#1")).toBe(false);
    expect(namesRef("the request (#12) asked", "#12")).toBe(true);
    expect(namesRef("B1的列表", "B1")).toBe(false);
    expect(namesRef("B1 的列表", "B1")).toBe(true);
  });

  it("refuses an entry whose refs don't exist or aren't named, and one past its bounds", () => {
    const exists = (ref: { kind: string; number?: number; seq?: number }) => (ref.kind === "entry" ? ref.number! <= 2 : ref.seq === 5);
    const base = { subTask: "I've checked it", artifact: "fine", rationale: "B1 listed it; #5 asked", refs: ["B1", "#5"] };
    expect(boardEntryProblem(base, exists)).toBeNull();
    expect(boardEntryProblem({ ...base, refs: ["B3"], rationale: "B3 listed it" }, exists)).toMatch(/B3 doesn't exist/);
    expect(boardEntryProblem({ ...base, rationale: "B1 listed it" }, exists)).toMatch(/doesn't name #5/);
    expect(boardEntryProblem({ ...base, refs: ["B1", "B1"] }, exists)).toMatch(/listed twice/);
    expect(boardEntryProblem({ ...base, refs: ["msg:1"] }, exists)).toMatch(/isn't a ref/);
    expect(boardEntryProblem({ ...base, artifact: "x".repeat(2_001) }, exists)).toMatch(/artifact is 2001 characters/);
    expect(boardEntryProblem({ ...base, subTask: "  " }, exists)).toMatch(/all required/);
    expect(boardEntryProblem({ ...base, claim: "   " }, exists)).toMatch(/claim names the piece/);
  });

  it("keeps one claim per piece however it's written", () => {
    expect(claimKey("  src/Slugify.ts ")).toBe("src/slugify.ts");
    expect(claimKey("Part  ONE")).toBe("part one");
  });
});

describe("board ranking", () => {
  it("splits CJK runs into character pairs, so a Chinese query matches part of a phrase", () => {
    expect(boardTokens("登录页白屏 fix")).toEqual(["登录页白屏", "登录", "录页", "页白", "白屏", "fix"]);
    const entries = [entry(1, "我已检查登录页白屏的原因"), entry(2, "I've checked the payment page")];
    expect(rankBoard(entries, "白屏").map((ranked) => ranked.number)).toEqual([1]);
  });

  it("returns only entries the query matches, best first, the earlier one on a tie", () => {
    const entries = [entry(1, "I've listed the retry limits in api.md"), entry(2, "I've checked the docs build"), entry(3, "I've listed the retry limits in api.md")];
    expect(rankBoard(entries, "retry limits").map((ranked) => ranked.number)).toEqual([1, 3]);
    expect(rankBoard(entries, "nothing like it")).toEqual([]);
  });

  it("raises an entry each later entry cites, and decays every weight as the board grows", () => {
    const entries = [entry(1, "first"), entry(2, "second", ["B1"]), entry(3, "third", ["B1"])];
    const weights = citationWeights(entries);
    // Cited at 2 (0.3), decayed one step, cited again at 3.
    const at3 = BOARD_CITE_STEP * BOARD_DECAY + BOARD_CITE_STEP * (1 - BOARD_CITE_STEP * BOARD_DECAY);
    expect(weights.get(1)).toBeCloseTo(at3, 10);
    expect(weights.has(2)).toBe(false);
    // Three uncited entries later, it has decayed three steps.
    const later = [...entries, entry(4, "x"), entry(5, "y"), entry(6, "z")];
    expect(citationWeights(later).get(1)).toBeCloseTo(at3 * BOARD_DECAY ** 3, 10);
  });

  it("lets weight reorder relevant entries but never bring in an unrelated one", () => {
    // B1 and B2 match equally; B3 cites B2, so B2 ranks first. B3 itself doesn't match "parser".
    const entries = [entry(1, "I've fixed the parser bug"), entry(2, "I've fixed the parser bug"), entry(3, "I've reviewed it", ["B2"])];
    expect(rankBoard(entries, "parser bug").map((ranked) => ranked.number)).toEqual([2, 1]);
    expect(rankBoard(entries, "parser").some((ranked) => ranked.number === 3)).toBe(false);
  });

  it("shows bots an entry's fields and links, never its author or weight", () => {
    const entries = [entry(1, "I've listed the files", [], "a.ts, b.ts"), { ...entry(2, "I've taken a.ts", ["B1"]), claim: "a.ts" }];
    const citers = citersOf(entries);
    const text = boardEntryText(entries[0]!, citers.get(1));
    expect(text).toBe("B1 — I've listed the files\nArtifact: a.ts, b.ts\nRationale: read the code\nCited by: B2");
    expect(boardEntryText(entries[1]!)).toContain("Takes: a.ts");
    expect(text).not.toContain("alpha");
    expect(boardSearchText("files", rankBoard(entries, "files"), entries.length, citers)).toMatch(/^1 of the board's 2 entries match "files"; the best:/);
    expect(boardSearchText("x", [], 0, citers)).toMatch(/board is empty/);
  });
});
