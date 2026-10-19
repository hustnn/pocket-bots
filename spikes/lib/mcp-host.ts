// Phase-0 helper: a loopback Streamable-HTTP MCP server with one tool,
// `record_note`. Each session gets its own token in the URL, so a call tells
// us which session made it.
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface NoteCall {
  token: string;
  text: string;
  at: number;
}

export interface McpHost {
  url(token: string): string;
  newToken(): string;
  calls: NoteCall[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export async function startMcpHost(log: (line: string) => void): Promise<McpHost> {
  const calls: NoteCall[] = [];
  const tokens = new Set<string>();

  function buildServer(token: string): McpServer {
    const server = new McpServer({ name: "bots", version: "0.0.1" });
    server.registerTool(
      "record_note",
      { description: "Record a short note for the test harness.", inputSchema: { text: z.string() } },
      async ({ text }) => {
        calls.push({ token, text, at: Date.now() });
        log(`[mcp] record_note token=${token.slice(0, 6)} text=${JSON.stringify(text)}`);
        return { content: [{ type: "text", text: `noted: ${text}` }] };
      },
    );
    return server;
  }

  const http = createServer(async (req, res) => {
    const match = /^\/mcp\/([a-f0-9]+)$/.exec(req.url ?? "");
    if (!match || !tokens.has(match[1])) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const server = buildServer(match[1]);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log(`[mcp] error ${String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;

  return {
    url: (token) => `http://127.0.0.1:${port}/mcp/${token}`,
    newToken() {
      const token = randomBytes(12).toString("hex");
      tokens.add(token);
      return token;
    },
    calls,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
