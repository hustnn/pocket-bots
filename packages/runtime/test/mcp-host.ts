// Test helper: a loopback MCP server (stateless JSON-RPC over HTTP) with one tool, `record_note`.
import { createServer } from "node:http";

export interface NoteHost {
  url: string;
  notes: string[];
  close(): Promise<void>;
}

export async function startNoteHost(): Promise<NoteHost> {
  const notes: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.id === undefined) return void res.writeHead(202).end();
    switch (message.method) {
      case "initialize":
        return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "0" } });
      case "tools/list":
        return reply({ tools: [{ name: "record_note", description: "Record a short note for the test harness.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
      case "tools/call": {
        const text = String(message.params?.arguments?.text ?? "");
        notes.push(text);
        return reply({ content: [{ type: "text", text: `noted: ${text}` }] });
      }
      default:
        return reply({});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, notes, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
