import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { accountLabel, APPS_MCP_NAME, withAppRule, type AppAccount } from "../../../shared/apps";
import { botMcpServers, EMPTY_LIBRARY, toolGrants, type AppRule, type Bot } from "../../../shared/bot";
import { TOOLS_MCP_NAME } from "../../../shared/bot-tools";
import { mcpTarget, setBotUses } from "../../../shared/library";
import { appsAccountsRpc, appsCatalogRpc, appsStatusRpc, appsToolsRpc, commandListRpc, commandRemoveRpc } from "../../../shared/rpc";
import { Button, CommitInput, Field, IconButton, Modal, Segmented, Toggle, useAction } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useStoreDoc } from "../../lib/data";
import { navigate } from "../../lib/router";
import { Section, useUpdateBot } from "./common";

/**
 * Grants written by hand, one "server/tool" per line, for tools the server
 * list doesn't show (a server not tested yet, or the bot's own and app tools).
 * Only grants for servers this bot has reach the agent.
 */
function GrantsField({ bot }: { bot: Bot }) {
  const doc = useStoreDoc();
  const update = useUpdateBot();
  const library = doc.data?.values.library ?? EMPTY_LIBRARY;
  const active = new Set([...botMcpServers(bot, library).map((server) => server.name), ...(bot.apps.length ? [APPS_MCP_NAME] : []), TOOLS_MCP_NAME]);
  const valid = toolGrants(bot.alwaysAllow).filter((grant) => active.has(grant.server)).length;
  const ignored = bot.alwaysAllow.length - valid;
  return (
    <Field
      label="Always allowed tools"
      hint={
        <>
          One <span className="mono">server/tool</span> per line; the boxes above edit the same list. Only providers with exact tool grants (Claude, Codex, OpenCode) use them. {valid} valid
          {ignored ? <span className="error-text"> · {ignored} ignored (not this bot's servers, or not server/tool)</span> : null}
        </>
      }
    >
      <CommitInput
        multiline
        mono
        rows={4}
        value={bot.alwaysAllow.join("\n")}
        placeholder={"github/search_issues\nbots/list_bots"}
        onCommit={(text) => void update(bot.id, { alwaysAllow: [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))] })}
      />
    </Field>
  );
}

