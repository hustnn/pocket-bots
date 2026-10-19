// The contract scenario as a scripted model (for runtimes without a usable login here).
import { textOf, type ChatMessage, type FakeStep } from "./fake-openai.ts";

export function contractScript(tools: { note: string; shell: string }): (messages: ChatMessage[]) => FakeStep {
  return (messages) => {
    const prompts = messages.map((m, i) => ({ m, i })).filter((x) => x.m.role === "user" && !textOf(x.m).includes("Extra instruction"));
    const last = prompts[prompts.length - 1]!;
    const since = messages.slice(last.i + 1);
    const calls = since.flatMap((m) => m.tool_calls ?? []).map((c) => c.function);
    const prompt = textOf(last.m);
    const steered = since.some((m) => m.role === "user" && textOf(m).includes("steer-2"));
    if (prompt.startsWith("Step 1")) {
      if (!calls.some((c) => c.name === tools.note)) return { tool: tools.note, args: { text: "hello-1" } };
      if (!calls.some((c) => c.name === tools.shell)) return { tool: tools.shell, args: { command: "touch contract.txt && sleep 12 && echo slept" } };
      if (steered && !calls.some((c) => c.arguments.includes("steer-2"))) return { tool: tools.note, args: { text: "steer-2" } };
      return { text: "FIN" };
    }
    if (prompt.includes("time.sleep(25)")) return calls.some((c) => c.name === tools.shell) ? { text: "DONE" } : { tool: tools.shell, args: { command: 'python3 -c "import time; time.sleep(25); print(1)"' } };
    if (prompt.includes("resumed-3")) {
      if (!calls.some((c) => c.arguments.includes("resumed-3"))) return { tool: tools.note, args: { text: "resumed-3" } };
      const first = messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function).find((c) => c.name === tools.note);
      return { text: first ? JSON.parse(first.arguments).text : "unknown" };
    }
    return { text: "ok" };
  };
}
