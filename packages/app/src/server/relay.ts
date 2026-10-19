import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkAppCall, type AppLimit } from "../shared/apps";
import type { Bot, McpServerConfig } from "../shared/bot";
import type { AskedAnswers } from "./answers";
import { accounts, appTools, connectedSlugs, deadline, readState, session, writeState } from "./composio";
import type { GroupChats } from "./groups";
import type { PocketHost } from "./host";
import { StartupError } from "./instance";
import { answerMcp, type BotTool } from "./tools/mcp";

// Bots reach pocket-bots through this loopback relay: http MCP servers on 127.0.0.1 with a bearer token each chat
// gets in its config. Tokens are signed with a secret only this process knows.
//
//   /mcp/<botId>              connected apps: forwards to Composio with the key
//                             added, after checking the bot may use the app
//   /bots/<botId>/<agentId>   pocket-bots' own tools for one chat
//   /bots/<botId>/<agentId>/<groupId>
//                             the same for a group chat's seat, which also gets the group's tools

/** The first start's port, next to the web UI's 6880 and outside the range the system hands out at random. */
const FIRST_PORT = 6881;
/** How long a start waits for the relay's port to come free (a restart's old process letting go). */
const PORT_WAIT_MS = 5_000;
const MAX_BODY = 5 * 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const ID = /^[a-z0-9-]+$/;

/** One listen attempt; a failed one leaves no listeners behind, so the server can try again. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const listening = () => {
      server.off("error", failed);
      resolve((server.address() as { port: number }).port);
    };
    const failed = (error: Error) => {
      server.off("listening", listening);
      reject(error);
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, "127.0.0.1");
  });
}

/** Listens on `port`, waiting up to `waitMs` while something else still holds it. */
async function listenWhenFree(server: Server, port: number, waitMs: number): Promise<number | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return await listen(server, port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (Date.now() >= until) return null;
      await new Promise((wait) => setTimeout(wait, 250));
    }
  }
}

function portTaken(port: number, configured: boolean): StartupError {
  const why = configured
    ? `The relay port ${port} (relay.port in config.json or POCKET_BOTS_RELAY_PORT) is in use by another program.`
    : `The relay port ${port} is in use by another program. Chats started earlier reach their bot tools on it, and webhook addresses include it, so pocket-bots won't move to another port.`;
  return new StartupError(
    `${why} See what holds it with: lsof -nP -iTCP:${port} -sTCP:LISTEN\nFree it and start again. To move on purpose, set relay.port in config.json (or POCKET_BOTS_RELAY_PORT); chats started before then lose their bot tools and webhook addresses change.`,
  );
}

function sign(secret: string, subject: string): string {
  return createHmac("sha256", secret).update(subject).digest("hex");
}

/** Connected-apps token; unchanged from the first release so running chats keep working. */
function botToken(secret: string, botId: string): string {
  return sign(secret, botId);
}