function McpServers({ bot }: { bot: Bot }) {
  const doc = useStoreDoc();
  const update = useUpdateBot();
  const servers = doc.data?.values.library?.mcpServers ?? [];
  const toggleGrant = (grant: string, on: boolean) =>
    void update(bot.id, (current) => ({ ...current, alwaysAllow: on ? [...new Set([...current.alwaysAllow, grant])] : current.alwaysAllow.filter((entry) => entry !== grant) }));
  return (
    <Section
      title="MCP servers"
      info="Servers from Skills & Tools this bot may use. Tick a tool to run it without asking."
      actions={
        <Button small icon="library" onClick={() => navigate({ page: "library", tab: "mcp" })}>
          Library
        </Button>
      }
    >
      {servers.length === 0 ? <div className="hint">The library has no MCP servers yet.</div> : null}
      <div>
        {servers.map((server) => {
          const on = bot.mcpServerIds.includes(server.id);
          return (
            <div key={server.id} className="check-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row">
                    <strong className="truncate">{server.name}</strong>
                    {!server.enabled ? <span className="badge">Off in library</span> : null}
                  </div>
                  <div className="hint truncate mono">{mcpTarget(server.config)}</div>
                </div>
                <Toggle on={on} label={`Use ${server.name}`} onChange={(next) => void update(bot.id, (current) => setBotUses(current, "mcp", server.id, next))} />
              </div>
              {on && server.tools?.length ? (
                <div style={{ paddingLeft: 4, marginTop: 6 }}>
                  {server.tools.map((tool) => {
                    const grant = `${server.name}/${tool.name}`;
                    return (
                      <label key={tool.name} className="row small" style={{ padding: "2px 0", cursor: "pointer" }} title={tool.description}>
                        <input type="checkbox" checked={bot.alwaysAllow.includes(grant)} onChange={(event) => toggleGrant(grant, event.target.checked)} />
                        <span className="mono">{tool.name}</span>
                        <span className="hint truncate">{tool.description}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <GrantsField bot={bot} />
    </Section>
  );
}

type ToolMode = "all" | "read" | "chosen";

/** What a bot's rule on one app allows, in a few words; null when it allows everything. */
function ruleSummary(rule: AppRule | undefined, accounts: readonly AppAccount[], appName: string): string | null {
  if (!rule) return null;
  const account = accounts.find((entry) => entry.id === rule.account);
  const tools = rule.tools === "read" ? "Read-only tools" : Array.isArray(rule.tools) ? `${rule.tools.length} chosen ${rule.tools.length === 1 ? "tool" : "tools"}` : null;
  return [tools, account ? `only ${accountLabel(account, appName)}` : rule.account ? "an account that's gone" : null].filter(Boolean).join(" · ") || null;
}

/**
 * How one bot may use one app: the account it's kept to, and all of the app's
 * tools, the read-only ones or chosen ones. The relay enforces both.
 */
function AppAccessModal({ app, accounts, rule, onClose, onSave }: { app: { slug: string; name: string }; accounts: readonly AppAccount[]; rule: AppRule | undefined; onClose: () => void; onSave: (rule: AppRule) => void }) {
  const tools = useQuery({ queryKey: ["apps", "tools", app.slug], queryFn: () => rpc(appsToolsRpc, { slug: app.slug }), staleTime: 10 * 60_000 });
  const list = tools.data?.tools ?? [];
  const readOnly = list.filter((tool) => tool.readOnly);
  // An account that has since been disconnected reads as any account.
  const [account, setAccount] = useState(accounts.some((entry) => entry.id === rule?.account) ? rule!.account : null);
  const [mode, setMode] = useState<ToolMode>(Array.isArray(rule?.tools) ? "chosen" : (rule?.tools ?? "all"));
  const [chosen, setChosen] = useState<string[]>(Array.isArray(rule?.tools) ? rule.tools : []);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // Chosen tools the app no longer lists (or that can't be listed right now) stay visible, so they can be unticked.
  const missing = chosen.filter((slug) => !list.some((tool) => tool.slug === slug)).map((slug) => ({ slug, name: slug, readOnly: false, missing: true }));
  const all = [...missing, ...list.map((tool) => ({ ...tool, missing: false }))];
  const shown = needle ? all.filter((tool) => tool.name.toLowerCase().includes(needle) || tool.slug.toLowerCase().includes(needle)) : all;
  const pick = (next: ToolMode) => {
    // Choosing tools starts from the read-only ones.
    if (next === "chosen" && chosen.length === 0) setChosen(readOnly.map((tool) => tool.slug));
    setMode(next);
  };
  return (
    <Modal
      title={`${app.name} access`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={mode === "chosen" && chosen.length === 0} onClick={() => onSave({ tools: mode === "chosen" ? chosen : mode, account })}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {accounts.length > 1 || rule?.account ? (
          <Field label="Account" hint="With any account, the bot picks one by its name.">
            <select className="select" value={account ?? ""} onChange={(event) => setAccount(event.target.value || null)}>
              <option value="">Any account</option>
              {accounts.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {accountLabel(entry, app.name)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field
          label="Tools"
          hint={
            mode === "read"
              ? `The tools Composio marks as only reading${tools.data ? ` (${readOnly.length} of ${list.length})` : ""}, including ones it adds later.`
              : mode === "chosen"
                ? "Only the tools ticked below. Tools Composio adds later stay off."
                : "Every tool of the app, including ones Composio adds later."
          }
        >
          <Segmented<ToolMode>
            value={mode}
            onChange={pick}
            options={[
              { value: "all", label: "All tools" },
              { value: "read", label: "Read-only" },
              { value: "chosen", label: "Chosen tools" },
            ]}
          />
        </Field>
        {mode === "chosen" ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <input className="input" value={query} placeholder={`Search ${app.name} tools`} onChange={(event) => setQuery(event.target.value)} />
              <span className="hint" style={{ whiteSpace: "nowrap" }}>{`${chosen.length} chosen`}</span>
            </div>
            {tools.isPending ? (
              <div className="hint row">
                <span className="spinner" /> Loading tools…
              </div>
            ) : null}
            {tools.error ? <div className="error-text">{errorText(tools.error)}</div> : null}
            {tools.data && shown.length === 0 ? <div className="hint">{needle ? "No tools match." : "No tools to list. Is Composio connected?"}</div> : null}
            <div className="scroll" style={{ maxHeight: 320 }}>
              {shown.map((tool) => (
                <label key={tool.slug} className="row small" style={{ padding: "3px 0", cursor: "pointer", alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    style={{ marginTop: 3 }}
                    checked={chosen.includes(tool.slug)}
                    onChange={(event) => setChosen((current) => (event.target.checked ? [...current, tool.slug] : current.filter((slug) => slug !== tool.slug)))}
                  />
                  <span style={{ minWidth: 0 }}>
                    {tool.name}
                    <span className="hint mono" style={{ display: "block" }}>
                      {tool.missing ? "not in the app's tool list" : tool.slug}
                      {tool.readOnly ? " · read-only" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Apps({ bot }: { bot: Bot }) {
  const update = useUpdateBot();
  const status = useQuery({ queryKey: ["apps", "status"], queryFn: () => rpc(appsStatusRpc, {}) });
  const configured = status.data?.configured ?? false;
  const accounts = useQuery({ queryKey: ["apps", "accounts"], queryFn: () => rpc(appsAccountsRpc, {}), enabled: configured });
  const catalog = useQuery({ queryKey: ["apps", "catalog"], queryFn: () => rpc(appsCatalogRpc, {}), enabled: configured, staleTime: 3_600_000 });
  const [editing, setEditing] = useState<string | null>(null);
  const connected = [...new Set((accounts.data?.accounts ?? []).filter((account) => account.status === "connected").map((account) => account.slug))];
  const slugs = [...new Set([...connected, ...bot.apps])];
  const nameOf = (slug: string) => catalog.data?.apps.find((app) => app.slug === slug)?.name ?? slug;
  const accountsOf = (slug: string) => (accounts.data?.accounts ?? []).filter((account) => account.slug === slug && account.status === "connected");
  return (
    <Section
      title="Connected apps"
      info="Apps signed in through your Composio account. The key never reaches the bot; a local relay only lets it use what you switch on, within the limits you set."
      actions={
        <Button small icon="plug" onClick={() => navigate({ page: "library", tab: "apps" })}>
          Apps
        </Button>
      }
    >
      {!configured ? <div className="hint">Add a Composio key under Skills & Tools → Connected apps to use apps.</div> : null}
      {configured && slugs.length === 0 ? <div className="hint">No apps are connected yet.</div> : null}
      <div>
        {slugs.map((slug) => {
          const on = bot.apps.includes(slug);
          const summary = ruleSummary(bot.appRules[slug], accountsOf(slug), nameOf(slug));
          return (
            <div key={slug} className="check-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row">
                  <strong className="truncate">{nameOf(slug)}</strong>
                  {!connected.includes(slug) ? <span className="badge warning">Not signed in</span> : null}
                </div>
                {on ? <div className="hint truncate">{summary ?? "All tools, any account"}</div> : null}
              </div>
              {on ? (
                <Button small variant="ghost" icon="shield" onClick={() => setEditing(slug)}>
                  Limits
                </Button>
              ) : null}
              <Toggle on={on} label={`Use ${nameOf(slug)}`} onChange={(next) => void update(bot.id, (current) => ({ ...current, apps: next ? [...new Set([...current.apps, slug])] : current.apps.filter((entry) => entry !== slug) }))} />
            </div>
          );
        })}
      </div>
      {editing ? (
        <AppAccessModal
          app={{ slug: editing, name: nameOf(editing) }}
          accounts={accountsOf(editing)}
          rule={bot.appRules[editing]}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            const slug = editing;
            setEditing(null);
            void update(bot.id, (current) => ({ ...current, appRules: withAppRule(current.appRules, slug, rule) }));
          }}
        />
      ) : null}
    </Section>
  );
}

function Commands({ bot }: { bot: Bot }) {
  const client = useQueryClient();
  const rules = useQuery({ queryKey: ["commands", bot.id], queryFn: () => rpc(commandListRpc, { botId: bot.id }) });
  const { run } = useAction();
  return (
    <Section title="Allowed commands" info='Exact commands in exact folders this bot runs without asking. Add one with "Always allow" on a command approval.'>
      {rules.data?.rules.length === 0 ? <div className="hint">None yet.</div> : null}
      {(rules.data?.rules ?? []).map((rule) => (
        <div key={rule.id} className="row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono small truncate" title={rule.command}>
              {rule.command}
            </div>
            <div className="hint truncate">in {rule.cwd}</div>
          </div>
          <IconButton
            icon="trash"
            title="Remove"
            onClick={() =>
              void run("remove", async () => {
                await rpc(commandRemoveRpc, { botId: bot.id, id: rule.id });
                await client.invalidateQueries({ queryKey: ["commands", bot.id] });
              })
            }
          />
        </div>
      ))}
    </Section>
  );
}

export function AccessSection({ bot }: { bot: Bot }) {
  return (
    <>
      <McpServers bot={bot} />
      <Apps bot={bot} />
      <Commands bot={bot} />
    </>
  );
}
