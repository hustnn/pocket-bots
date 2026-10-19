import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EMPTY_LIBRARY, formatPairs, joinArgs, MCP_NAME, parseMcpJson, parsePairs, RESERVED_MCP_NAMES, splitArgs, type BotMcpServer, type LibraryMcpServer, type McpServerConfig } from "../../../shared/bot";
import { addMcpServers, forgetItem, matchesQuery, mcpServerTested, mcpTarget, renameGrants, setBotUses, updateMcpServer } from "../../../shared/library";
import { mcpProbeRpc, mcpSourcesRpc } from "../../../shared/rpc";
import { relativeTime } from "../../../shared/time";
import { Avatar } from "../../components/Avatar";
import { Button, Field, Modal, Segmented, Toggle, useAction, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { useCommit, useStoreDoc } from "../../lib/data";

type Kind = McpServerConfig["type"];

function ServerForm({ initial, takenNames, onSave, onClose }: { initial: { name: string; config: McpServerConfig } | null; takenNames: string[]; onSave: (name: string, config: McpServerConfig) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Kind>(initial?.config.type ?? "stdio");
  const [command, setCommand] = useState(initial?.config.type === "stdio" ? [initial.config.command, joinArgs(initial.config.args)].filter(Boolean).join(" ") : "");
  const [url, setUrl] = useState(initial && initial.config.type !== "stdio" ? initial.config.url : "");
  const [pairs, setPairs] = useState(initial ? formatPairs(initial.config.type === "stdio" ? initial.config.env : initial.config.headers) : "");
  const { busy, run } = useAction();
  const trimmed = name.trim();
  const nameError = !trimmed ? "Give it a name." : !MCP_NAME.test(trimmed) ? "Letters, numbers, - and _ only." : RESERVED_MCP_NAMES.includes(trimmed) ? `"${trimmed}" is taken by pocket-bots.` : takenNames.includes(trimmed) ? "Another server has that name." : null;
  const config = (): McpServerConfig => {
    if (kind === "stdio") {
      const [bin = "", ...args] = splitArgs(command);
      return { type: "stdio", command: bin, args, env: parsePairs(pairs) };
    }
    return { type: kind, url: url.trim(), headers: parsePairs(pairs) };
  };
  const targetError = kind === "stdio" ? (!command.trim() ? "Enter the command that starts it." : null) : !/^https?:\/\//.test(url.trim()) ? "Enter an http(s) URL." : null;
  return (
    <Modal
      title={initial ? `Edit ${initial.name}` : "New MCP server"}
      onClose={onClose}
      footer={
        <Button variant="primary" busy={busy === "save"} disabled={!!nameError || !!targetError} onClick={() => void run("save", () => onSave(trimmed, config()))}>
          Save
        </Button>
      }
    >
      <div className="stack">
        <Field label="Name" hint="Bots see its tools as name/tool." error={name ? nameError : null}>
          <input className="input" value={name} placeholder="github" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Segmented<Kind>
          value={kind}
          onChange={setKind}
          options={[
            { value: "stdio", label: "Command (stdio)" },
            { value: "http", label: "HTTP" },
            { value: "sse", label: "SSE" },
          ]}
        />
        {kind === "stdio" ? (
          <Field label="Command" hint="Runs on this computer.">
            <input className="input mono" value={command} placeholder="npx -y @modelcontextprotocol/server-github" onChange={(event) => setCommand(event.target.value)} />
          </Field>
        ) : (
          <Field label="URL">
            <input className="input mono" value={url} placeholder="https://mcp.example.com/mcp" onChange={(event) => setUrl(event.target.value)} />
          </Field>
        )}
        <Field label={kind === "stdio" ? "Environment (KEY=value per line)" : "Headers (Name=value per line)"} hint="Stored in pocket-bots's settings and in each chat's config on the daemon.">
          <textarea className="textarea mono" rows={4} value={pairs} onChange={(event) => setPairs(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const commit = useCommit();
  const feedback = useFeedback();
  const sources = useQuery({ queryKey: ["mcp", "sources"], queryFn: () => rpc(mcpSourcesRpc, {}) });
  const [json, setJson] = useState("");
  const save = async (text: string) => {
    try {
      const drafts: BotMcpServer[] = parseMcpJson(text);
      await commit((values) => ({ ...values, library: addMcpServers(values.library ?? EMPTY_LIBRARY, drafts).library }));
      feedback.toast(`Added ${drafts.length} server${drafts.length === 1 ? "" : "s"}. Test each to turn it on.`);
      onClose();
    } catch (error) {
      feedback.error(errorText(error));
    }
  };
  return (
    <Modal title="Import MCP servers" wide onClose={onClose} footer={<Button variant="primary" disabled={!json.trim()} onClick={() => void save(json)}>Import pasted JSON</Button>}>
      <div className="stack">
        <div className="field-label">From apps on this computer</div>
        {sources.isPending ? <span className="spinner" /> : null}
        {sources.data?.sources.length === 0 ? <div className="hint">No Claude Code, Claude Desktop or Cursor MCP config found.</div> : null}
        <div className="row wrap">
          {(sources.data?.sources ?? []).map((source) => (
            <Button key={source.label} icon="download" onClick={() => void save(source.json)}>
              {source.label} ({source.count})
            </Button>
          ))}
        </div>
        <Field label="Or paste JSON" hint='The {"mcpServers": {...}} shape from Claude Code, Cursor or .mcp.json.'>
          <textarea className="textarea mono" rows={10} value={json} onChange={(event) => setJson(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ServerDetail({ server, otherNames }: { server: LibraryMcpServer; otherNames: string[] }) {
  const doc = useStoreDoc();
  const commit = useCommit();
  const feedback = useFeedback();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const bots = (doc.data?.values.bots ?? []).filter((bot) => !bot.archived);
  const patch = (change: Partial<LibraryMcpServer>) => commit((values) => ({ ...values, library: updateMcpServer(values.library ?? EMPTY_LIBRARY, server.id, change) }));
  const tested = mcpServerTested(server);
  const test = async (config = server.config, enable = false) => {
    setTesting(true);
    try {
      const result = await rpc(mcpProbeRpc, { config });
      const checkedAt = new Date().toISOString();
      await patch(result.ok ? { tools: result.tools, checkError: null, checkedAt, ...(enable ? { enabled: true } : {}) } : { checkError: result.error, checkedAt });
    } catch (error) {
      await patch({ checkError: errorText(error), checkedAt: new Date().toISOString() });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="stack">
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }} className="mono">
          {server.name}
        </h2>
        <Toggle on={server.enabled} disabled={!tested && !server.enabled} label="Enabled" onChange={(enabled) => void patch({ enabled })} />
      </div>
      <div className="hint mono">{mcpTarget(server.config)}</div>
      {!server.enabled && !tested ? <div className="notice warning">New servers arrive switched off. The test starts it on this computer and lists its tools; it turns on once it connects.</div> : null}
      {server.checkError ? <div className="notice error">{server.checkError}</div> : null}
      <div className="row wrap">
        <Button variant={!tested ? "primary" : undefined} icon="plug" busy={testing} onClick={() => void test(server.config, !server.enabled)}>
          {!server.enabled && !tested ? "Test and turn on" : "Test again"}
        </Button>
        <Button icon="edit" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          variant="danger"
          icon="trash"
          onClick={async () => {
            if (!(await feedback.confirm({ title: `Delete ${server.name}?`, body: "No bot gets it any more.", action: "Delete", danger: true }))) return;
            await commit((values) => ({ ...values, library: { ...(values.library ?? EMPTY_LIBRARY), mcpServers: (values.library ?? EMPTY_LIBRARY).mcpServers.filter((entry) => entry.id !== server.id) }, bots: forgetItem(values.bots, "mcp", server.id) }));
          }}
        >
          Delete
        </Button>
      </div>
      <div className="field-label">Tools {server.checkedAt ? <span className="hint">· checked {relativeTime(server.checkedAt)}</span> : null}</div>
      {server.tools === null ? <div className="hint">Test it to list its tools.</div> : null}
      <div>
        {(server.tools ?? []).map((tool) => (
          <div key={tool.name} className="small" style={{ padding: "3px 0" }}>
            <span className="mono">{tool.name}</span> <span className="hint">{tool.description}</span>
          </div>
        ))}
      </div>
      <div className="field-label">Bots using it</div>
      <div>
        {bots.map((bot) => (
          <div key={bot.id} className="check-row" style={{ alignItems: "center" }}>
            <Avatar avatar={bot.avatar} size={24} />
            <span style={{ flex: 1 }}>{bot.name}</span>
            <Toggle on={bot.mcpServerIds.includes(server.id)} label={`${bot.name} uses ${server.name}`} onChange={(on) => void commit((values) => ({ ...values, bots: values.bots.map((entry) => (entry.id === bot.id ? setBotUses(entry, "mcp", server.id, on) : entry)) }))} />
          </div>
        ))}
      </div>
      {editing ? (
        <ServerForm
          initial={server}
          takenNames={otherNames}
          onClose={() => setEditing(false)}
          onSave={async (name, config) => {
            await commit((values) => ({
              ...values,
              library: updateMcpServer(values.library ?? EMPTY_LIBRARY, server.id, { name, config, tools: null, checkedAt: null, checkError: null }),
              bots: name !== server.name ? renameGrants(values.bots, server.name, name) : values.bots,
            }));
            setEditing(false);
            void test(config);
          }}
        />
      ) : null}
    </div>
  );
}

export function McpTab({ query }: { query: string }) {
  const doc = useStoreDoc();
  const commit = useCommit();
  const servers = doc.data?.values.library?.mcpServers ?? [];
  const shown = servers.filter((server) => matchesQuery(query, server.name, server.description, mcpTarget(server.config)));
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "import" | null>(null);
  const current = servers.find((server) => server.id === selected) ?? null;
  return (
    <div className="stack">
      <div className="row">
        <p className="hint" style={{ margin: 0, flex: 1 }}>
          MCP servers give bots more tools. Each bot switches on the ones it uses; stdio servers run on this computer.
        </p>
        <Button icon="download" onClick={() => setDialog("import")}>
          Import config
        </Button>
        <Button icon="plus" onClick={() => setDialog("new")}>
          New server
        </Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr)", gap: 20 }}>
        <div>
          {servers.length === 0 ? <div className="hint">No servers yet.</div> : shown.length === 0 ? <div className="hint">No servers match.</div> : null}
          {shown.map((server) => (
            <div key={server.id} className={`list-item${server.id === selected ? " active" : ""}`} onClick={() => setSelected(server.id)}>
              <span className="grow truncate mono small">{server.name}</span>
              {server.checkError ? <span className="badge danger">Error</span> : !server.enabled ? <span className="badge">Off</span> : null}
            </div>
          ))}
        </div>
        <div>{current ? <ServerDetail key={current.id} server={current} otherNames={servers.filter((server) => server.id !== current.id).map((server) => server.name)} /> : <div className="hint">Pick a server.</div>}</div>
      </div>
      {dialog === "import" ? <ImportDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "new" ? (
        <ServerForm
          initial={null}
          takenNames={servers.map((server) => server.name)}
          onClose={() => setDialog(null)}
          onSave={async (name, config) => {
            let id: string | undefined;
            await commit((values) => {
              const added = addMcpServers(values.library ?? EMPTY_LIBRARY, [{ name, enabled: false, config }]);
              id = added.ids[0];
              return { ...values, library: added.library };
            });
            setDialog(null);
            if (id) setSelected(id);
          }}
        />
      ) : null}
    </div>
  );
}
