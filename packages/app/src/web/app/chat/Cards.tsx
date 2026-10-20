import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatSnapshot } from "../../../shared/chat-types";
import type { AppSignIn } from "../../../shared/apps";
import type { Bot } from "../../../shared/bot";
import { botToolName } from "../../../shared/bot-tools";
import { changeTexts, changeWarnings, describeChange } from "../../../shared/changes";
import { folderChoices, shellCommand } from "../../../shared/commands";
import type { Proposal } from "../../../shared/proposals";
import { describeSchedule, upcomingRuns } from "../../../shared/routines";
import { appsAccountsRpc, appsCatalogRpc, chatRespondRpc, chatSendRpc, commandAllowRpc, folderAllowRpc, proposalAcceptRpc, proposalDismissRpc, proposalGetRpc, type RoutineRunCard as RunCard } from "../../../shared/rpc";
import { scanSkillText, skillBody } from "../../../shared/skills";
import { relativeTime } from "../../../shared/time";
import { humanizeToolName, type ToolCallDetail } from "../../../shared/tools";
import { Icon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button, Menu, useFeedback } from "../../components/ui";
import { errorText, rpc } from "../../lib/api";
import { keys, useCommit, useStoreDoc } from "../../lib/data";
import { navigate } from "../../lib/router";
import { areQuestionsAnswered, buildQuestionFormAnswers, parseQuestionFormQuestions, questionShowsTextInput, resolveDismissLabel, shouldSubmitEmptyOnDismiss, type QuestionOtherTexts, type QuestionSelections } from "../../chat/question";
import { ToolDetails } from "./ToolDetails";

type Permission = ChatSnapshot["pendingPermissions"][number];
type Action = NonNullable<Permission["actions"]>[number];
type Response = Parameters<typeof rpc<typeof chatRespondRpc>>[1]["response"];

