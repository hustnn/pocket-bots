import { describe, expect, it } from "vitest";
import { answerPrompt, askPrompt, failurePrompt, peerMessage } from "../src/shared/peers";

describe("messages between bots", () => {
  it("reads back what each builder wrote", () => {
    expect(peerMessage(askPrompt("Assistant, the lead", " Analyse D05 \n\n- price\n- news "))).toEqual({ kind: "request", bot: "Assistant, the lead", body: "Analyse D05 \n\n- price\n- news" });
    expect(peerMessage(answerPrompt("Scout", "chat-1", "## Trend\n\nFlat [source](https://example.com)."))).toEqual({ kind: "answer", bot: "Scout", body: "## Trend\n\nFlat [source](https://example.com)." });
    expect(peerMessage(failurePrompt("Scout", "chat-1", "The model refused."))).toEqual({ kind: "failure", bot: "Scout", body: "The model refused." });
  });

  it("leaves everything else alone", () => {
    expect(peerMessage("让 Scout 分析下走势")).toBeNull();
    expect(peerMessage("[draft] Answer from Scout, another bot on this computer, not from your user, ok]\n\nhi")).toBeNull();
    expect(peerMessage("[Answer from Scout, another bot on this computer, not from your user, but no body]")).toBeNull();
  });
});
