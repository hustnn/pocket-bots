import { useId, useState } from "react";
import { ABSOLUTE_PATH } from "../../shared/folder-path";
import { Icon } from "../components/icons";
import { Button, Field, Menu, Modal, type MenuItems } from "../components/ui";
import { useWorkspaces } from "../lib/data";

export { ABSOLUTE_PATH };

/** A folder's last part, for a short label. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * A folder path typed with suggestions from the folders bots, groups and chats already work in.
 * Empty means the default the hint describes.
 */
export function FolderInput({ value, onChange, placeholder = "/Users/me/projects/site", autoFocus }: { value: string; onChange: (next: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const list = useId();
  const workspaces = useWorkspaces();
  return (
    <>
      <input className="input mono" list={list} value={value} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      <datalist id={list}>
        {(workspaces.data ?? []).map((workspace) => (
          <option key={workspace.id} value={workspace.directory} />
        ))}
      </datalist>
    </>
  );
}

/** A problem with a typed folder the server would refuse anyway, or null. */
export function folderProblem(path: string): string | null {
  return path.trim() && !ABSOLUTE_PATH.test(path.trim()) ? "Use an absolute path, like /Users/me/projects/site." : null;
}

function OtherFolderDialog({ initial, onClose, onPick }: { initial: string; onClose: () => void; onPick: (folder: string) => void }) {
  const [path, setPath] = useState(initial);
  const problem = folderProblem(path);
  const pick = () => {
    if (!path.trim() || problem) return;
    onPick(path.trim());
  };
  return (
    <Modal
      title="Folder for this chat"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!path.trim() || !!problem} onClick={pick}>
            Use folder
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          pick();
        }}
      >
        <Field label="Folder on this computer" hint="The chat's agent starts here, like a repo you're working on. The bot's memory and skills stay in its own folder." error={problem}>
          <FolderInput value={path} onChange={setPath} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * The folder a new chat will work in: the bot's own (null), or one picked from the folders in
 * use or typed. Sits in the composer's bar.
 */
export function NewChatFolder({ value, onChange, botFolder }: { value: string | null; onChange: (folder: string | null) => void; botFolder: string | null }) {
  const workspaces = useWorkspaces();
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [typing, setTyping] = useState(false);
  const entries: MenuItems = [
    { label: "The bot's folder", icon: value === null ? "check" : "folder", trailing: botFolder ? folderName(botFolder) : "managed", onSelect: () => onChange(null) },
    ...(workspaces.data ?? [])
      .filter((workspace) => workspace.directory !== botFolder)
      .slice(0, 12)
      .map((workspace) => ({ label: workspace.directory, icon: workspace.directory === value ? ("check" as const) : ("folder" as const), onSelect: () => onChange(workspace.directory) })),
    "divider",
    { label: "Other folder…", icon: "edit", onSelect: () => setTyping(true) },
  ];
  return (
    <>
      <button
        type="button"
        className={`btn small ghost folder-chip${value ? " on" : ""}`}
        title={value ? `This chat will work in ${value}` : `This chat will work in the bot's folder${botFolder ? ` (${botFolder})` : ""}. Click to pick another one.`}
        onClick={(event) => setMenu((event.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <Icon name="folder" size={13} />
        <span className="truncate">{value ? folderName(value) : "Bot's folder"}</span>
      </button>
      {menu ? <Menu anchor={menu} entries={entries} align="start" onClose={() => setMenu(null)} /> : null}
      {typing ? (
        <OtherFolderDialog
          initial={value ?? ""}
          onClose={() => setTyping(false)}
          onPick={(folder) => {
            setTyping(false);
            onChange(folder);
          }}
        />
      ) : null}
    </>
  );
}

/** The folder a chat works in, shown in its composer's bar; `managed`: the bot's folder in the data directory. */
export function ChatFolder({ cwd, managed }: { cwd: string; managed: boolean }) {
  return (
    <span className="folder-chip hint" title={`This chat works in ${cwd}`}>
      <Icon name="folder" size={13} />
      <span className="truncate">{managed ? "Bot's folder" : folderName(cwd)}</span>
    </span>
  );
}
