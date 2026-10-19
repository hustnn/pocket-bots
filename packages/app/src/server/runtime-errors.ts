import { createHash } from "node:crypto";

// What a seat's failed turn says about its runtime: the error's class, its fingerprint, whether
// it's terminal (and whether only the user can fix it), and whether delivery should back off
// after it. Only the error's text is read.

const AUTH_ACTION_REQUIRED: RegExp[] = [
  /access token could not be refreshed/i,
  /\btoken_(?:revoked|invalidated)\b/i,
  /refresh token was already used/i,
  /access token.*invalidated/i,
  /authentication token has been invalidated/i,
  /logged out or signed in to another account/i,
  /not logged in/i,
  /not signed in/i,
  /login required/i,
  /log in first/i,
  /please log in/i,
  /authentication failed/i,
  /auth(?:entication)? failed/i,
  /authentication timed out/i,
  /missing (?:api )?token/i,
  /no (?:api )?token/i,
  /missing credentials/i,
  /credentials? not found/i,
  /invalid api key/i,
  /api key (?:is )?not set/i,
];
const BILLING_EXHAUSTED: RegExp[] = [
  /\bpayment required\b/i,
  /\b(?:usage|credit|account)\s+balance\b[^.]*\b(?:exhausted|depleted|insufficient|too low)\b/i,
  /\binsufficient\s+(?:balance|credits?|funds)\b/i,
  /\b(?:out of|run out of|no remaining)\s+credits?\b/i,
];
const PLAN_ACCESS: RegExp[] = [
  /\b(?:subscription|plan|tier)\b[^.\n]{0,80}\b(?:does not|doesn't|do not|don't|not)\b[^.\n]{0,40}\b(?:include|allow|support|grant)\b[^.\n]{0,40}\b(?:access|model)\b/i,
  /\b(?:model|access)\b[^.\n]{0,80}\b(?:not|isn't|is not)\b[^.\n]{0,20}\b(?:included|available|enabled|allowed)\b[^.\n]{0,40}\b(?:subscription|plan|tier)\b/i,
];
/** Wording of a temporary limit, which vetoes plan access (a rate limit is never a plan problem). */
const TRANSIENT_LIMIT: RegExp[] = [
  /\brate.?limit/i,
  /\btoo many requests\b/i,
  /\bconcurrenc(?:y|ies)\b/i,
  /\bretry(?:ing)?\b/i,
  /\btry again\b/i,
  /\blater\b/i,
  /\bresets?\b/i,
  /\bper (?:second|minute|hour|day)\b/i,
  /\b[RT]PM\b/,
  /\bat the moment\b/i,
  /\bright now\b/i,
  /\bat capacity\b/i,
];
const LAUNCHER_FAILURE: RegExp[] = [/\bunknown command\b[\s\S]*\b(?:codex|gemini|opencode)\.(?:js|mjs|cjs)\b/i];

const planAccess = (text: string) => !TRANSIENT_LIMIT.some((pattern) => pattern.test(text)) && PLAN_ACCESS.some((pattern) => pattern.test(text));
const authActionRequired = (text: string) => AUTH_ACTION_REQUIRED.some((pattern) => pattern.test(text));

function httpStatus(message: string): number | null {
  const match =
    /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/i.exec(message) ??
    /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/i.exec(message) ??
    /\b([45]\d{2})\s*:/i.exec(message);
  return match ? Number(match[1]) : null;
}

/** The runtime error class for an error's text (RateLimitError, ProviderServerError, AuthError, …). */
export function runtimeErrorClass(message: string): string {
  if (LAUNCHER_FAILURE.some((pattern) => pattern.test(message))) return "LauncherError";
  const explicit = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/.exec(message);
  if (explicit && /InputTooLargeError/i.test(explicit[1]!)) return "InputTooLargeError";
  if ((explicit && /^(?:AbortError|OperationAbortedError)$/i.test(explicit[1]!)) || /^\s*(?:this\s+)?operation was aborted\.?\s*$/i.test(message)) return "OperationAbortedError";
  if (/\bINPUT_TOO_LARGE\b/i.test(message) || /\binput too large\b/i.test(message) || /\bexceeds the maximum allowed\b/i.test(message) || (/\bmaximum context length is [\d,]+ tokens?\b/i.test(message) && /\byou requested [\d,]+ tokens?\b/i.test(message))) {
    return "InputTooLargeError";
  }
  const status = httpStatus(message);
  if (status === 402 || BILLING_EXHAUSTED.some((pattern) => pattern.test(message))) return "BillingError";
  if (planAccess(message)) return "ModelConfigError";
  if (explicit) return explicit[1]!;
  if (status !== null) {
    if (status === 429) return "RateLimitError";
    if (status === 401) return "AuthError";
    if (status === 403) return authActionRequired(message) ? "AuthError" : "ProviderApiError";
    if (status === 404) return "NotFoundError";
    if (status >= 500) return "ProviderServerError";
    return "ProviderApiError";
  }
  if (authActionRequired(message)) return "AuthError";
  if (/\bmodel\b.*\bnot supported\b/i.test(message) || /\bunsupported\b.*\bmodel\b/i.test(message) || /\bmodel\b.*\bnot available\b/i.test(message)) return "ModelConfigError";
  if (/\b(?:ETIMEDOUT|timeout|timed out)\b/i.test(message)) return "TimeoutError";
  if (/\b(?:ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i.test(message) || /\bUnable to connect to API\b/i.test(message)) return "ProviderConnectionError";
  if (/stream closed before response\.completed|error decoding response body/i.test(message)) return "ProviderStreamError";
  if (/\b(?:selected\s+)?model\s+is\s+at\s+capacity\b/i.test(message)) return "RateLimitError";
  if (/\brate.?limit|too many requests\b/i.test(message)) return "RateLimitError";
  if (/\bnot found\b/i.test(message)) return "NotFoundError";
  return "RuntimeError";
}

/** The user has to act (sign in again, or change the model or plan). */
function actionRequired(message: string, errorClass: string): boolean {
  return errorClass === "AuthError" || (errorClass === "ModelConfigError" && planAccess(message));
}

/** The scrub before fingerprinting: secrets, addresses and home paths out. */
function scrubbed(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, "$1?[REDACTED_QUERY]")
    .replace(/\/(?:Users|home)\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g, "[REDACTED_TOKEN]");
}

/**
 * A runtime error's fingerprint: the scrubbed text lower-cased, long hex runs and numbers
 * replaced, spaces collapsed, hashed (16 hex characters). The same failure gives the same one
 * even when its request id, token count or time differs.
 */
export function runtimeErrorFingerprint(message: string): string {
  const normalized = scrubbed(message)
    .toLowerCase()
    .replace(/[0-9a-f]{12,}/g, "<hex>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export interface RuntimeErrorPolicy {
  errorClass: string;
  fingerprint: string;
  /** Terminal failures: a usage or quota limit, a model that's gone, a broken stream, a sign-in or plan problem. */
  terminal: boolean;
  /**
   * Terminal and needing the user (sign in, billing, the model or plan, input too large): never
   * backed off or counted, and the bot isn't woken again until the user acts (a sticky
   * terminal failure).
   */
  sticky: boolean;
  /**
   * Sticky because of a sign-in or the plan: the user's next message may try again. The other sticky
   * ones (billing, a model that isn't supported, input too large) wait for a restart.
   */
  actionRequired: boolean;
  /**
   * Why delivery waits before telling this seat again, or null to tell it at once. An
   * unclassified error doesn't back off: a seat's failure is its turn's end, and a backoff for
   * it would end there too.
   */
  backoff: "rate_limited" | "provider_server_error" | "provider_connection_error" | "provider_stream_error" | "recoverable_terminal_runtime_error" | null;
}

/** How a runtime error is treated (`provider` for the one per-runtime rule: input too large is terminal except on Claude). */
export function runtimeErrorPolicy(message: string, provider: string): RuntimeErrorPolicy {
  const errorClass = runtimeErrorClass(message);
  const fingerprint = runtimeErrorFingerprint(message);
  const lower = message.toLowerCase();
  const needsUser = actionRequired(message, errorClass);
  const inputTooLarge = errorClass === "InputTooLargeError" && provider !== "claude";
  const terminal =
    errorClass === "BillingError" ||
    ["usage limit", "quota exceeded", "quota limit", "budget limit exceeded", "usage not included in your plan", "modelnotfounderror", "requested entity was not found", "model deprecated", "model not found", "model is not supported", "unsupported model", "codex_zero_evidence_turn_completed"].some((phrase) => lower.includes(phrase)) ||
    /\bmodel\b.*\bnot supported\b/i.test(message) ||
    needsUser ||
    inputTooLarge ||
    /stream closed before response\.completed|error decoding response body/i.test(message) ||
    /did not finish starting on this machine/i.test(message);
  const sticky =
    terminal &&
    (needsUser || inputTooLarge || errorClass === "BillingError" || /\bcodex_zero_evidence_turn_completed\b/i.test(message) || /\b(?:model\b.*\bnot supported|unsupported\b.*\bmodel)\b/i.test(message));
  let backoff: RuntimeErrorPolicy["backoff"] = null;
  if (!sticky) {
    if (terminal) backoff = "recoverable_terminal_runtime_error";
    else if (errorClass === "RateLimitError") backoff = "rate_limited";
    else if (errorClass === "ProviderServerError") backoff = "provider_server_error";
    else if (errorClass === "ProviderConnectionError") backoff = "provider_connection_error";
    else if (errorClass === "ProviderStreamError") backoff = "provider_stream_error";
  }
  return { errorClass, fingerprint, terminal, sticky, actionRequired: needsUser, backoff };
}
