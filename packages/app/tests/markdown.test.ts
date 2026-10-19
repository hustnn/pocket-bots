import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { isWebLink, linkPath, remarkSoftBreaks } from "../src/web/lib/markdown";

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkSoftBreaks] }, text));

describe("reply markdown", () => {
  it("keeps a single newline as a line break", () => {
    expect(render("first line\nsecond line")).toBe("<p>first line<br/>\nsecond line</p>");
    expect(render("para one\n\npara two")).toBe("<p>para one</p>\n<p>para two</p>");
    expect(render("**bold**\nnext")).toBe("<p><strong>bold</strong><br/>\nnext</p>");
  });

  it("leaves code alone", () => {
    expect(render("```\na\nb\n```")).toBe("<pre><code>a\nb\n</code></pre>");
    expect(render("use `a` then\n`b`")).toBe("<p>use <code>a</code> then<br/>\n<code>b</code></p>");
  });

  it("tells web links from paths", () => {
    expect(isWebLink("https://example.com")).toBe(true);
    expect(isWebLink("mailto:me@example.com")).toBe(true);
    expect(isWebLink("src/server/main.ts")).toBe(false);
    expect(isWebLink("#section")).toBe(false);
    expect(isWebLink(undefined)).toBe(false);
    expect(linkPath("file:///Users/me/My%20Notes.md")).toBe("/Users/me/My Notes.md");
    expect(linkPath("src/100%.md")).toBe("src/100%.md");
  });
});
