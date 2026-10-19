import { useMemo } from "react";
import { buildLineDiff, parseUnifiedDiff, type DiffLine, type ToolCallDetail } from "../../../shared/tools";

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div style={{ padding: "6px 0" }}>
      {lines.map((line, index) => (
        <div key={index} className={`diff-line${line.type === "add" ? " add" : line.type === "remove" ? " remove" : ""}`}>
          {line.type === "add" ? "+ " : line.type === "remove" ? "- " : line.type === "header" ? "" : "  "}
          {line.content}
        </div>
      ))}
    </div>
  );
}

/** What a tool call did: the command and its output, the edit as a diff, the file read. */
export function ToolDetails({ detail, errorText }: { detail: ToolCallDetail; errorText?: string | null }) {
  const body = useMemo(() => {
    switch (detail.type) {
      case "shell":
        return <pre>{`$ ${detail.command}${detail.output ? `\n\n${detail.output}` : ""}${typeof detail.exitCode === "number" && detail.exitCode !== 0 ? `\n\n(exit ${detail.exitCode})` : ""}`}</pre>;
      case "edit": {
        const lines = detail.unifiedDiff ? parseUnifiedDiff(detail.unifiedDiff) : buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
        return (
          <>
            <pre style={{ paddingBottom: 0 }}>{detail.filePath}</pre>
            <Diff lines={lines} />
          </>
        );
      }
      case "write":
        return <pre>{`${detail.filePath}\n\n${detail.content ?? ""}`}</pre>;
      case "read":
        return <pre>{`${detail.filePath}${detail.content ? `\n\n${detail.content}` : ""}`}</pre>;
      case "search":
        return (
          <pre>
            {[detail.query, detail.content, detail.filePaths?.join("\n"), detail.webResults?.map((result) => `${result.title}\n  ${result.url}`).join("\n")].filter(Boolean).join("\n\n")}
          </pre>
        );
      case "fetch":
        return <pre>{[detail.url, detail.prompt, detail.result].filter(Boolean).join("\n\n")}</pre>;
      case "sub_agent":
        return <pre>{[detail.description, detail.log].filter(Boolean).join("\n\n")}</pre>;
      case "plain_text":
        return <pre>{[detail.label, detail.text].filter(Boolean).join("\n\n")}</pre>;
      case "plan":
        return <pre>{detail.text}</pre>;
      case "worktree_setup":
        return <pre>{`${detail.branchName} → ${detail.worktreePath}\n\n${detail.log}`}</pre>;
      case "unknown": {
        const input = stringify(detail.input);
        const output = stringify(detail.output);
        return <pre>{[input && `Input\n${input}`, output && `Output\n${output}`].filter(Boolean).join("\n\n") || "No details."}</pre>;
      }
    }
  }, [detail]);
  return (
    <div className="tool-detail">
      {body}
      {errorText ? <pre style={{ color: "var(--danger)" }}>{errorText}</pre> : null}
    </div>
  );
}
