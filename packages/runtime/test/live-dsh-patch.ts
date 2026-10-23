// Does DeepSeek Harness still take a chat's instructions? On the CLI's own install:
//   node packages/runtime/test/live-dsh-patch.ts [model]
// A bot's whole prompt rides on one patched entry of the acp profile, which DSH silently skips when
// it no longer matches — so run this after every DSH upgrade. Without a model it only dumps the
// composed config (a second or so, no quota): does the patch land, and which fields of that entry
// does it replace wholesale. With a model it also proves the text reached the model, which is the
// only way to catch a field that DSH stopped rendering.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshAdapter, inspectPromptPatch } from "../src/adapters/dsh.ts";
import type { RuntimeEvent } from "../src/types.ts";

const [model] = process.argv.slice(2);
const info = await inspectPromptPatch();
console.log(JSON.stringify(info, null, 2));
// Not a failure of ours: the profile's entry moved, so every DSH bot would run on DSH's own prompt.
if (!info.lands) {
  console.error("no entry for the chat patch: DSH skips it, so every DSH bot would run on DSH's own prompt. Update PROMPT_ENTRY in packages/runtime/src/adapters/dsh.ts.");
  process.exit(1);
}
// Not a failure either, but a field DSH added is now reset to its default in every DSH chat.
if (info.replaced.length) console.warn(`the patch replaces these fields wholesale (they fall back to DSH defaults): ${info.replaced.join(", ")}`);
if (!model) process.exit(0);

const codeword = `QZ7-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const session = await new DshAdapter().open({
  key: `live-dsh-patch-${Date.now()}`,
  cwd: mkdtempSync(join(tmpdir(), "dsh-live-patch-")),
  ...(model ? { model } : {}),
  systemPrompt: `The codeword is ${codeword}. When the user asks for the codeword, answer with it and nothing else.`,
  mcpServers: {},
  trustedTools: [],
  approvals: async () => ({ behavior: "allow" }),
});
let answer = "";
const ended = new Promise<void>((resolve) => {
  session.on((event: RuntimeEvent) => {
    if (event.type === "item" && event.item.type === "assistant_message") answer = event.item.text;
    if (event.type === "turn_ended") resolve();
  });
});
await session.send({ text: "What is the codeword? Answer with it only." }, { whenBusy: "reject", clientMessageId: "codeword" });
await ended;
await session.close();
const pass = answer.includes(codeword);
console.log(JSON.stringify({ codeword, answer: answer.trim(), pass }, null, 2));
if (!pass) console.error("the instructions never reached the model: the entry still takes the patch, but its text isn't rendered.");
process.exit(pass ? 0 : 1);
