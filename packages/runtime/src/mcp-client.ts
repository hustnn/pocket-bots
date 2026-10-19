// A minimal client for our own HTTP MCP servers (stateless JSON-RPC), so adapters can offer their
// tools natively (Codex dynamic tools, an OpenCode plugin, a Pi extension) and call them.
import type { McpServerConfig } from "./types.ts";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function rpc(config: Extract<McpServerConfig, { type: "http" | "sse" }>, method: string, params: unknown): Promise<any> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(config.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`MCP server answered HTTP ${response.status}`);
  const text = await response.text();
  // Streamable HTTP may answer as an event stream with one message.
  const json = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}");
  const body = JSON.parse(json);
  if (body.error) throw new Error(body.error.message ?? "MCP error");
  return body.result;
}

export async function listMcpTools(config: McpServerConfig): Promise<McpTool[]> {
  if (config.type === "stdio") return [];
  const result = await rpc(config, "tools/list", {});
  return (result?.tools ?? []).map((tool: any) => ({ name: String(tool.name), description: String(tool.description ?? ""), inputSchema: tool.inputSchema ?? { type: "object" } }));
}

/** Calls a tool; the text of its result, and whether it was an error. */
export async function callMcpTool(config: McpServerConfig, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  if (config.type === "stdio") throw new Error("stdio servers can't be called directly");
  const result = await rpc(config, "tools/call", { name, arguments: args ?? {} });
  const text = (result?.content ?? []).map((part: any) => (typeof part?.text === "string" ? part.text : part?.type === "image" ? "[image]" : "")).join("\n");
  return { text, isError: result?.isError === true };
}

/** Whether `server/tool` (or the whole server) is in the trusted list. */
export function isTrusted(trusted: readonly string[], server: string, tool: string): boolean {
  return trusted.includes(server) || trusted.includes(`${server}/${tool}`);
}