function Card({ icon, title, badge, children, footer }: { icon: Parameters<typeof Icon>[0]["name"]; title: ReactNode; badge?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="chat-card">
      <div className="head">
        <Icon name={icon} size={15} />
        <span className="truncate" style={{ flex: 1 }}>
          {title}
        </span>
        {badge}
      </div>
      {children ? <div className="body">{children}</div> : null}
      {footer ? <div className="foot">{footer}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- permissions

function permissionTitle(permission: Permission): string {
  if (permission.title) return permission.title;
  const bot = permission.input?.bot;
  if (botToolName(permission.name) === "ask_bot" && typeof bot === "string" && bot.trim()) return `Ask ${bot.trim()}`;
  return permission.name ? humanizeToolName(permission.name) : "Permission required";
}

/** A permission request card: tool, plan and question requests. */
export function PermissionCard({ chatId, permission, botId, cwd, extraFolders = [] }: { chatId: string; permission: Permission; botId: string; cwd: string | null; extraFolders?: readonly string[] }) {
  const feedback = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setBusy(null), [permission.id]);
  const isPlan = permission.kind === "plan";
  const shell = cwd && permission.kind === "tool" ? shellCommand(permission, cwd) : null;
  const folders = cwd ? folderChoices(permission, cwd, extraFolders) : [];
  const folderButton = useRef<HTMLSpanElement>(null);
  const [folderMenu, setFolderMenu] = useState<DOMRect | null>(null);

  const respond = async (key: string, response: Response) => {
    setBusy(key);
    try {
      await rpc(chatRespondRpc, { chatId, requestId: permission.id, response });
    } catch (error) {
      setBusy(null);
      feedback.error(`Couldn't answer: ${errorText(error)}`);
    }
  };

  if (permission.kind === "question") return <QuestionForm input={permission.input} busy={busy !== null} onRespond={(response) => void respond("question", response)} />;

  const actions: Action[] = permission.actions?.length
    ? permission.actions
    : [
        { id: "reject", label: "Deny", behavior: "deny", variant: "danger", intent: "dismiss" },
        { id: "accept", label: isPlan ? "Implement" : "Accept", behavior: "allow", variant: "primary" },
      ];
  const planText = typeof permission.metadata?.planText === "string" ? permission.metadata.planText : typeof permission.input?.plan === "string" ? permission.input.plan : null;
  const detail = (permission.detail ?? { type: "unknown", input: permission.input ?? null, output: null }) as ToolCallDetail;

  const always = async () => {
    if (!shell) return;
    setBusy("always");
    try {
      await rpc(commandAllowRpc, { botId, command: shell.command, cwd: shell.cwd });
    } catch (error) {
      setBusy(null);
      feedback.error(`Couldn't save the command: ${errorText(error)}`);
      return;
    }
    await respond("always", { behavior: "allow" });
  };

  // Trusting a folder answers this request and every other one waiting that stays inside it.
  const trust = async (folder: string) => {
    setBusy("folder");
    try {
      await rpc(folderAllowRpc, { botId, folder });
    } catch (error) {
      setBusy(null);
      feedback.error(`Couldn't trust the folder: ${errorText(error)}`);
      return;
    }
    await respond("folder", { behavior: "allow" });
  };

  return (
    <Card
      icon={isPlan ? "list" : "shield"}
      title={isPlan ? "Plan" : permissionTitle(permission)}
      badge={<span className="badge warning">Waiting for you</span>}
      footer={
        <>
          {actions.map((action) => (
            <Button
              key={action.id}
              small
              variant={action.variant === "primary" ? "primary" : undefined}
              icon={action.behavior === "allow" ? "check" : "x"}
              busy={busy === action.id}
              disabled={busy !== null}
              onClick={() => void respond(action.id, action.behavior === "allow" ? { behavior: "allow", selectedActionId: action.id } : { behavior: "deny", selectedActionId: action.id, message: "Denied by user" })}
            >
              {action.label}
            </Button>
          ))}
          {shell ? (
            <Button small icon="checks" busy={busy === "always"} disabled={busy !== null} onClick={() => void always()} title="Run this exact command in this folder without asking again">
              Always allow
            </Button>
          ) : null}
          {folders.length ? (
            <span ref={folderButton}>
              <Button
                small
                icon="folder"
                busy={busy === "folder"}
                disabled={busy !== null}
                onClick={() => setFolderMenu(folderButton.current?.getBoundingClientRect() ?? null)}
                title="Allow this, and from now on run commands and read, edit and write files in a folder without asking"
              >
                Allow in folder…
              </Button>
            </span>
          ) : null}
          {folderMenu ? (
            <Menu
              anchor={folderMenu}
              align="start"
              entries={folders.map((folder) => ({ label: folder, icon: "folder" as const, onSelect: () => void trust(folder) }))}
              onClose={() => setFolderMenu(null)}
            />
          ) : null}
        </>
      }
    >
      {permission.description ? <p style={{ margin: "0 0 8px" }} className="muted">{permission.description}</p> : null}
      {planText ? <Markdown text={planText} /> : !isPlan ? <ToolDetails detail={detail} /> : null}
    </Card>
  );
}

/** A question an agent asks the user (its seat's approval; in a group, the bot's question there). */
export function QuestionForm({ input, busy, onRespond }: { input: Permission["input"]; busy: boolean; onRespond: (response: Response) => void }) {
  // Several forms can be on one page (a group's questions): each keeps its own radio groups.
  const formId = useId();
  const questions = useMemo(() => parseQuestionFormQuestions(input), [input]);
  const [selections, setSelections] = useState<QuestionSelections>({});
  const [others, setOthers] = useState<QuestionOtherTexts>({});
  if (!questions) {
    return (
      <Card icon="info" title="Question" footer={<Button small onClick={() => onRespond({ behavior: "deny", message: "Dismissed by user" })}>Dismiss</Button>}>
        <pre className="pre-box">{JSON.stringify(input, null, 2)}</pre>
      </Card>
    );
  }
  const answers = () => ({ ...(input ?? {}), answers: buildQuestionFormAnswers(questions, selections, others) });
  const toggle = (index: number, option: number, multi: boolean) => {
    const next = new Set(multi ? (selections[index] ?? []) : []);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    setSelections({ ...selections, [index]: next });
    if (!multi && others[index]) setOthers({ ...others, [index]: "" });
  };
  return (
    <Card
      icon="info"
      title={questions.length === 1 ? questions[0]!.header : "Questions"}
      badge={<span className="badge warning">Waiting for you</span>}
      footer={
        <>
          <Button small disabled={busy} onClick={() => onRespond(shouldSubmitEmptyOnDismiss(questions) ? { behavior: "allow", updatedInput: answers() } : { behavior: "deny", message: "Dismissed by user" })}>
            {resolveDismissLabel(questions)}
          </Button>
          <Button small variant="primary" icon="check" busy={busy} disabled={!areQuestionsAnswered(questions, selections, others)} onClick={() => onRespond({ behavior: "allow", updatedInput: answers() })}>
            Submit
          </Button>
        </>
      }
    >
      <div className="stack">
        {questions.map((question, index) => (
          <div key={index} className="stack" style={{ gap: 6 }}>
            <strong>{question.question}</strong>
            {question.options.map((option, optionIndex) => {
              const checked = selections[index]?.has(optionIndex) ?? false;
              return (
                <label key={optionIndex} className="row" style={{ alignItems: "flex-start", cursor: "pointer" }}>
                  <input type={question.multiSelect ? "checkbox" : "radio"} checked={checked} name={`${formId}-q${index}`} onChange={() => toggle(index, optionIndex, question.multiSelect)} style={{ marginTop: 4 }} />
                  <span>
                    {option.label}
                    {option.description ? <span className="hint"> — {option.description}</span> : null}
                  </span>
                </label>
              );
            })}
            {questionShowsTextInput(question) ? (
              <input
                className="input"
                placeholder={question.placeholder ?? (question.options.length ? "Something else…" : "Your answer")}
                value={others[index] ?? ""}
                onChange={(event) => {
                  setOthers({ ...others, [index]: event.target.value });
                  if (!question.multiSelect && event.target.value) setSelections({ ...selections, [index]: new Set() });
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- proposals

interface ProposalView {
  titles: Record<Proposal["status"], string>;
  description: string;
  text: string;
  warnings: string[];
  notes: string[];
  action: string;
}

function skillView(proposal: Extract<Proposal, { kind: "skill" }>, bot: Bot | undefined, exists: boolean): ProposalView {
  const { name, description, text } = proposal.data;
  return {
    titles: { pending: `${exists ? "Updated" : "New"} skill: ${name}`, accepted: `Saved skill: ${name}`, dismissed: `Dismissed skill: ${name}` },
    description,
    text: skillBody(text),
    warnings: scanSkillText(text),
    notes: [`${exists ? `Replace ${name} in Skills & Tools` : "Save it to Skills & Tools"}${bot ? ` and turn it on for ${bot.name}?` : "?"}`],
    action: exists ? "Update skill" : "Save skill",
  };
}

function routineView(proposal: Extract<Proposal, { kind: "routine" }>, bot: Bot | undefined): ProposalView {
  const { name, prompt, schedule } = proposal.data;
  const now = new Date();
  const next = upcomingRuns(schedule, now, now, 3);
  const timing =
    schedule.kind === "webhook"
      ? "It runs when its webhook is called. Copy the URL from the routine's settings."
      : next.length
        ? `Next ${next.length === 1 ? "run" : `${next.length} runs`}: ${next.map((at) => at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join(" · ")}`
        : "It has no upcoming runs.";
  return {
    titles: { pending: `New routine: ${name}`, accepted: `Scheduled routine: ${name}`, dismissed: `Dismissed routine: ${name}` },
    description: describeSchedule(schedule),
    text: prompt,
    warnings: [],
    notes: [timing, `Each run starts a new chat${bot ? ` with ${bot.name}` : ""} and posts its result here.`],
    action: "Create routine",
  };
}

/** Text as a Markdown quote, so instructions read as what the bot will be told. */
const quote = (text: string) => (text ? text.split("\n").map((line) => `> ${line}`).join("\n") : "> *(empty)*");

function changesView(proposal: Extract<Proposal, { kind: "changes" }>): ProposalView {
  const { summary, changes } = proposal.data;
  const count = changes.length === 1 ? "the change" : `all ${changes.length} changes`;
  return {
    titles: { pending: "Setup changes", accepted: "Applied setup changes", dismissed: "Dismissed setup changes" },
    description: summary,
    text: [changes.map((change) => `- ${describeChange(change)}`).join("\n"), ...changes.flatMap(changeTexts).map((entry) => `**${entry.title}**\n\n${quote(entry.text)}`)].join("\n\n"),
    warnings: changeWarnings(changes),
    notes: [`Apply ${count}? A bot's earlier settings stay under History in its settings.`],
    action: "Apply changes",
  };
}

/** A skill, routine or setup change a bot proposed with a propose_* tool; saved only when the user accepts it. */
export function ProposalCard({ proposalId }: { proposalId: string }) {
  const feedback = useFeedback();
  const client = useQueryClient();
  const doc = useStoreDoc();
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  const query = useQuery({ queryKey: ["proposal", proposalId], queryFn: () => rpc(proposalGetRpc, { id: proposalId }) });
  const proposal = query.data?.proposal;
  if (query.isPending) return null;
  if (!proposal) return <p className="muted small">{query.isError ? `Couldn't load the proposal: ${errorText(query.error)}` : "This proposal is no longer available."}</p>;
  const values = doc.data?.values;
  const bot = values?.bots.find((entry) => entry.id === proposal.botId);
  const view =
    proposal.kind === "skill"
      ? skillView(proposal, bot, !!values?.library?.skills.some((skill) => skill.id === proposal.data.name))
      : proposal.kind === "routine"
        ? routineView(proposal, bot)
        : changesView(proposal);
  const act = async (kind: "save" | "dismiss") => {
    setBusy(kind);
    try {
      const result = kind === "save" ? await rpc(proposalAcceptRpc, { id: proposal.id }) : await rpc(proposalDismissRpc, { id: proposal.id });
      client.setQueryData(["proposal", proposalId], { proposal: result.proposal });
      if (kind === "save") void client.invalidateQueries({ queryKey: keys.store });
    } catch (error) {
      feedback.error(`Couldn't ${kind === "save" ? "save" : "dismiss"} it: ${errorText(error)}`);
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };
  const status = proposal.status;
  return (
    <Card
      icon={proposal.kind === "skill" ? "sparkles" : proposal.kind === "routine" ? "calendar" : "settings"}
      title={view.titles[status]}
      badge={status === "pending" ? <span className="badge accent">Proposal</span> : status === "accepted" ? <span className="badge success">Saved</span> : <span className="badge">Dismissed</span>}
      footer={
        status === "pending" ? (
          <>
            <Button small icon="x" busy={busy === "dismiss"} disabled={busy !== null} onClick={() => void act("dismiss")}>
              Dismiss
            </Button>
            <Button small variant="primary" icon="check" busy={busy === "save"} disabled={busy !== null} onClick={() => void act("save")}>
              {view.action}
            </Button>
          </>
        ) : undefined
      }
    >
      {view.description ? <p style={{ margin: "0 0 8px" }} className="muted">{view.description}</p> : null}
      <div style={{ maxHeight: 320, overflow: "auto" }}>
        <Markdown text={view.text} />
      </div>
      {status === "pending" ? (
        <div className="stack" style={{ gap: 4, marginTop: 10 }}>
          {view.warnings.length ? (
            <div className="notice warning">
              <strong>Check these first</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {view.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.notes.map((note) => (
            <div key={note} className="hint">
              {note}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- connected apps

/** Composio's sign-in links expire ten minutes after the bot asks for them. */
const LINK_TTL_MS = 10 * 60_000;

/** A sign-in a bot started with COMPOSIO_MANAGE_CONNECTIONS: open Composio's page, wait, then Continue tells the bot. */
export function ConnectCard({ signIn, since, chatId, botId }: { signIn: AppSignIn; since: number; chatId: string; botId: string }) {
  const feedback = useFeedback();
  const commit = useCommit();
  const doc = useStoreDoc();
  const [phase, setPhase] = useState<"idle" | "waiting" | "connected" | "continued">("idle");
  const accounts = useQuery({ queryKey: ["apps", "accounts", "fresh"], queryFn: () => rpc(appsAccountsRpc, { fresh: true }), refetchInterval: phase === "waiting" ? 4000 : false });
  const catalog = useQuery({ queryKey: ["apps", "catalog"], queryFn: () => rpc(appsCatalogRpc, {}), staleTime: 3_600_000 });
  const app = catalog.data?.apps.find((entry) => entry.slug === signIn.slug) ?? { name: signIn.slug };
  const tracked = !!(signIn.wordId || signIn.alias);
  const connected = !!accounts.data?.accounts.some((account) => account.slug === signIn.slug && account.status === "connected" && (signIn.wordId ? account.wordId === signIn.wordId : account.alias === signIn.alias));
  const bot = doc.data?.values.bots.find((entry) => entry.id === botId);
  const expired = !connected && phase === "idle" && Date.now() - since > LINK_TTL_MS;
  useEffect(() => {
    if (phase === "waiting" && connected) setPhase("connected");
  }, [phase, connected]);
  const open = async () => {
    try {
      if (bot && !bot.apps.includes(signIn.slug)) await commit((current) => ({ ...current, bots: current.bots.map((entry) => (entry.id === bot.id ? { ...entry, apps: [...entry.apps, signIn.slug] } : entry)) }));
      window.open(signIn.url, "_blank", "noopener");
      setPhase(tracked ? "waiting" : "connected");
    } catch (error) {
      feedback.error(errorText(error));
    }
  };
  const carryOn = async () => {
    try {
      await rpc(chatSendRpc, { chatId, text: `${app.name} is connected. Please continue.` });
      setPhase("continued");
    } catch (error) {
      feedback.error(`Couldn't send it: ${errorText(error)}`);
    }
  };
  const done = connected || phase === "connected" || phase === "continued";
  const who = bot?.name ?? "The bot";
  const note = done
    ? null
    : expired
      ? `The sign-in link has expired. Ask ${who} for a new one.`
      : phase === "waiting"
        ? "Finish signing in in your browser. This card updates when it's done."
        : `${who} asked to connect ${app.name}${signIn.alias ? ` as "${signIn.alias}"` : ""}. You sign in on Composio's page.`;
  return (
    <Card
      icon="plug"
      title={done ? `${app.name} connected` : `Connect ${app.name}`}
      badge={done ? <span className="badge success">Connected</span> : phase === "waiting" ? <span className="badge">Waiting</span> : expired ? <span className="badge">Expired</span> : undefined}
      footer={
        !done && !expired ? (
          <Button small variant={phase === "idle" ? "primary" : undefined} icon="external" onClick={() => void open()}>
            {phase === "waiting" ? "Open the page again" : "Sign in"}
          </Button>
        ) : phase === "connected" ? (
          <Button small variant="primary" icon="check" onClick={() => void carryOn()}>
            Continue
          </Button>
        ) : undefined
      }
    >
      {note}
    </Card>
  );
}

// ---------------------------------------------------------------- routine runs

const RUN_STATUS: Record<RunCard["status"], { label: string; tone: string }> = {
  running: { label: "Running", tone: "" },
  succeeded: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  "skipped-busy": { label: "Skipped", tone: "" },
  "skipped-missed": { label: "Missed", tone: "warning" },
};
const TRIGGER: Record<RunCard["trigger"], string> = { schedule: "on schedule", manual: "run by you", webhook: "from its webhook" };

/** A routine run's result in the chat the routine reports to. */
export function RoutineRunCard({ card, botId }: { card: RunCard; botId: string }) {
  const status = RUN_STATUS[card.status];
  return (
    <Card
      icon="calendar"
      title={card.routineName}
      badge={<span className={`badge ${status.tone}`}>{status.label}</span>}
      footer={
        card.agentId ? (
          <Button small icon="chevronRight" onClick={() => navigate({ page: "bot", botId, chatId: card.agentId })}>
            Open the run's chat
          </Button>
        ) : undefined
      }
    >
      <div className="hint">{`${new Date(card.scheduledFor).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${TRIGGER[card.trigger]} · ${relativeTime(card.scheduledFor)}`}</div>
      {card.output || card.error ? <p style={{ margin: "6px 0 0", color: card.error ? "var(--danger)" : undefined, whiteSpace: "pre-wrap" }}>{card.error ?? card.output}</p> : null}
    </Card>
  );
}
