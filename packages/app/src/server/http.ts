import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { PocketEvent } from "../shared/rpc";
import { RequestError } from "./errors";
import type { EventHub } from "./events";
import { groupFilePath } from "./groups";
import type { PocketHost } from "./host";
import { isAllowedHost, type AllowedHostnames } from "./hosts";
import type { RpcRegistration } from "./rpc-handlers";

const KEEPALIVE_MS = 15_000;
/** Live timeline events arrive per streamed chunk; the UI refetches, so they're coalesced. */
const TIMELINE_PING_MS = 120;
/** The attached pictures a group chat shows, by extension; other files aren't served. */
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function createApp(input: { registry: Map<string, RpcRegistration>; hub: EventHub; host: PocketHost; webRoot: string | null; hostnames?: AllowedHostnames }): Hono {
  const { registry, hub, host, webRoot, hostnames = [] } = input;
  const app = new Hono();

  // Refuses pages that reach this server under a domain of their own (DNS rebinding).
  app.use("*", async (c, next) => {
    if (!isAllowedHost(c.req.header("host"), hostnames)) {
      return c.text(`pocket-bots doesn't answer to this host name. Add it to web.hostnames in config.json to use it.`, 403);
    }
    await next();
  });

  app.post("/api/rpc/:name", async (c) => {
    const registration = registry.get(c.req.param("name"));
    if (!registration) return c.json({ error: "Unknown RPC." }, 404);
    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = registration.contract.input.safeParse(body);
    if (!parsed.success) return c.json({ error: `Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}` }, 400);
    try {
      const output = await registration.handler(parsed.data);
      return c.json({ data: registration.contract.output.parse(output) });
    } catch (error) {
      // The caller's mistake is a 400 and not logged; anything else is a real failure.
      if (error instanceof RequestError) return c.json({ error: errorText(error) }, 400);
      console.error(`pocket-bots: ${registration.contract.name} failed`, error);
      return c.json({ error: errorText(error) }, 500);
    }
  });

  /** Store, connection and bot-chat changes for every open UI. */
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: PocketEvent) => void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      const unsubscribe = hub.subscribe(send);
      const keepalive = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), KEEPALIVE_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepalive);
      unsubscribe();
    }),
  );

  /** One open chat's live timeline: a "timeline" ping whenever it changes. */
  app.get("/api/chats/:id/events", (c) =>
    streamSSE(c, async (stream) => {
      const agentId = c.req.param("id");
      let timer: ReturnType<typeof setTimeout> | null = null;
      const ping = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          void stream.writeSSE({ data: JSON.stringify({ type: "timeline", agentId } satisfies PocketEvent) }).catch(() => {});
        }, TIMELINE_PING_MS);
      };
      const off = host.chats.on("timeline", ({ chatId }) => {
        if (chatId === agentId) ping();
      });
      ping();
      const keepalive = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), KEEPALIVE_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepalive);
      if (timer) clearTimeout(timer);
      off();
    }),
  );

  /** A picture the user attached in a group chat, for its preview. */
  app.get("/api/groups/:id/files/:name", async (c) => {
    const path = groupFilePath(c.req.param("id"), c.req.param("name"));
    const type = IMAGE_TYPES[(/\.([a-z0-9]+)$/i.exec(c.req.param("name"))?.[1] ?? "").toLowerCase()];
    if (!path || !type) return c.text("Not found.", 404);
    try {
      return c.body(new Uint8Array(await readFile(path)), 200, { "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
    } catch {
      return c.text("Not found.", 404);
    }
  });

  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.use("/*", serveStatic({ root: webRoot }));
    // Client-side routes all load the app.
    app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
  } else {
    app.get("/", (c) => c.text("pocket-bots's API is running. Build the web UI with `npm run build`, or open the Vite dev server."));
  }

  return app;
}

export function startHttp(app: Hono, host: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(server));
    server.once("error", reject);
  });
}
