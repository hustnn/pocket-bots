import { useState } from "react";
import { applyDefaults, DEFAULT_BOT_DEFAULTS, EMPTY_LIBRARY, type Preset } from "../../shared/bot";
import { readyProvider, readyProviders } from "../../shared/changes";
import { addBundledSkills, addImportedBots } from "../../shared/library";
import { bundledSkillsInstallRpc, importBotsRpc } from "../../shared/rpc";
import { BOT_TEMPLATES, botFromPreset, newBot, withTemplateSettings, type BotTemplate } from "../../shared/templates";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/icons";
import { Button, Modal, Segmented, useFeedback } from "../components/ui";
import { errorText, rpc } from "../lib/api";
import { useCommit, useProviders, useStoreDoc } from "../lib/data";

type Start = { template?: BotTemplate; preset?: Preset } | null;

export function NewBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (botId: string) => void }) {
  const doc = useStoreDoc();
  const providers = useProviders();
  const commit = useCommit();
  const feedback = useFeedback();
  const [mode, setMode] = useState<"new" | "import">("new");
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const presets = doc.data?.values.presets ?? [];

  const create = async (start: Start) => {
    setBusy(true);
    try {
      const entries = providers.data?.entries ?? [];
      const provider = readyProvider(entries);
      const defaults = doc.data?.values.defaults ?? DEFAULT_BOT_DEFAULTS;
      const base = start?.preset ? botFromPreset(provider, start.preset) : newBot(provider, start?.template);
      const bot = withTemplateSettings(applyDefaults(base, defaults, provider), start?.template, readyProviders(entries));
      if (!bot.provider) throw new Error("No agent is ready yet. Install and sign in to Claude Code, Codex or another agent CLI first.");
      // A role's skills ship with pocket-bots: they go in the library, reviewed, along with the bot.
      const { skills } = start?.template?.skills?.length ? await rpc(bundledSkillsInstallRpc, { ids: [...start.template.skills] }) : { skills: [] };
      await commit((values) => ({ ...values, library: skills.length ? addBundledSkills(values.library ?? EMPTY_LIBRARY, skills) : values.library, bots: [...values.bots, bot] }));
      onCreated(bot.id);
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async () => {
    setBusy(true);
    try {
      const { bots } = await rpc(importBotsRpc, { json });
      await commit((values) => addImportedBots(values, bots));
      if (bots.length > 1) feedback.toast(`Added ${bots.length} bots`);
      const first = bots[0]?.bot;
      if (first) onCreated(first.id);
      else onClose();
    } catch (error) {
      feedback.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New bot"
      wide
      onClose={onClose}
      footer={
        mode === "import" ? (
          <Button variant="primary" busy={busy} disabled={!json.trim()} onClick={() => void importFile()}>
            Import
          </Button>
        ) : undefined
      }
    >
      <div className="stack">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "new", label: "Start" },
            { value: "import", label: "Import" },
          ]}
        />
        {mode === "new" ? (
          <>
            <div className="grid-2">
              <button type="button" className="tile" disabled={busy} onClick={() => void create(null)}>
                <div className="row">
                  <span className="icon-btn" style={{ background: "var(--surface1)" }}>
                    <Icon name="plus" />
                  </span>
                  <strong>Blank bot</strong>
                </div>
                <span className="hint">Start from nothing and write its instructions yourself.</span>
              </button>
              {BOT_TEMPLATES.map((template) => (
                <button key={template.id} type="button" className="tile" disabled={busy} onClick={() => void create({ template })}>
                  <div className="row">
                    <Avatar avatar={{ seed: template.avatarSeed }} size={30} />
                    <div>
                      <strong>{template.name}</strong>
                      <div className="hint">{template.title}</div>
                    </div>
                  </div>
                  <span className="hint">{template.description}</span>
                </button>
              ))}
            </div>
            {presets.length ? (
              <>
                <div className="field-label">Your presets</div>
                <div className="grid-2">
                  {presets.map((preset) => (
                    <button key={preset.id} type="button" className="tile" disabled={busy} onClick={() => void create({ preset })}>
                      <div className="row">
                        <Avatar avatar={preset.avatar} size={30} />
                        <div>
                          <strong>{preset.name}</strong>
                          {preset.title ? <div className="hint">{preset.title}</div> : null}
                        </div>
                      </div>
                      {preset.description ? <span className="hint">{preset.description}</span> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <>
            <p className="hint" style={{ margin: 0 }}>
              Paste a bot file, or a file of several bots, exported from pocket-bots, or pick the file. Teams in older files aren't imported.
            </p>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(setJson);
              }}
            />
            <textarea className="textarea mono" rows={12} value={json} onChange={(event) => setJson(event.target.value)} placeholder='{"format": "pocket-bots", ...}' />
          </>
        )}
      </div>
    </Modal>
  );
}
