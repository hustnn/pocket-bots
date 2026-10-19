import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DEFAULT_BOT_DEFAULTS, type BotDefaults } from "../../shared/bot";
import { avatarKeyStatusRpc, avatarRemoveKeyRpc, avatarSetKeyRpc, exportBotsRpc, type statusRpc } from "../../shared/rpc";
import type { RpcOutput } from "../../shared/rpc-core";
import { Avatar } from "../components/Avatar";
import { Button, Field, IconButton, Segmented, useAction } from "../components/ui";
import { parseSendBehavior, type SendBehavior } from "../chat/composer";
import { rpc } from "../lib/api";
import { useCommit, useProviders, useStoreDoc } from "../lib/data";
import { SEND_BEHAVIOR_KEY, useLocalState } from "../lib/local";
import { Section } from "./panel/common";

type Status = RpcOutput<typeof statusRpc>;

function Defaults() {
  const doc = useStoreDoc();
  const commit = useCommit();
  const providers = useProviders();
  const defaults: BotDefaults = doc.data?.values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const set = (patch: Partial<BotDefaults>) => void commit((values) => ({ ...values, defaults: { ...(values.defaults ?? DEFAULT_BOT_DEFAULTS), ...patch } }));
  const entry = providers.data?.entries.find((candidate) => candidate.provider === defaults.provider);
  return (
    <Section title="New bots start with" info="Roles and blank bots use these. An empty provider picks one that's ready, preferring Claude.">
      <Field label="Provider">
        <select className="select" value={defaults.provider} onChange={(event) => set({ provider: event.target.value, model: null, modeId: null, thinkingOptionId: null })}>
          <option value="">Whichever is ready</option>
          {(providers.data?.entries ?? [])
            .filter((candidate) => candidate.enabled)
            .map((candidate) => (
              <option key={candidate.provider} value={candidate.provider}>
                {candidate.label ?? candidate.provider}
                {candidate.status !== "ready" ? ` (${candidate.status})` : ""}
              </option>
            ))}
        </select>
      </Field>
      {entry ? (
        <>
          <Field label="Model">
            <select className="select" value={defaults.model ?? ""} onChange={(event) => set({ model: event.target.value || null })}>
              <option value="">Provider default</option>
              {(entry.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Approval mode">
            <select className="select" value={defaults.modeId ?? ""} onChange={(event) => set({ modeId: event.target.value || null })}>
              <option value="">Provider default</option>
              {(entry.modes ?? []).map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}
      <Field label="Contact other bots">
        <Segmented
          value={defaults.contactBots}
          onChange={(contactBots) => set({ contactBots })}
          options={[
            { value: "ask", label: "Ask first" },
            { value: "allow", label: "Allowed" },
            { value: "off", label: "Off" },
          ]}
        />
      </Field>
    </Section>
  );
}

function Presets() {
  const doc = useStoreDoc();
  const commit = useCommit();
  const presets = doc.data?.values.presets ?? [];
  return (
    <Section title="Presets" info='Bots saved as starting points ("Save as preset" in a bot&apos;s Overview). They show up under New bot.'>
      {presets.length === 0 ? <div className="hint">No presets yet.</div> : null}
      {presets.map((preset) => (
        <div key={preset.id} className="row">
          <Avatar avatar={preset.avatar} size={26} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{preset.name}</div>
            {preset.title ? <div className="hint">{preset.title}</div> : null}
          </div>
          <IconButton icon="trash" title="Delete preset" onClick={() => void commit((values) => ({ ...values, presets: (values.presets ?? []).filter((entry) => entry.id !== preset.id) }))} />
        </div>
      ))}
    </Section>
  );
}

function AvatarKey() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["avatar", "key"], queryFn: () => rpc(avatarKeyStatusRpc, {}) });
  const [key, setKey] = useState("");
  const { busy, run } = useAction();
  return (
    <Section title="Avatar pictures" info="An OpenAI key lets bots get drawn avatars. It stays on this computer.">
      {status.data?.configured ? (
        <div className="row">
          <span className="badge success">Key saved</span>
          <span className="hint mono">{status.data.keyHint}</span>
          <span className="spacer" />
          <Button small variant="danger" busy={busy === "remove"} onClick={() => void run("remove", async () => {
            await rpc(avatarRemoveKeyRpc, {});
            await client.invalidateQueries({ queryKey: ["avatar", "key"] });
          })}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="row">
          <input className="input mono" type="password" placeholder="sk-…" value={key} onChange={(event) => setKey(event.target.value)} />
          <Button small variant="primary" busy={busy === "save"} disabled={!key.trim()} onClick={() => void run("save", async () => {
            await rpc(avatarSetKeyRpc, { key: key.trim() });
            setKey("");
            await client.invalidateQueries({ queryKey: ["avatar", "key"] });
          })}>
            Save
          </Button>
        </div>
      )}
    </Section>
  );
}

function Backup() {
  const doc = useStoreDoc();
  const { busy, run } = useAction();
  const values = doc.data?.values;
  return (
    <Section title="Back up" info="One file with every bot. Secrets in MCP settings are redacted. Import it from New bot → Import.">
      <div className="row">
        {[false, true].map((includeMemory) => (
          <Button
            key={String(includeMemory)}
            small
            icon="download"
            busy={busy === String(includeMemory)}
            disabled={!values?.bots.length}
            onClick={() =>
              void run(String(includeMemory), async () => {
                const { json } = await rpc(exportBotsRpc, { bots: values!.bots.slice(0, 50), includeMemory });
                const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = "pocket-bots-bots.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            {includeMemory ? "Export with memory" : "Export all bots"}
          </Button>
        ))}
      </div>
    </Section>
  );
}

const SEND_HINTS: Record<SendBehavior, string> = {
  steer: "The message joins the turn in progress and the bot takes it into account.",
  interrupt: "The bot stops what it's doing and starts on the new message.",
  queue: "The message waits and goes out when the bot finishes. pocket-bots sends it even with this page closed.",
};

/** What a message does while the bot is still working; kept in this browser. */
function Chats() {
  const [stored, setStored] = useLocalState<string>(SEND_BEHAVIOR_KEY, "steer");
  const behavior = parseSendBehavior(stored);
  const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘↵" : "Ctrl+Enter";
  return (
    <Section title="Chats">
      <Field label="When the bot is working, a new message" hint={`${SEND_HINTS[behavior]} ${shortcut} does the other: it queues, or with Queue on, it interrupts.`}>
        <Segmented<SendBehavior>
          value={behavior}
          onChange={setStored}
          options={[
            { value: "steer", label: "Steers" },
            { value: "interrupt", label: "Interrupts" },
            { value: "queue", label: "Queues" },
          ]}
        />
      </Field>
    </Section>
  );
}

export function SettingsView({ status }: { status: Status | null }) {
  const providers = useProviders();
  return (
    <>
      <div className="topbar">
        <div className="title">Settings</div>
      </div>
      <div className="page">
        <div className="page-inner" style={{ maxWidth: 680 }}>
          <Section title="pocket-bots">
            <dl className="kv">
              <dt>Agents</dt>
              <dd>
                {(providers.data?.entries ?? []).map((entry) => (
                  <div key={entry.provider}>
                    <span className={`badge ${entry.status === "ready" ? "success" : entry.status === "error" ? "warning" : "danger"}`}>{entry.label}</span> {entry.version ?? ""} {entry.status !== "ready" ? <span className="hint">{entry.error ?? entry.status}</span> : null}
                  </div>
                ))}
              </dd>
              <dt>Routines</dt>
              <dd>{status?.scheduler ? "Running" : "Stopped"}</dd>
              <dt>Data folder</dt>
              <dd className="mono">{status?.dataPath ?? "…"}</dd>
              <dt>Version</dt>
              <dd>{status?.version ?? "…"}</dd>
            </dl>
            <div className="hint">Change the ports in config.json in the data folder, or with POCKET_BOTS_* environment variables, then restart pocket-bots.</div>
          </Section>
          <Chats />
          <Defaults />
          <Presets />
          <AvatarKey />
          <Backup />
        </div>
      </div>
    </>
  );
}
