import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EMPTY_LIBRARY, type LibrarySkill } from "../../../shared/bot";
import { forgetItem, matchesQuery, setBotUses, updateSkill, upsertSkills } from "../../../shared/library";
import { skillDeleteRpc, skillImportRpc, skillReadRpc, skillWriteRpc } from "../../../shared/rpc";
import { sanitizeSkillName, scanSkillText, skillMarkdown } from "../../../shared/skills";
import { Avatar } from "../../components/Avatar";
import { Button, Field, Modal, Toggle, useAction, useFeedback } from "../../components/ui";
import { rpc } from "../../lib/api";
import { useCommit, useStoreDoc } from "../../lib/data";

function ImportDialog({ onClose }: { onClose: () => void }) {
  const commit = useCommit();
  const feedback = useFeedback();
  const [source, setSource] = useState("");
  const { busy, run } = useAction();
  return (
    <Modal
      title="Import skills from GitHub"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          busy={busy === "import"}
          disabled={!source.trim()}
          onClick={() =>
            void run("import", async () => {
              const { skills } = await rpc(skillImportRpc, { source: source.trim() });
              await commit((values) => ({ ...values, library: upsertSkills(values.library ?? EMPTY_LIBRARY, skills) }));
              feedback.toast(`Imported ${skills.length} skill${skills.length === 1 ? "" : "s"}. Review each before bots use it.`);
              onClose();
            })
          }
        >
          Import
        </Button>
      }
    >
      <Field label="Source" hint='"owner/repo", "owner/repo/path/to/skill", a GitHub folder URL, or a link to a SKILL.md.'>
        <input className="input" autoFocus value={source} placeholder="anthropics/skills/skills/pdf" onChange={(event) => setSource(event.target.value)} />
      </Field>
    </Modal>
  );
}

function NewSkillDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const commit = useCommit();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const { busy, run } = useAction();
  const id = sanitizeSkillName(name);
  return (
    <Modal
      title="New skill"
      wide
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          busy={busy === "save"}
          disabled={!name.trim() || !description.trim()}
          onClick={() =>
            void run("save", async () => {
              const saved = await rpc(skillWriteRpc, { id, text: skillMarkdown(id, description, body) });
              await commit((values) => ({ ...values, library: upsertSkills(values.library ?? EMPTY_LIBRARY, [{ id, description: saved.description, source: "", reviewedSha: saved.sha }]) }));
              onCreated(id);
            })
          }
        >
          Save
        </Button>
      }
    >
      <div className="stack">
        <Field label="Name" hint={name ? `Saved as ${id}` : "Short, lowercase and dashed."}>
          <input className="input" value={name} placeholder="weekly-report" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="When to use it" hint="One line. Bots decide from this line whether to read the skill.">
          <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label="Instructions (Markdown)">
          <textarea className="textarea mono" rows={14} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function SkillDetail({ skill }: { skill: LibrarySkill }) {
  const doc = useStoreDoc();
  const commit = useCommit();
  const client = useQueryClient();
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const file = useQuery({ queryKey: ["skill", skill.id], queryFn: () => rpc(skillReadRpc, { id: skill.id }) });
  const [editing, setEditing] = useState<string | null>(null);
  const bots = (doc.data?.values.bots ?? []).filter((bot) => !bot.archived);
  const sha = file.data?.sha ?? null;
  const needsReview = skill.reviewedSha === null || (typeof skill.reviewedSha === "string" && sha !== null && sha !== skill.reviewedSha);
  const warnings = file.data ? scanSkillText(file.data.text) : [];
  const patch = (change: Partial<LibrarySkill>) => commit((values) => ({ ...values, library: updateSkill(values.library ?? EMPTY_LIBRARY, skill.id, change) }));

  return (
    <div className="stack">
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }} className="mono">
          {skill.id}
        </h2>
        <Toggle on={skill.enabled} disabled={needsReview} label="Enabled" onChange={(enabled) => void patch({ enabled })} />
      </div>
      {skill.description ? <p className="muted" style={{ margin: 0 }}>{skill.description}</p> : null}
      {skill.source ? <div className="hint mono">From {skill.source}</div> : null}
      {needsReview ? (
        <div className="notice warning">
          {skill.reviewedSha === null ? "Read it before bots get it: skills are instructions your bots follow." : "It changed since you reviewed it. Bots don't get it until you review it again."}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="notice warning">
          <strong>Worth a second look</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {editing !== null ? (
        <>
          <textarea className="textarea mono" rows={20} value={editing} onChange={(event) => setEditing(event.target.value)} />
          <div className="row">
            <Button
              variant="primary"
              busy={busy === "save"}
              onClick={() =>
                void run("save", async () => {
                  const saved = await rpc(skillWriteRpc, { id: skill.id, text: editing });
                  // You wrote it, so it counts as reviewed.
                  await patch({ description: saved.description, reviewedSha: saved.sha });
                  await client.invalidateQueries({ queryKey: ["skill", skill.id] });
                  setEditing(null);
                })
              }
            >
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <pre className="pre-box" style={{ maxHeight: 420 }}>
            {file.isPending ? "Loading…" : file.data?.missing ? "SKILL.md is missing." : file.data?.text}
          </pre>
          {file.data && file.data.files.length > 1 ? <div className="hint">Other files: {file.data.files.filter((name) => name !== "SKILL.md").join(", ")}</div> : null}
          <div className="row wrap">
            {needsReview && sha ? (
              <Button variant="primary" icon="check" onClick={() => void run("review", () => patch({ enabled: true, reviewedSha: sha }), "Reviewed and turned on")}>
                Mark reviewed and turn on
              </Button>
            ) : null}
            <Button icon="edit" disabled={!file.data} onClick={() => setEditing(file.data?.text ?? "")}>
              Edit
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (!(await feedback.confirm({ title: `Delete ${skill.id}?`, body: "Its files are removed and no bot gets it any more.", action: "Delete", danger: true }))) return;
                await run("delete", async () => {
                  await rpc(skillDeleteRpc, { id: skill.id });
                  await commit((values) => ({ ...values, library: { ...(values.library ?? EMPTY_LIBRARY), skills: (values.library ?? EMPTY_LIBRARY).skills.filter((entry) => entry.id !== skill.id) }, bots: forgetItem(values.bots, "skill", skill.id) }));
                });
              }}
            >
              Delete
            </Button>
          </div>
        </>
      )}
      <div className="field-label" style={{ marginTop: 8 }}>
        Bots using it
      </div>
      <div>
        {bots.map((bot) => (
          <div key={bot.id} className="check-row" style={{ alignItems: "center" }}>
            <Avatar avatar={bot.avatar} size={24} />
            <span style={{ flex: 1 }}>{bot.name}</span>
            <Toggle on={bot.skillIds.includes(skill.id)} label={`${bot.name} uses ${skill.id}`} onChange={(on) => void commit((values) => ({ ...values, bots: values.bots.map((entry) => (entry.id === bot.id ? setBotUses(entry, "skill", skill.id, on) : entry)) }))} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkillsTab({ query }: { query: string }) {
  const doc = useStoreDoc();
  const skills = doc.data?.values.library?.skills ?? [];
  const shown = skills.filter((skill) => matchesQuery(query, skill.id, skill.description, skill.source));
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"import" | "new" | null>(null);
  const current = skills.find((skill) => skill.id === selected) ?? null;
  return (
    <div className="stack">
      <div className="row">
        <p className="hint" style={{ margin: 0, flex: 1 }}>
          Skills are folders with a SKILL.md that bots read before a task they cover. Each bot switches on the ones it uses.
        </p>
        <Button icon="download" onClick={() => setDialog("import")}>
          Import
        </Button>
        <Button icon="plus" onClick={() => setDialog("new")}>
          New skill
        </Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr)", gap: 20 }}>
        <div>
          {skills.length === 0 ? <div className="hint">No skills yet.</div> : shown.length === 0 ? <div className="hint">No skills match.</div> : null}
          {shown.map((skill) => (
            <div key={skill.id} className={`list-item${skill.id === selected ? " active" : ""}`} onClick={() => setSelected(skill.id)}>
              <span className="grow truncate mono small">{skill.id}</span>
              {skill.reviewedSha === null ? <span className="badge warning">Review</span> : !skill.enabled ? <span className="badge">Off</span> : null}
            </div>
          ))}
        </div>
        <div>{current ? <SkillDetail key={current.id} skill={current} /> : <div className="hint">Pick a skill.</div>}</div>
      </div>
      {dialog === "import" ? <ImportDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "new" ? (
        <NewSkillDialog
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            setSelected(id);
          }}
        />
      ) : null}
    </div>
  );
}