function toolsToken(secret: string, botId: string, agentId: string, groupId: string | null): string {
  return sign(secret, groupId ? `tools:${botId}:${agentId}:${groupId}` : `tools:${botId}:${agentId}`);
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Extra routes other features add (webhooks). Return true when handled. */
export type RelayRoute = (request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>;

/** A bot's limits on its apps, with the read-only tools and the pinned accounts' aliases looked up. */
async function appLimits(bot: Bot): Promise<Map<string, AppLimit>> {
  const limits = new Map<string, AppLimit>();
  for (const slug of bot.apps) {
    const rule = bot.appRules[slug];
    if (!rule || (rule.tools === "all" && !rule.account)) continue;
    const tools = rule.tools === "all" ? null : rule.tools === "read" ? (await appTools({ slug })).tools.filter((tool) => tool.readOnly).map((tool) => tool.slug) : rule.tools;
    const alias = rule.account ? ((await accounts()).accounts.find((account) => account.id === rule.account)?.alias ?? null) : null;
    limits.set(slug, { tools: tools && new Set(tools.map((tool) => tool.toUpperCase())), account: rule.account ? { id: rule.account, alias } : null });
  }
  return limits;
}

export class Relay {
  /** Group chats, set once they exist (they start seats through this relay). */
  groups: GroupChats | null = null;
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private readonly routes: RelayRoute[] = [];

  constructor(
    private readonly host: PocketHost,
    private readonly tools: readonly BotTool[],
    /** A port from the config; otherwise the last one used, or any free one. */
    private readonly options: {
      /** A port from the config; otherwise the saved one, or a new one on the first start. */
      port?: number | null;
      /** Sends asked bots' slower answers to the chat that asked. */
      answers?: AskedAnswers | null;
      portWaitMs?: number;
    } = {},
  ) {}

  addRoute(route: RelayRoute): void {
    this.routes.push(route);
  }

  /**
   * Starts listening. Chats keep the relay's address in their config, so the port never
   * moves on its own: the configured or saved one is waited for briefly and otherwise
   * refused, and only the first start picks one.
   */
  start(): Promise<number> {
    this.listening ??= (async () => {
      const state = await readState();
      const server = createServer((request, response) => void this.handle(request, response));
      // Port 0 asked for explicitly is any free port, not saved (tests run relays side by side).
      if (this.options.port === 0) {
        const port = await listen(server, 0);
        this.server = server;
        return port;
      }
      const wanted = this.options.port ?? state.port;
      let port: number;
      if (wanted) {
        const got = await listenWhenFree(server, wanted, this.options.portWaitMs ?? PORT_WAIT_MS);
        if (got === null) throw portTaken(wanted, !!this.options.port);
        port = got;
      } else port = (await listenWhenFree(server, FIRST_PORT, 0)) ?? (await listen(server, 0));
      this.server = server;
      if (port !== state.port) await writeState({ port });
      return port;
    })().catch((error: unknown) => {
      this.listening = null;
      throw error;
    });
    return this.listening;
  }

  stop() {
    this.server?.close();
    this.server = null;
    this.listening = null;
  }

  /** The connected-apps server for a bot's chats, or null when connected apps aren't set up. */
  async mountApps(botId: string): Promise<McpServerConfig | null> {
    const state = await readState();
    if (!state.apiKey) return null;
    const port = await this.start();
    return { type: "http", url: `http://127.0.0.1:${port}/mcp/${botId}`, headers: { Authorization: `Bearer ${botToken(state.secret, botId)}` } };
  }

  /**
   * pocket-bots' tools for one chat. A group chat's seat names its group here, so its group
   * tools are listed from the first tools/list, before the chat's runtime has even started.
   */
  async mountTools(botId: string, agentId: string, groupId: string | null = null): Promise<McpServerConfig> {
    const state = await readState();
    const port = await this.start();
    return {
      type: "http",
      url: `http://127.0.0.1:${port}/bots/${botId}/${agentId}${groupId ? `/${groupId}` : ""}`,
      headers: { Authorization: `Bearer ${toolsToken(state.secret, botId, agentId, groupId)}` },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const apps = /^\/mcp\/([^/]+)$/.exec(path);
      if (apps) return await this.handleApps(request, response, apps[1]!);
      const tools = /^\/bots\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (tools) return await this.handleTools(request, response, tools[1]!, tools[2]!, tools[3] ?? null);
      for (const route of this.routes) if (await route(request, response, path)) return;
      json(response, 404, { error: "not found" });
    } catch (error) {
      if (!response.headersSent) json(response, 502, { jsonrpc: "2.0", id: null, error: { code: -32002, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  /** Streamable HTTP lets a server decline the optional GET stream; sessions end on their own. */
  private refuseNonPost(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method === "POST") return false;
    if (request.method === "DELETE") response.writeHead(204).end();
    else response.writeHead(405, { allow: "POST" }).end();
    return true;
  }

  private async parse(request: IncomingMessage, response: ServerResponse): Promise<{ body: string; message: Record<string, unknown> } | null> {
    const body = await readBody(request);
    try {
      return { body, message: JSON.parse(body) as Record<string, unknown> };
    } catch {
      json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return null;
    }
  }

  private async handleTools(request: IncomingMessage, response: ServerResponse, botId: string, agentId: string, groupId: string | null) {
    const state = await readState();
    if (!ID.test(botId) || !ID.test(agentId) || (groupId !== null && !ID.test(groupId)) || !tokenMatches(toolsToken(state.secret, botId, agentId, groupId), request.headers.authorization)) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (this.refuseNonPost(request, response)) return;
    const parsed = await this.parse(request, response);
    if (!parsed) return;
    const bot = await this.host.bot(botId);
    const id = (parsed.message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived) return json(response, 403, { jsonrpc: "2.0", id, error: { code: -32001, message: "This bot no longer exists." } });
    const answer = await answerMcp(parsed.message, this.tools, {
      bot,
      agentId,
      host: this.host,
      relay: this,
      ...(this.options.answers ? { answers: this.options.answers } : {}),
      ...(this.groups ? { groups: this.groups } : {}),
      ...(groupId ? { groupId } : {}),
    });
    if (!answer) return response.writeHead(202).end();
    json(response, 200, answer);
  }

  private async handleApps(request: IncomingMessage, response: ServerResponse, botId: string) {
    const state = await readState();
    if (!ID.test(botId) || !tokenMatches(botToken(state.secret, botId), request.headers.authorization)) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (this.refuseNonPost(request, response)) return;
    const parsed = await this.parse(request, response);
    if (!parsed) return;
    const bot = await this.host.bot(botId);
    const id = (parsed.message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived || bot.hostId || bot.apps.length === 0) {
      return json(response, 403, { jsonrpc: "2.0", id, error: { code: -32001, message: "Connected apps are off for this bot. Turn them on under its Access settings in pocket-bots." } });
    }
    // Limits need Composio's tool lists, so they're looked up for tool calls only.
    const limits = parsed.message.method === "tools/call" ? await appLimits(bot) : new Map<string, AppLimit>();
    const verdict = checkAppCall(parsed.message, { allowed: bot.apps, connected: await connectedSlugs(), limits });
    if ("refusal" in verdict) return json(response, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: verdict.refusal }], isError: true } });
    await this.forward(request, response, verdict.message === parsed.message ? parsed.body : JSON.stringify(verdict.message));
  }

  private async forward(request: IncomingMessage, response: ServerResponse, body: string) {
    const transport = request.headers["mcp-session-id"];
    const send = async (recreate: boolean) => {
      const upstream = await session({ recreate });
      return fetch(upstream.mcpUrl, {
        method: "POST",
        headers: {
          "x-api-key": upstream.apiKey,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(typeof transport === "string" ? { "mcp-session-id": transport } : {}),
          ...(typeof request.headers["mcp-protocol-version"] === "string" ? { "mcp-protocol-version": request.headers["mcp-protocol-version"] } : {}),
        },
        body,
        signal: deadline(10 * 60_000),
      });
    };
    let upstream = await send(false);
    // A Tool Router session Composio no longer knows: open a new one and let the client start over.
    if (upstream.status === 404 && !transport) upstream = await send(true);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_RESPONSE) throw new Error("The connected app's answer is over 20 MB.");
    const next = upstream.headers.get("mcp-session-id");
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(next ? { "mcp-session-id": next } : {}),
    });
    response.end(bytes);
  }
}
