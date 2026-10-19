// Maps a tool call (name + input, and later its output) to the timeline's ToolCallDetail, for the
// tool names the five runtimes use. (Adapted from Apache-2.0 code; see NOTICE.)
import type { ToolCallDetail } from "./types.ts";
import { clip, isRecord, str } from "./util.ts";

const SHELL = new Set(["bash", "shell", "run_terminal_command", "execute", "exec_command", "local_shell", "powershell"]);
const READ = new Set(["read", "read_file", "view", "cat"]);
const EDIT = new Set(["edit", "multiedit", "str_replace", "apply_patch", "patch", "edit_file"]);
const WRITE = new Set(["write", "write_file", "create_file"]);
const GREP = new Set(["grep", "search", "rg", "ripgrep", "search_files"]);
const GLOB = new Set(["glob", "find", "list", "ls", "list_files", "find_files"]);
const FETCH = new Set(["webfetch", "web_fetch", "fetch", "fetch_url"]);
const WEB_SEARCH = new Set(["websearch", "web_search"]);
const SUB_AGENT = new Set(["task", "agent", "subagent", "spawn_agent"]);

function bare(name: string): string {
  return name.toLowerCase().replace(/^.*[.:/]/, "");
}

function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return undefined;
}

/** The detail for a call that has started; `output` fills in what the result adds. */
export function toolDetail(name: string, rawInput: unknown, output?: { text: string; exitCode?: number | null }): ToolCallDetail {
  const input = isRecord(rawInput) ? rawInput : {};
  const key = bare(name);
  const text = output ? clip(output.text) : undefined;
  if (SHELL.has(key)) {
    const command = pick(input, "command", "cmd", "script") ?? "";
    return { type: "shell", command, ...(str(input.cwd) ? { cwd: str(input.cwd)! } : {}), ...(text !== undefined ? { output: text } : {}), ...(output?.exitCode !== undefined ? { exitCode: output.exitCode } : {}) };
  }
  const filePath = pick(input, "file_path", "filePath", "path", "file");
  if (READ.has(key) && filePath) {
    return { type: "read", filePath, ...(text !== undefined ? { content: text } : {}), ...(typeof input.offset === "number" ? { offset: input.offset } : {}), ...(typeof input.limit === "number" ? { limit: input.limit } : {}) };
  }
  if (EDIT.has(key) && filePath) {
    const first = Array.isArray(input.edits) && isRecord(input.edits[0]) ? input.edits[0] : input;
    return {
      type: "edit",
      filePath,
      ...(str(first.old_string ?? first.oldString) ? { oldString: str(first.old_string ?? first.oldString)! } : {}),
      ...(str(first.new_string ?? first.newString) ? { newString: str(first.new_string ?? first.newString)! } : {}),
      ...(str(input.patch ?? input.diff) ? { unifiedDiff: str(input.patch ?? input.diff)! } : {}),
    };
  }
  if (WRITE.has(key) && filePath) return { type: "write", filePath, ...(str(input.content) ? { content: clip(str(input.content)!) } : {}) };
  if (GREP.has(key) || GLOB.has(key)) {
    const query = pick(input, "pattern", "query", "regex", "glob") ?? "";
    const toolName = GLOB.has(key) ? "glob" : "grep";
    const filePaths = toolName === "glob" && text ? text.split("\n").filter((line) => line && !line.startsWith("…")).slice(0, 200) : undefined;
    return { type: "search", query, toolName, ...(text !== undefined && toolName === "grep" ? { content: text } : {}), ...(filePaths ? { filePaths } : {}) };
  }
  if (FETCH.has(key)) return { type: "fetch", url: pick(input, "url") ?? "", ...(str(input.prompt) ? { prompt: str(input.prompt)! } : {}), ...(text !== undefined ? { result: text } : {}) };
  if (WEB_SEARCH.has(key)) return { type: "search", query: pick(input, "query", "q") ?? "", toolName: "web_search", ...(text !== undefined ? { content: text } : {}) };
  if (SUB_AGENT.has(key)) {
    return { type: "sub_agent", ...(str(input.subagent_type) ? { subAgentType: str(input.subagent_type)! } : {}), ...(str(input.description) ? { description: str(input.description)! } : {}), log: text ?? "" };
  }
  if (key === "exitplanmode" && str(input.plan)) return { type: "plan", text: str(input.plan)! };
  return { type: "unknown", input: rawInput ?? null, output: text ?? null };
}
