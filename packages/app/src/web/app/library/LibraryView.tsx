import { useEffect, useState } from "react";
import { Icon } from "../../components/icons";
import { navigate } from "../../lib/router";
import { AppsTab } from "./AppsTab";
import { McpTab } from "./McpTab";
import { SkillsTab } from "./SkillsTab";

/** Skills & Tools: one library of skills and MCP servers, switched on per bot, plus connected apps. */
const SEARCH_PLACEHOLDER = { skills: "Search skills", mcp: "Search MCP servers", apps: "Search connected and available apps" } as const;

export function LibraryView({ tab }: { tab: "skills" | "mcp" | "apps" }) {
  const [query, setQuery] = useState("");
  // Each tab searches its own things, so a new tab starts with an empty search.
  useEffect(() => setQuery(""), [tab]);
  return (
    <>
      <div className="topbar">
        <div className="title">Skills & Tools</div>
      </div>
      <div className="panel-tabs" style={{ paddingLeft: 16 }}>
        {(
          [
            ["skills", "Skills"],
            ["mcp", "MCP servers"],
            ["apps", "Connected apps"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => navigate({ page: "library", tab: id })}>
            {label}
          </button>
        ))}
      </div>
      <div className="page">
        <div className="page-inner">
          <div className="search-field">
            <Icon name="search" size={14} />
            <input className="input" type="search" value={query} placeholder={SEARCH_PLACEHOLDER[tab]} aria-label={SEARCH_PLACEHOLDER[tab]} onChange={(event) => setQuery(event.target.value)} />
          </div>
          {tab === "skills" ? <SkillsTab query={query} /> : tab === "mcp" ? <McpTab query={query} /> : <AppsTab query={query} />}
        </div>
      </div>
    </>
  );
}
