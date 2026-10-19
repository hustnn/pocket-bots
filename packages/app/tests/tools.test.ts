import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../src/shared/bot";
import { botToolName } from "../src/shared/bot-tools";
import { proposalIdOf } from "../src/shared/proposals";
import { expandLearn, sanitizeSkillName } from "../src/shared/skills";
import { newUuid } from "../src/shared/uuid";
import { fakeHost, makeBot } from "./helpers";

describe("tool names and grants", () => {
  it("recognises the plugin's tools whatever the provider calls them", () => {
    expect(botToolName("mcp__bots__ask_bot")).toBe("ask_bot");
    expect(botToolName("bots.propose_skill")).toBe("propose_skill");
    expect(botToolName("bots_list_bots")).toBe("list_bots");
    expect(botToolName("mcp__other__ask_bot")).toBeNull();
    expect(botToolName("bots.unknown")).toBeNull();
  });

  it("expands /learn", () => {
    expect(expandLearn("/learn")).toContain("propose_skill");
    expect(expandLearn("  /learn the invoice part ")).toContain("Focus on: the invoice part.");
    expect(expandLearn("/learner")).toBeNull();
    expect(expandLearn("please /learn")).toBeNull();
  });

  it("finds the proposal behind a finished propose_skill call", () => {
    const output = [{ type: "text", text: "Proposal p-0123456789: the user sees..." }];
    expect(proposalIdOf({ name: "mcp__bots__propose_skill", status: "completed", detail: { type: "unknown", input: {}, output } })).toBe("p-0123456789");
    expect(proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { type: "unknown", input: {}, output: "Proposal p-abcdefabcd: x" } })).toBe("p-abcdefabcd");
    expect(proposalIdOf({ name: "mcp__bots__propose_skill", status: "running", detail: { type: "unknown", input: {}, output: null } })).toBeNull();
    expect(proposalIdOf({ name: "mcp__bots__list_bots", status: "completed", detail: { type: "unknown", input: {}, output } })).toBeNull();
  });

  it("keeps skill folder names inside the library", () => {
    expect(sanitizeSkillName("..")).toBe("skill");
    expect(sanitizeSkillName(".hidden.")).toBe("hidden");
    expect(sanitizeSkillName("v1.2 notes")).toBe("v1.2-notes");
  });

  it("makes v4 UUIDs for agent ids", () => {
    expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("the bots MCP server", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pocket-bots-tools-"));
    process.env.POCKET_BOTS_HOME = home;
  });
  afterAll(async () => {
    delete process.env.POCKET_BOTS_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("serves the MCP handshake, lists its tools and runs them for one chat", async () => {
    const { Relay } = await import("../src/server/relay");
    const { BOT_TOOLS } = await import("../src/server/tools");
    const host = fakeHost([makeBot({ id: "bot-a", name: "Scout", title: "Researcher" }), makeBot({ id: "bot-b", name: "Inbox", description: "Email triage" }), makeBot({ id: "bot-c", archived: true })]);
    const relay = new Relay(host, BOT_TOOLS, { port: 0 });
    try {
      const agentId = newUuid();
      const mount = (await relay.mountTools("bot-a", agentId)) as { url: string; headers: Record<string, string> };
      expect(mount.url).toContain(`/bots/bot-a/${agentId}`);
      const post = (body: unknown, token = mount.headers.Authorization!, url = mount.url) =>
        fetch(url, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify(body) });

      const init = (await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("pocket-bots");
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

      const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
      expect(list.result.tools.map((tool) => tool.name)).toContain("list_bots");
      expect(list.result.tools[0]!.inputSchema.type).toBe("object");

      const call = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } })).json()) as { result: { content: { text: string }[] } };
      expect(call.result.content[0]!.text).toBe("- Inbox (id: bot-b): Email triage");

      // A token for another chat, or another bot's URL, is refused.
      expect((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "Bearer nope")).status).toBe(401);
      expect((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, mount.headers.Authorization!, mount.url.replace(agentId, newUuid()))).status).toBe(401);
      const unknown = (await (await post({ jsonrpc: "2.0", id: 6, method: "nope" })).json()) as { error: { code: number } };
      expect(unknown.error.code).toBe(-32601);
      expect(list.result.tools.map((tool) => tool.name)).not.toContain("group_send");

      // A group chat's seat gets the group's tools from its address, with nothing else to look up.
      const seat = (await relay.mountTools("bot-a", agentId, "group-abc")) as { url: string; headers: Record<string, string> };
      expect(seat.url).toContain(`/bots/bot-a/${agentId}/group-abc`);
      const seatList = (await (await post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, seat.headers.Authorization!, seat.url)).json()) as { result: { tools: { name: string }[] } };
      expect(seatList.result.tools.map((tool) => tool.name).slice(0, 2)).toEqual(["group_send", "group_send_draft"]);
      // The plain chat's token doesn't open the seat's address.
      expect((await post({ jsonrpc: "2.0", id: 8, method: "tools/list" }, mount.headers.Authorization!, seat.url)).status).toBe(401);
    } finally {
      relay.stop();
    }
  });

  it("proposes a skill that the user saves or dismisses once", async () => {
    const { proposeSkill } = await import("../src/server/tools/skills");
    const { acceptProposal, dismissProposal, getProposal } = await import("../src/server/proposals");
    const { librarySkillPath } = await import("../src/server/library");
    const host = fakeHost([makeBot({ id: "bot-a" })]);
    const caller = { bot: makeBot({ id: "bot-a" }), agentId: newUuid(), host, relay: null as never };
    const reply = await proposeSkill.run({ name: "Weekly Report!", description: "Use for the\nweekly report", instructions: "1. Collect PRs." }, caller);
    const id = proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { output: reply } })!;
    expect(id).toMatch(/^p-[a-z0-9]{10}$/);

    const proposal = await getProposal(id);
    expect(proposal).toMatchObject({ botId: "bot-a", agentId: caller.agentId, kind: "skill", status: "pending", data: { name: "weekly-report", description: "Use for the weekly report" } });
    expect(proposal!.kind === "skill" && proposal!.data.text).toBe("---\nname: weekly-report\ndescription: Use for the weekly report\n---\n\n1. Collect PRs.\n");

    const accepted = await acceptProposal(id);
    expect(accepted.proposal.status).toBe("accepted");
    expect(accepted.skill).toMatchObject({ id: "weekly-report", description: "Use for the weekly report" });
    expect(await readFile(join(librarySkillPath("weekly-report"), "SKILL.md"), "utf8")).toBe(proposal!.kind === "skill" ? proposal!.data.text : "");
    await expect(acceptProposal(id)).rejects.toThrow("already saved");
    await expect(dismissProposal(id)).rejects.toThrow("already saved");

    const other = proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { output: await proposeSkill.run({ name: "x", description: "y", instructions: "z" }, caller) } })!;
    expect((await dismissProposal(other)).status).toBe("dismissed");
    await expect(acceptProposal(other)).rejects.toThrow("dismissed");
    await expect(acceptProposal("p-0000000000")).rejects.toThrow("no longer available");
  });
});
