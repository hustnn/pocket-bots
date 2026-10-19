import { useState } from "react";
import { estimateTokens, newPlaybookId, SOUL_MAX_BYTES, utf8Bytes, type Bot, type Playbook } from "../../../shared/bot";
import { parseTriggers } from "../../../shared/playbooks";
import { systemPromptRpc } from "../../../shared/rpc";
import { Button, CommitInput, Field, IconButton, Modal, useAction } from "../../components/ui";
import { rpc } from "../../lib/api";
import { Section, useUpdateBot } from "./common";

function PromptPreview({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ systemPrompt: string; sections: { title: string; text: string }[] } | null>(null);
  const { busy, run } = useAction();
  const load = () => void run("load", async () => setResult(await rpc(systemPromptRpc, { bot, local: true, message })));
  return (
    <Modal title="System prompt" wide onClose={onClose}>
      <div className="stack">
        <div className="row">
          <input className="input" placeholder="A first message, to see which playbooks it picks (optional)" value={message} onChange={(event) => setMessage(event.target.value)} />
          <Button busy={busy === "load"} onClick={load}>
            {result ? "Refresh" : "Show"}
          </Button>
        </div>
        {result ? (
          <>
            <div className="hint">
              About {estimateTokens(result.systemPrompt).toLocaleString()} tokens in {result.sections.length} sections. The agent's CLI adds its own instructions on top.
            </div>
            {result.sections.map((section) => (
              <div key={section.title} className="stack" style={{ gap: 4 }}>
                <div className="field-label">{section.title}</div>
                <pre className="pre-box">{section.text}</pre>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/** Each field saves on its own, as a change to the playbook as it is then, so quick edits to two fields both stick. */
function PlaybookEditor({ playbook, onSave, onDelete }: { playbook: Playbook; onSave: (patch: Partial<Playbook>) => void; onDelete: () => void }) {
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row">
        <div style={{ flex: 1 }}>
          <CommitInput value={playbook.name} placeholder="Name" onCommit={(name) => onSave({ name })} />
        </div>
        <IconButton icon="trash" title="Delete playbook" onClick={onDelete} />
      </div>
      <Field label="Trigger words" hint="Comma-separated. The playbook joins a chat when one appears in its first message.">
        <CommitInput value={playbook.triggers.join(", ")} placeholder="invoice, receipt, expense report" onCommit={(text) => onSave({ triggers: parseTriggers(text) })} />
      </Field>
      <Field label="Instructions">
        <CommitInput multiline rows={5} value={playbook.instructions} onCommit={(instructions) => onSave({ instructions })} />
      </Field>
    </div>
  );
}

export function InstructionsSection({ bot }: { bot: Bot }) {
  const update = useUpdateBot();
  const [preview, setPreview] = useState(false);
  const bytes = utf8Bytes(bot.soul);
  const savePlaybook = (id: string, patch: Partial<Playbook>) => void update(bot.id, (current) => ({ ...current, playbooks: current.playbooks.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }));
  return (
    <>
      <Section
        title="Standing instructions"
        info="How the bot works, every chat. They come right after its persona in the system prompt."
        actions={
          <Button small icon="eye" onClick={() => setPreview(true)}>
            Preview prompt
          </Button>
        }
      >
        <CommitInput
          multiline
          rows={12}
          value={bot.soul}
          placeholder="You are a capable, plain-spoken assistant…"
          onCommit={(soul) => {
            if (utf8Bytes(soul) <= SOUL_MAX_BYTES) void update(bot.id, { soul });
          }}
        />
        <div className={bytes > SOUL_MAX_BYTES ? "error-text" : "hint"}>
          {(bytes / 1000).toFixed(1)} KB of {SOUL_MAX_BYTES / 1000} KB
        </div>
      </Section>
      <Section
        title="Playbooks"
        info="Process guidance that joins a chat only when one of its trigger words appears in the first message."
        actions={
          <Button small icon="plus" onClick={() => void update(bot.id, (current) => ({ ...current, playbooks: [...current.playbooks, { id: newPlaybookId(), name: "New playbook", triggers: [], instructions: "" }] }))}>
            Add
          </Button>
        }
      >
        {bot.playbooks.length === 0 ? <div className="hint">No playbooks.</div> : null}
        {bot.playbooks.map((playbook) => (
          <PlaybookEditor key={playbook.id} playbook={playbook} onSave={(patch) => savePlaybook(playbook.id, patch)} onDelete={() => void update(bot.id, (current) => ({ ...current, playbooks: current.playbooks.filter((entry) => entry.id !== playbook.id) }))} />
        ))}
      </Section>
      {preview ? <PromptPreview bot={bot} onClose={() => setPreview(false)} /> : null}
    </>
  );
}
