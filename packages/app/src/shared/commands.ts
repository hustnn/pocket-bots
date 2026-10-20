// What a bot may do without asking, saved from an approval card: an exact command in an exact
// folder (an allowlist, not patterns), or anything it does inside a folder the user trusts it with.

/** The shell command a permission request is about and the folder it runs in, if it's one. */
export function shellCommand(request: { detail?: unknown }, fallbackCwd: string): { command: string; cwd: string } | null {
  const detail = request.detail as { type?: unknown; command?: unknown; cwd?: unknown } | undefined;
  if (detail?.type !== "shell" || typeof detail.command !== "string") return null;
  return { command: detail.command, cwd: typeof detail.cwd === "string" && detail.cwd ? detail.cwd : fallbackCwd };
}

/** Folders above this many levels (/Users/ann/project) can be trusted; the ones above are too broad. */
const MIN_FOLDER_DEPTH = 3;

const depth = (folder: string) => folder.split("/").filter(Boolean).length;
const parentOf = (path: string) => path.slice(0, Math.max(1, path.replace(/\/+$/, "").lastIndexOf("/")));
const within = (folder: string, path: string) => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/**
 * The folders the user can trust a bot with from a request's approval card, likeliest first: the
 * chat's folder when the request works inside it, then the folder the request works in (a
 * command's folder, a file's folder) and the folders above it. Only absolute paths, and none
 * as broad as the home folder; empty when the request isn't about a command or a file. When the
 * request works inside one of the chat's extra folders, that folder comes next after the chat's own.
 */
export function folderChoices(request: { kind?: string; detail?: unknown; input?: unknown }, cwd: string, extraFolders: readonly string[] = []): string[] {
  if (request.kind !== undefined && request.kind !== "tool") return [];
  const detail = request.detail as { type?: unknown; cwd?: unknown; filePath?: unknown; toolName?: unknown } | undefined;
  const input = (request.input ?? {}) as { path?: unknown; paths?: unknown };
  const absolute = (path: string) => (path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`);
  let folder: string | null = null;
  if (detail?.type === "shell") folder = absolute(typeof detail.cwd === "string" && detail.cwd ? detail.cwd : cwd);
  else if ((detail?.type === "read" || detail?.type === "edit" || detail?.type === "write") && typeof detail.filePath === "string") folder = parentOf(absolute(detail.filePath));
  else if (detail?.type === "search" && (detail.toolName === "grep" || detail.toolName === "glob")) folder = absolute(typeof input.path === "string" && input.path ? input.path : cwd);
  else if (Array.isArray(input.paths) && typeof input.paths[0] === "string") folder = parentOf(absolute(input.paths[0]));
  if (!folder || folder.startsWith("~")) return [];
  const choices: string[] = [];
  if (within(cwd, folder)) choices.push(cwd);
  // The innermost extra folder that holds the request, when there are nested ones.
  const extra = extraFolders.filter((candidate) => within(candidate, folder)).sort((a, b) => b.length - a.length)[0];
  if (extra && !choices.includes(extra)) choices.push(extra);
  for (let at = folder; depth(at) >= MIN_FOLDER_DEPTH; at = parentOf(at)) if (!choices.includes(at)) choices.push(at);
  return choices.filter((choice) => depth(choice) >= MIN_FOLDER_DEPTH).slice(0, 5);
}
