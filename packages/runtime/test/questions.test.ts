import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/adapters/fake.ts";
import { answersInOrder, claudeAnswered, codexAnswers, codexQuestion, grokAnswers, grokQuestion, opencodeFormAnswer, opencodeQuestion, questionsOf, splitChoices } from "../src/questions.ts";
import type { ApprovalDecision, ApprovalRequest, SessionSpec } from "../src/types.ts";

// The web form answers by header; each CLI wants its own keys back.
const allow = (answers: Record<string, string>): ApprovalDecision => ({ behavior: "allow", updatedInput: { answers } });

describe("questions an agent asks the user", () => {
  it("reads each question's answer by its text or its header, in order", () => {
    const questions = questionsOf({ questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }] }, { question: "Ship today?", header: "When", options: [] }] })!;
    expect(questions.map((question) => question.header)).toEqual(["DB", "When"]);
    expect(answersInOrder(questions, allow({ DB: "Postgres" }))).toEqual(["Postgres", null]);
    expect(answersInOrder(questions, allow({ "Ship today?": "Yes" }))).toEqual([null, "Yes"]);
    expect(answersInOrder(questions, { behavior: "deny" })).toEqual([null, null]);
    expect(questionsOf({ questions: [] })).toBeNull();
    expect(questionsOf({ nothing: true })).toBeNull();
  });

  it("splits a multi-select answer back into its picks, a label with a comma and a typed answer included", () => {
    expect(splitChoices("Red, Blue", ["Red", "Blue", "Green"])).toEqual(["Red", "Blue"]);
    expect(splitChoices("Salt, pepper, Oil", ["Salt, pepper", "Oil"])).toEqual(["Salt, pepper", "Oil"]);
    expect(splitChoices("Red, something else", ["Red", "Blue"])).toEqual(["Red", "something else"]);
    expect(splitChoices("", ["Red"])).toEqual([]);
  });

  it("gives Claude Code its AskUserQuestion answers keyed by question text", () => {
    const input = { questions: [{ question: "Which colour do you prefer?", header: "Colour", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiSelect: false }] };
    expect(claudeAnswered(input, { behavior: "allow", updatedInput: { ...input, answers: { Colour: "Blue" } } })).toEqual({ ...input, answers: { "Which colour do you prefer?": "Blue" } });
  });

  it("asks Codex's request_user_input as a question and answers by question id; a secret one is marked", () => {
    const params = {
      threadId: "t",
      turnId: "u",
      itemId: "item-1",
      isBlocking: true,
      questions: [
        { id: "q-db", header: "DB", question: "Which database?", isOther: true, isSecret: false, options: [{ label: "Postgres", description: "Relational" }] },
        { id: "q-token", header: "Token", question: "Paste the deploy token", isOther: false, isSecret: true, options: null },
      ],
    };
    const request = codexQuestion(params);
    expect(request).toMatchObject({ id: "item-1", provider: "codex", kind: "question", metadata: { secret: true } });
    expect(questionsOf(request.input)?.map((question) => [question.header, question.isOther ?? false, question.isSecret ?? false, question.options.length])).toEqual([
      ["DB", true, false, 1],
      ["Token", false, true, 0],
    ]);
    expect(codexAnswers(params, allow({ DB: "Postgres", "Paste the deploy token": "abc" }))).toEqual({ answers: { "q-db": { answers: ["Postgres"] }, "q-token": { answers: ["abc"] } } });
    expect(codexAnswers(params, { behavior: "deny" })).toEqual({ answers: {} });
  });

  it("asks OpenCode's question form and answers each field by its key, a multiselect one as a list", () => {
    const form = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "m", id: "c" } },
      fields: [
        { key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }], custom: true },
        { key: "q1", title: "Toppings", description: "Which toppings?", type: "multiselect", options: [{ value: "Cheese", label: "Cheese" }, { value: "Ham", label: "Ham" }], custom: true },
      ],
    };
    const request = opencodeQuestion(form)!;
    expect(request).toMatchObject({ id: "frm_1", provider: "opencode", kind: "question" });
    expect(questionsOf(request.input)?.map((question) => [question.question, question.header, question.multiSelect])).toEqual([
      ["Which colour?", "Colour", false],
      ["Which toppings?", "Toppings", true],
    ]);
    expect(opencodeFormAnswer(form, allow({ Colour: "Blue", Toppings: "Cheese, Ham, Olives" }))).toEqual({ q0: "Blue", q1: ["Cheese", "Ham", "Olives"] });
    // Another kind of form isn't a question.
    expect(opencodeQuestion({ ...form, metadata: { kind: "elicitation" } })).toBeNull();
  });

  it("asks Grok Build's ask_user_question and answers accepted by question text, or cancelled", () => {
    // As Grok Build 1.0.62 sends it over ACP (_x.ai/ask_user_question): no header.
    const params = { sessionId: "s", toolCallId: "call-1", mode: "default", questions: [{ question: "Which colour do you prefer?", options: [{ label: "Red", description: "You prefer red." }, { label: "Blue", description: "You prefer blue." }], multiSelect: null }] };
    const request = grokQuestion(params);
    expect(request).toMatchObject({ id: "call-1", provider: "grok", kind: "question" });
    expect(questionsOf(request.input)?.[0]).toMatchObject({ header: "Question", multiSelect: false, isOther: true });
    expect(grokAnswers(params, allow({ Question: "Blue" }))).toEqual({ outcome: "accepted", answers: { "Which colour do you prefer?": "Blue" } });
    expect(grokAnswers(params, { behavior: "deny", message: "Dismissed by user" })).toEqual({ outcome: "cancelled" });
  });

  it("lets a test script ask a question and read the decision", async () => {
    const asked: ApprovalRequest[] = [];
    const spec: SessionSpec = {
      key: "k",
      cwd: "/tmp",
      systemPrompt: "",
      mcpServers: {},
      trustedTools: [],
      approvals: async (request) => {
        asked.push(request);
        return allow({ Colour: "Blue" });
      },
    };
    const session = await new FakeAdapter((turn, step) => (step === 0 ? { ask: { name: "AskUserQuestion", kind: "question", input: { questions: [{ question: "Colour?", header: "Colour", options: [] }] } } } : step === 1 ? { say: turn.results[0]! } : null)).open(spec);
    const said = new Promise<string>((resolve) => session.on((event) => event.type === "item" && event.item.type === "assistant_message" && resolve(event.item.text)));
    await session.send({ text: "go" }, { whenBusy: "reject", clientMessageId: "a" });
    expect(JSON.parse(await said)).toEqual({ behavior: "allow", updatedInput: { answers: { Colour: "Blue" } } });
    expect(asked[0]).toMatchObject({ provider: "fake", kind: "question" });
  });
});
