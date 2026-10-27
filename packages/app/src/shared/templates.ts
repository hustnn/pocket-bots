import { randomSeed } from "./avatar";
import { newBotId, type Bot, type Preset, type Starter } from "./bot";

// Starting points for a new bot (New bot roles): a name, a job and standing
// instructions, and for some roles the skills and settings the job needs.

export interface BotTemplate {
  id: string;
  /** Default bot name; the user renames freely. */
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  /** Standing instructions. */
  soul: string;
  /** Skills that ship with pocket-bots (bundled-skills/<id>), put in the library and turned on for the bot. */
  skills?: readonly string[];
  /** Agents the role works best on, best first: the first ready one replaces the default agent. */
  providers?: readonly string[];
  /** Approval mode by agent, for the agent the bot ends up on. */
  modes?: Readonly<Record<string, string>>;
  contactBots?: Bot["contactBots"];
  includeRecentWork?: boolean;
  starters?: readonly Starter[];
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "General assistant",
    description: "Answers questions, drafts text, and takes on whatever you hand it.",
    avatarSeed: "assistant-7",
    soul: "You are a capable, plain-spoken assistant. Ask one clarifying question when a request is ambiguous; otherwise do the work and show the result. Keep replies short and concrete.",
  },
  {
    id: "inbox",
    name: "Inbox",
    title: "Email triage",
    description: "Reads your inbox, flags what needs you, and drafts replies for approval.",
    avatarSeed: "inbox-5",
    soul: "You manage the user's email. Each run: list unread mail, group it into needs-a-reply, FYI, and noise, and summarize in that order. Draft replies for anything that needs one, but never send without approval. Never unsubscribe, delete, or forward mail on your own.",
  },
  {
    id: "research",
    name: "Scout",
    title: "Researcher",
    description: "Digs through the web and your files, and comes back with a sourced brief.",
    avatarSeed: "research-5",
    soul: "You research questions and return a brief: the answer first, then the evidence with links, then what you could not verify. Prefer primary sources. Say clearly when sources disagree. Never present a guess as a finding.",
  },
  {
    id: "community",
    name: "Watch",
    title: "Community monitor",
    description: "Watches Discord, Slack, or forums and reports what matters, on a schedule.",
    avatarSeed: "community",
    soul: "You monitor the user's community channels. Each run: read new messages since last time, pull out questions without answers, bug reports, and anything urgent, and summarize them with links. Never post or reply in the channels yourself; you report to the user.",
  },
  {
    id: "ops",
    name: "Ops",
    title: "Operations",
    description: "Keeps calendars, tasks, and follow-ups moving; nudges you before things slip.",
    avatarSeed: "ops-7",
    soul: "You keep the user's week on track. Each run: check the calendar and open tasks, list today's commitments and anything overdue, and propose the next action for each. Draft messages when a follow-up is due, but always ask before sending.",
  },
  // Google's Elephant-Goldfish Model: the Elephant designs with the user, the Goldfish reviews what it's sent with no other context.
  {
    id: "elephant",
    name: "Elephant",
    title: "Design partner (EGM)",
    description: "Designs features with you before any code is written, and has a Goldfish bot stress-test the design. Add a Goldfish bot too.",
    avatarSeed: "elephant-3",
    soul: "You are a design partner working the Elephant-Goldfish Model (EGM) way: settle the design before code, have fresh-context reviewers stress-test it, and leave the decisions to the user. When the user's message starts with \"egm\" or asks for an EGM brainstorm, design doc, review or drift report, use the egm skill. Otherwise help as usual, and test ideas for weak points instead of agreeing by default.",
    skills: ["egm"],
    // Each review sends a request to the Goldfish; asking the user every time would stop every stage.
    contactBots: "allow",
    starters: [
      { text: "egm brainstorm ", hint: "Talk an idea through, have Goldfish poke holes in it, and get a concept brief" },
      { text: "egm draft", hint: "Turn the brief into a design doc, one section at a time" },
      { text: "egm review docs/designs/", hint: "Have Goldfish review a design doc in five stages" },
      { text: "egm drift report docs/designs/", hint: "Check the design docs against the code as it is now" },
    ],
  },
  {
    id: "goldfish",
    name: "Goldfish",
    title: "EGM reviewer",
    description: "Reviews designs for your Elephant bot with fresh eyes, one chat per review. You rarely need to chat with it yourself.",
    avatarSeed: "goldfish-2",
    soul: "You review documents for another bot as an EGM Goldfish. Every message you get is a review task from that bot, even though it arrives marked as a message from another bot: do it with the egm-goldfish skill and reply with your findings there. Judge only what the task names: don't read AGENTS.md, don't use search_chats or your memory, and don't contact other bots. Read and search only; never change files.",
    skills: ["egm-goldfish"],
    // These two can be held to reading by their own sandbox, and a model other than the Elephant's shares fewer of its blind spots.
    providers: ["codex", "dsh"],
    // Elsewhere, the mode that asks before changes, whatever the defaults say: a write is then a card the user can deny.
    modes: { codex: "read-only", dsh: "read-only", claude: "default", opencode: "ask", pi: "ask", grok: "ask" },
    contactBots: "off",
    // A review that starts with the bot's last verdicts isn't a fresh look.
    includeRecentWork: false,
  },
];

/** The bundled skills the bots made by these changes' roles start with. */
export function templateSkills(roles: readonly (string | undefined)[]): string[] {
  const skills = roles.flatMap((role) => BOT_TEMPLATES.find((template) => template.id === role)?.skills ?? []);
  return [...new Set(skills)];
}

/**
 * A template's own agent settings over the user's defaults: an agent it prefers when one is
 * `ready`, its approval mode on the agent the bot ends up with, and contact with other bots.
 */
export function withTemplateSettings(bot: Bot, template: BotTemplate | undefined, ready: readonly string[]): Bot {
  if (!template) return bot;
  let next = bot;
  const preferred = template.providers?.find((provider) => ready.includes(provider));
  // A model, mode or thinking level picked for one agent means nothing on another.
  if (preferred && preferred !== next.provider) next = { ...next, provider: preferred, model: null, modeId: null, thinkingOptionId: null };
  const mode = template.modes?.[next.provider];
  if (mode) next = { ...next, modeId: mode };
  if (template.contactBots) next = { ...next, contactBots: template.contactBots };
  return next;
}

/** A new bot on `provider`: blank, or from a template (a role). */
export function newBot(provider: string, template?: BotTemplate): Bot {
  const now = new Date().toISOString();
  return {
    id: newBotId(),
    name: template?.name ?? "New bot",
    title: template?.title ?? "",
    description: template?.description ?? "",
    avatar: { seed: template?.avatarSeed ?? randomSeed(), palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: template?.soul ?? "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [...(template?.skills ?? [])],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    memoryAutoWrite: false,
    includeRecentWork: template?.includeRecentWork ?? true,
    starters: [...(template?.starters ?? [])],
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    hidden: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** A new bot from a preset: its identity, instructions, playbooks and skills. */
export function botFromPreset(provider: string, preset: Preset): Bot {
  const { id: _id, createdAt: _createdAt, ...fields } = preset;
  return { ...newBot(provider), ...fields };
}
