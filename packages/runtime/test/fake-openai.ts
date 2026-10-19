// A scripted OpenAI chat-completions server (streaming), so a runtime's protocol can be checked
// without a real model login. `decide` sees the request's messages and returns the next step.
import { createServer } from "node:http";

export type FakeStep = { text: string } | { tool: string; args: Record<string, unknown> };
export type ChatMessage = { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[]; tool_call_id?: string };

export function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part: any) => part?.text ?? "").join("");
  return "";
}

export async function startFakeOpenAI(decide: (messages: ChatMessage[]) => FakeStep, log: (line: string) => void = () => {}) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake-1" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const step = decide(body.messages as ChatMessage[]);
    calls++;
    log(`[fake-model] call ${calls} -> ${JSON.stringify(step).slice(0, 120)}`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `chatcmpl-${calls}`;
    const send = (delta: unknown, finish: string | null) =>
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if ("text" in step) {
      send({ role: "assistant", content: step.text }, null);
      send({}, "stop");
    } else {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null);
      send({}, "tool_calls");
    }
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
