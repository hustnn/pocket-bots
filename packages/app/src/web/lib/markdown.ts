// How reply Markdown renders: a single newline is a line break (soft breaks
// are kept), web links open, and anything else
// a link points at (a workspace file, an anchor) is a path to copy.

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** A remark plugin that turns every newline inside text into a line break. Code keeps its newlines. */
export function remarkSoftBreaks() {
  return (tree: MdNode) => splitBreaks(tree);
}

function splitBreaks(node: MdNode): void {
  if (!node.children) return;
  const children: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("\n")) {
      child.value.split(/\r?\n/).forEach((part, index) => {
        if (index > 0) children.push({ type: "break" });
        if (part) children.push({ type: "text", value: part });
      });
    } else {
      splitBreaks(child);
      children.push(child);
    }
  }
  node.children = children;
}

/** Links a browser can open; everything else is treated as a path. */
export function isWebLink(url: string | null | undefined): url is string {
  return !!url && /^(https?:|mailto:|tel:)/i.test(url.trim());
}

/** The path a non-web link names, without file:// and with %-escapes decoded where they're valid. */
export function linkPath(url: string): string {
  const path = url.trim().replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
