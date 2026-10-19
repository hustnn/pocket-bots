import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/http";
import { hostnameOf, isAllowedHost } from "../src/server/hosts";

describe("host names", () => {
  it("reads the hostname out of a Host header", () => {
    expect(hostnameOf("127.0.0.1:6780")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:6780")).toBe("::1");
    expect(hostnameOf("::1")).toBe("::1");
    expect(hostnameOf("Pocket.Example.com.")).toBe("pocket.example.com");
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });

  it("allows localhost and IP addresses, and configured names", () => {
    for (const host of ["localhost:6780", "app.localhost", "127.0.0.1:6780", "[::1]:6780", "100.101.102.103:6780", "192.168.1.20"]) {
      expect(isAllowedHost(host, [])).toBe(true);
    }
    expect(isAllowedHost("evil.example:6780", [])).toBe(false);
    expect(isAllowedHost(undefined, [])).toBe(false);
    expect(isAllowedHost("box.tail1234.ts.net", ["box.tail1234.ts.net"])).toBe(true);
    expect(isAllowedHost("other.tail1234.ts.net", ["box.tail1234.ts.net"])).toBe(false);
    expect(isAllowedHost("box.tail1234.ts.net", [".ts.net"])).toBe(true);
    expect(isAllowedHost("ts.net", [".ts.net"])).toBe(true);
    expect(isAllowedHost("evilts.net", [".ts.net"])).toBe(false);
    expect(isAllowedHost("anything.example", true)).toBe(true);
  });

  it("refuses requests for an unknown host before they reach an RPC", async () => {
    const app = createApp({ registry: new Map(), hub: {} as never, host: {} as never, webRoot: null });
    const evil = await app.request("/api/rpc/pocket.status", { method: "POST", headers: { host: "rebound.example:6780" } });
    expect(evil.status).toBe(403);
    const local = await app.request("/api/rpc/pocket.status", { method: "POST", headers: { host: "127.0.0.1:6780" } });
    // Allowed through to routing; the empty registry doesn't know the RPC.
    expect(local.status).toBe(404);
  });
});
