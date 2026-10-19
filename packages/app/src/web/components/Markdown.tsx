import { memo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "../lib/clipboard";
import { isWebLink, linkPath, remarkSoftBreaks } from "../lib/markdown";
import { Icon } from "./icons";
import { useFeedback } from "./ui";

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

/** The text inside a rendered node (a code block's source). */
function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** Web links open in a new tab; a workspace file or anchor can't be opened here, so it's copied. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const feedback = useFeedback();
  if (isWebLink(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  const path = href ? linkPath(href) : "";
  return (
    <a
      href={href}
      title={path ? `Copy ${path}` : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (!path) return;
        void copyText(path).then(
          () => feedback.toast("Path copied"),
          () => feedback.error("Couldn't copy the path."),
        );
      }}
    >
      {children}
    </a>
  );
}

/** A code block with a copy button on hover (always shown on touch screens). */
function CodeBlock({ node, children, ...props }: ComponentProps<"pre"> & { node?: HastNode }) {
  const [copied, setCopied] = useState(false);
  const text = textOf(node).replace(/\n+$/, "");
  return (
    <div className="code-block">
      <pre {...props}>{children}</pre>
      {text ? (
        <button
          type="button"
          className="code-copy"
          title={copied ? "Copied" : "Copy code"}
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() =>
            void copyText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
        </button>
      ) : null}
    </div>
  );
}

/** Bot replies as GitHub-flavoured Markdown, a single newline a line break. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        components={{
          a: ({ node: _node, href, children }) => <Link href={href}>{children}</Link>,
          pre: ({ node, ...props }) => <CodeBlock node={node as HastNode | undefined} {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
