import { describe, expect, it } from "vitest";
import { runtimeErrorClass, runtimeErrorFingerprint, runtimeErrorPolicy } from "../src/server/runtime-errors";

describe("a runtime error, as its text is read", () => {
  it("classifies errors as runtimeErrorDiagnostics.ts does", () => {
    expect(runtimeErrorClass("429 Too Many Requests")).toBe("RateLimitError");
    expect(runtimeErrorClass("Selected model is at capacity. Please try a different model.")).toBe("RateLimitError");
    expect(runtimeErrorClass("API Error: 529 overloaded")).toBe("ProviderServerError");
    expect(runtimeErrorClass("API Error: Unable to connect to API (ECONNRESET)")).toBe("ProviderConnectionError");
    expect(runtimeErrorClass("stream closed before response.completed")).toBe("ProviderStreamError");
    expect(runtimeErrorClass("Request timed out")).toBe("TimeoutError");
    expect(runtimeErrorClass("Not logged in · Please run /login")).toBe("AuthError");
    expect(runtimeErrorClass("402 Payment Required")).toBe("BillingError");
    expect(runtimeErrorClass("Your current subscription plan does not yet include access to GLM-5")).toBe("ModelConfigError");
    // A rate limit is never a plan problem, even in plan words.
    expect(runtimeErrorClass("Your plan does not support more requests to this model right now")).toBe("RuntimeError");
    expect(runtimeErrorClass("The tool runner crashed.")).toBe("RuntimeError");
  });

  it("backs off the recoverable ones only (runtimeErrorDeliveryPolicy.ts)", () => {
    const backoff = (message: string, provider = "claude") => runtimeErrorPolicy(message, provider).backoff;
    expect(backoff("429 Too Many Requests: rate limit exceeded")).toBe("rate_limited");
    expect(backoff("API Error: 500 Internal Server Error")).toBe("provider_server_error");
    expect(backoff("connect ECONNREFUSED 127.0.0.1:443")).toBe("provider_connection_error");
    // Terminal failures that time can fix: a usage limit, a broken stream, a missing model.
    expect(backoff("You've hit your usage limit · resets 5pm")).toBe("recoverable_terminal_runtime_error");
    expect(backoff("stream closed before response.completed")).toBe("recoverable_terminal_runtime_error");
    expect(backoff("model not found: gpt-9")).toBe("recoverable_terminal_runtime_error");
    // Not backed off: a timeout, an unclassified error, and what needs the user.
    expect(backoff("Request timed out")).toBeNull();
    expect(backoff("The tool runner crashed.")).toBeNull();
    expect(backoff("Not logged in · Please run /login")).toBeNull();
    expect(backoff("402 Payment Required")).toBeNull();
    expect(backoff("model is not supported")).toBeNull();
    // Input too large is terminal except on Claude, which compacts on its own.
    expect(runtimeErrorPolicy("API Error: 400 maximum context length is 100 tokens; you requested 101 tokens", "codex").sticky).toBe(true);
    expect(runtimeErrorPolicy("API Error: 400 maximum context length is 100 tokens; you requested 101 tokens", "claude").sticky).toBe(false);
  });

  it("fingerprints the same failure alike, whatever its numbers, ids or secrets", () => {
    const one = runtimeErrorFingerprint("API Error: 500 request req_0a1b2c3d4e5f6a7b failed after 3 retries for /Users/ada/project");
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(runtimeErrorFingerprint("API Error: 500 request req_9f8e7d6c5b4a3f2e failed after 7 retries for /Users/rex/other")).toBe(one);
    expect(runtimeErrorFingerprint("Bearer abcdefgh12345678 rejected")).toBe(runtimeErrorFingerprint("Bearer zzzzzzzz99999999 rejected"));
    expect(runtimeErrorFingerprint("The tool runner crashed.")).not.toBe(one);
  });
});
