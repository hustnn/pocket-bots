import { defaultModelId, type Bot } from "../../../shared/bot";
import { CommitInput, Field, Segmented } from "../../components/ui";
import { useState } from "react";
import { useProviders, useWorkspaces } from "../../lib/data";
import { Section, useUpdateBot } from "./common";

/** An absolute path: /…, ~/…, C:\… or a \\share. */
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/;

/** Managed, or a folder of the bot's own: picked from the folders other bots work in, or typed. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const update = useUpdateBot();
  const custom = bot.cwd !== null;
  const workspaces = useWorkspaces(custom);
  const [pathError, setPathError] = useState<string | null>(null);
  const list = workspaces.data ?? [];
  const picked = list.find((workspace) => workspace.directory === bot.cwd);
  return (
    <Section title="Working folder" info="Managed folders keep the bot's memory and skills beside its chats. A custom folder lets it work in one of your projects.">
      <Segmented
        value={custom ? "custom" : "managed"}
        onChange={(value) => {
          setPathError(null);
          void update(bot.id, { cwd: value === "managed" ? null : (bot.cwd ?? "") });
        }}
        options={[
          { value: "managed", label: "Managed" },
          { value: "custom", label: "Custom" },
        ]}
      />
      {custom ? (
        <>
          {list.length ? (
            <Field label="A folder another bot uses" hint="Folders your other bots work in.">
              <select
                className="select"
                value={picked?.directory ?? ""}
                onChange={(event) => {
                  if (!event.target.value) return;
                  setPathError(null);
                  void update(bot.id, { cwd: event.target.value });
                }}
              >
                <option value="">{bot.cwd ? "Another folder" : "Choose a folder"}</option>
                {list.map((workspace) => (
                  <option key={workspace.id} value={workspace.directory}>
                    {workspace.label} — {workspace.directory}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Folder on this computer" hint="An absolute path. Until one is set, chats use the managed folder." error={pathError}>
            <CommitInput
              value={bot.cwd ?? ""}
              placeholder="/Users/me/projects/site"
              onCommit={(text) => {
                const cwd = text.trim();
                if (cwd && !ABSOLUTE_PATH.test(cwd)) {
                  setPathError("Use an absolute path, like /Users/me/projects/site.");
                  return;
                }
                setPathError(null);
                void update(bot.id, { cwd });
              }}
            />
          </Field>
        </>
      ) : null}
    </Section>
  );
}

export function ModelSection({ bot }: { bot: Bot }) {
  const update = useUpdateBot();
  const providers = useProviders();
  const entries = (providers.data?.entries ?? []).filter((entry) => entry.enabled || entry.provider === bot.provider);
  const entry = entries.find((candidate) => candidate.provider === bot.provider);
  const models = (entry?.models ?? []).filter((model) => model.isSelectable !== false);
  const resolvedModel = bot.model ?? defaultModelId(models);
  const model = models.find((candidate) => candidate.id === resolvedModel);
  const thinking = model?.thinkingOptions ?? [];
  const modes = entry?.modes ?? [];

  return (
    <>
      <Section title="Agent" info="Which coding agent CLI runs this bot's chats, on its own login. Changes apply to new chats.">
        {providers.isPending ? <span className="spinner" /> : null}
        <Field label="Provider" hint={entry && entry.status !== "ready" ? `${entry.label ?? entry.provider} is ${entry.status}${entry.error ? `: ${entry.error}` : ""}.` : undefined}>
          <select className="select" value={bot.provider} onChange={(event) => void update(bot.id, { provider: event.target.value, model: null, modeId: null, thinkingOptionId: null })}>
            {!entry ? <option value={bot.provider}>{bot.provider || "Pick a provider"}</option> : null}
            {entries.map((candidate) => (
              <option key={candidate.provider} value={candidate.provider}>
                {candidate.label ?? candidate.provider}
                {candidate.status !== "ready" ? ` (${candidate.status})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <select className="select" value={bot.model ?? ""} onChange={(event) => void update(bot.id, { model: event.target.value || null, thinkingOptionId: null })}>
            <option value="">Provider default{resolvedModel && !bot.model ? ` (${models.find((candidate) => candidate.id === resolvedModel)?.label ?? resolvedModel})` : ""}</option>
            {models.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Field>
        {thinking.length ? (
          <Field label="Thinking">
            <select className="select" value={bot.thinkingOptionId ?? ""} onChange={(event) => void update(bot.id, { thinkingOptionId: event.target.value || null })}>
              <option value="">Default</option>
              {thinking.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </Section>
      <Section title="Permissions">
        <Field label="Approval mode" hint="Modes like bypassPermissions or full-access run tools without asking.">
          <select className="select" value={bot.modeId ?? ""} onChange={(event) => void update(bot.id, { modeId: event.target.value || null })}>
            <option value="">Provider default{entry?.defaultModeId ? ` (${entry.defaultModeId})` : ""}</option>
            {modes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact other bots" hint="Whether this bot may hand work to other bots with ask_bot.">
          <Segmented
            value={bot.contactBots}
            onChange={(contactBots) => void update(bot.id, { contactBots })}
            options={[
              { value: "ask", label: "Ask first" },
              { value: "allow", label: "Allowed" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
      </Section>
      <WorkingFolder bot={bot} />
    </>
  );
}
