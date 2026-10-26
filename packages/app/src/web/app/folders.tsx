import { useId, useState } from "react";
import { Icon } from "../components/icons";
import { MAX_EXTRA_FOLDERS } from "../../shared/extra-folders";
import { Button, Field, Menu, Modal, type MenuItems } from "../components/ui";
import { useProviders, useWorkspaces } from "../lib/data";

/** An absolute path: /…, ~/…, C:\… or a \\share. */
export const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/;

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

function OtherFolderDialog({ initial, onClose, onPick, title = "Folder for this chat", hint = "The chat's agent starts here, like a repo you're working on. The bot's memory and skills stay in its own folder." }: { initial: string; onClose: () => void; onPick: (folder: string) => void; title?: string; hint?: string }) {
  const [path, setPath] = useState(initial);
  const problem = folderProblem(path);
  const pick = () => {
    if (!path.trim() || problem) return;
    onPick(path.trim());
  };
  return (
    <Modal
      title={title}
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
        <Field label="Folder on this computer" hint={hint} error={problem}>
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

/**
 * The folders a chat or a group may use besides its working folder, as chips with a remove button
 * and a "+" that adds one from the folders in use or a typed path. Without `onChange` they are
 * shown only (a group seat's, which belong to its group). `onChange` gets the whole new list.
 */
export function ExtraFolders({ folders, exclude = [], onChange, subject = "chat" }: { folders: readonly string[]; exclude?: readonly string[]; onChange?: (next: string[]) => void; subject?: "chat" | "group" | "team" }) {
  const whose = subject === "team" ? "The team's bots" : subject === "group" ? "The group's bots" : "This chat";
  const workspaces = useWorkspaces();
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [typing, setTyping] = useState(false);
  const add = (folder: string) => {
    if (!onChange || folders.includes(folder)) return;
    onChange([...folders, folder]);
  };
  const full = folders.length >= MAX_EXTRA_FOLDERS;
  const entries: MenuItems = [
    ...(workspaces.data ?? [])
      .filter((workspace) => !folders.includes(workspace.directory) && !exclude.includes(workspace.directory))
      .slice(0, 12)
      .map((workspace) => ({ label: workspace.directory, icon: "folder" as const, onSelect: () => add(workspace.directory) })),
    "divider",
    { label: "Other folder…", icon: "edit", onSelect: () => setTyping(true) },
  ];
  return (
    <>
      {folders.map((folder) => (
        <span key={folder} className="folder-chip hint extra" title={`${whose} can also use ${folder}`}>
          <Icon name="folder" size={13} />
          <span className="truncate">{folderName(folder)}</span>
          {onChange ? (
            <button type="button" className="folder-remove" title={`Stop using ${folder}`} aria-label={`Remove ${folderName(folder)}`} onClick={() => onChange(folders.filter((entry) => entry !== folder))}>
              <Icon name="x" size={11} />
            </button>
          ) : null}
        </span>
      ))}
      {onChange ? (
        <>
          <button
            type="button"
            className="btn small ghost folder-chip"
            disabled={full}
            title={full ? `At most ${MAX_EXTRA_FOLDERS} extra folders.` : `Add a folder ${whose.toLowerCase()} can use besides the working folder`}
            onClick={(event) => setMenu((event.currentTarget as HTMLElement).getBoundingClientRect())}
          >
            <Icon name="plus" size={13} />
            {folders.length === 0 ? <span className="truncate">Add folder</span> : null}
          </button>
          {menu ? <Menu anchor={menu} entries={entries} align="start" onClose={() => setMenu(null)} /> : null}
          {typing ? (
            <OtherFolderDialog
              initial=""
              title={subject === "team" ? "Extra folder for this team" : subject === "group" ? "Extra folder for this group" : "Extra folder for this chat"}
              hint={`${subject === "team" ? "Every bot in the team" : subject === "group" ? "Every bot in the group" : "The chat's agent"} can use this folder besides the working folder. Actions there may still ask for approval.`}
              onClose={() => setTyping(false)}
              onPick={(folder) => {
                setTyping(false);
                add(folder);
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** True when one of these providers' CLI doesn't take extra folders natively: its agent reaches them by path. */
export function useReachesFoldersByPath(providers: readonly (string | undefined)[]): boolean {
  const entries = useProviders().data?.entries ?? [];
  return providers.some((provider) => entries.some((entry) => entry.provider === provider && !entry.additionalDirectories));
}

/** The note under a chat's extra folders on a CLI that reaches them by path. */
export const PATH_ACCESS_NOTE = "This CLI reaches these folders by path, so actions there may need your approval.";

/** The folder a chat works in, shown in its composer's bar; `managed`: the bot's folder in the data directory. */
export function ChatFolder({ cwd, managed }: { cwd: string; managed: boolean }) {
  return (
    <span className="folder-chip hint" title={`This chat works in ${cwd}`}>
      <Icon name="folder" size={13} />
      <span className="truncate">{managed ? "Bot's folder" : folderName(cwd)}</span>
    </span>
  );
}
