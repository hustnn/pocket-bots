# Pocket Bots 设计

这篇讲 pocket-bots 是怎么实现的：有哪些组件、各自负责什么、彼此怎么通信、怎么驱动 Claude Code / Codex 这些 agent、一个 bot 怎么工作、几个 bot 在群聊里怎么协作。

- 有哪些功能：[features.md](features.md)
- 每个功能怎么用：[USAGE.md](USAGE.md)
- 群聊的完整规则和一个从头到尾的例子：[group-chats.md](group-chats.md)

---

## 1. 总览

pocket-bots 是一个跑在你自己电脑上的个人 bot 平台。一个 bot = 一份配置（身份、指令、模型、技能、MCP 工具、连接的应用、定时任务）+ 一个工作目录（记忆、技能、上传的文件）。bot 本身不调模型 API：每个 bot 选一个本机已经登录好的编码 agent CLI（Claude Code、Codex、OpenCode、Pi、Grok Build）当「大脑」，pocket-bots 负责驱动这个 CLI、给它工具、替你回答它的审批、把它的输出存下来给你看。

```
 浏览器（React Web UI）
   │  HTTP RPC：POST /api/rpc/<name>
   │  SSE：/api/events、/api/chats/:id/events
   ▼
 App 服务（一个 Node 进程，独占数据目录）
   ├─ Store ............ bots.json：bot、技能库、MCP 库、默认值、界面状态
   ├─ ChatService ...... 每个聊天的会话：打开 / 续接 / 发送 / 插话 / 打断 / 审批 / 时间线 / 看护
   ├─ GroupChats ....... 群聊：消息、投递、提示、发言前检查、草稿、任务、提醒、座位
   ├─ Relay ............ 127.0.0.1 上的 MCP 服务：bot 工具、连接的应用代理、webhook
   ├─ Scheduler、Queue、Memory / Journal、Library、Composio、Search …
   └─ Db ............... SQLite（node:sqlite，WAL）
   │
   │  进程内 TypeScript 接口：RuntimeAdapter / RuntimeSession / RuntimeEvent
   ▼
 Runtime 层（packages/runtime，不知道 bot 和群的存在）
   ├─ claude   → Claude Agent SDK → 本机 claude
   ├─ codex    → codex app-server（stdio JSON-RPC）
   ├─ opencode → opencode serve + @opencode/client v2
   ├─ pi       → pi --mode rpc + pocket-bots 生成的扩展
   └─ grok     → grok agent stdio（ACP）
          │
          └── agent 调用 pocket-bots 的工具：HTTP MCP → Relay（反向）
```

几条贯穿全局的原则：

- **一个进程，一个数据目录。** 所有状态都在 `~/.pocket-bots`（可用 `POCKET_BOTS_HOME` 改）里，由一个 Node 进程独占（启动时加锁，第二个实例直接退出）。没有外部数据库、消息队列或多机协调。
- **先提交，再展示。** runtime 的每个事件、群里的每条消息，都先写进 SQLite，再推给界面、再投递给 bot。进程随时被杀，重启后状态一致。
- **runtime 层和业务分开。** `packages/runtime` 只管「驱动一个 agent 会话」：开会话、发消息、插话、打断、回答审批、续接、把输出统一成时间线条目。bot、群、记忆这些概念都在 `packages/app`。
- **审批都由 pocket-bots 回答。** 五个 CLI 的审批请求都回调到同一套策略：bot 自己的工具直接放行，白名单里的放行，其余在聊天里弹卡片等你。
- **用 CLI 自己的登录。** pocket-bots 不保存、不注入任何模型 API key；每个 CLI 用它自己登录的账号和订阅额度。

---

## 2. 组件

代码分两个包：

| 包 | 内容 |
|---|---|
| `packages/runtime` | 直连五个 CLI 的运行时层：统一接口（`src/types.ts`）、五个适配器（`src/adapters/`）、工具调用详情的映射（`src/tool-detail.ts`）、提问工具的转换（`src/questions.ts`）、子进程环境清理（`src/env.ts`）、一个脚本化的假 runtime（测试用） |
| `packages/app` | 后端（`src/server`）、Web UI（`src/web`）、两边共用的类型和纯逻辑（`src/shared`） |

后端的主要组件：

| 组件 | 文件 | 负责 |
|---|---|---|
| 启动与装配 | `server/main.ts` | 读配置、给数据目录加锁、建各组件、把它们的事件连起来、启动 HTTP 和 relay |
| HTTP 层 | `server/http.ts`、`server/rpc-handlers.ts`、`server/events.ts`、`server/hosts.ts` | RPC 路由、SSE 事件流、群文件下载、静态页面；按 Host 头防 DNS rebinding |
| Store | `server/store.ts`、`shared/bot.ts` | `bots.json`：bot、技能库、MCP 库、默认值、预设、界面状态；带 revision 的乐观并发保存；每次改 bot 留历史快照 |
| PocketHost | `server/host.ts`、`server/providers.ts` | 把 Store、各 runtime、ChatService 包成一个门面，供工具、调度器、群聊使用；探测每个 CLI 是否安装、是否登录 |
| ChatService | `server/chat-service.ts`、`server/supervision.ts` | 每个聊天（单聊、群聊座位、定时任务的运行、ask_bot）的 runtime 会话：打开、续接、发送、插话、打断、审批、时间线写入、空闲关闭；运行时看护（启动排队、启动超时、卡住的运行、压缩失败） |
| 聊天配置 | `server/chats.ts`、`server/prompt.ts` | 由 bot 配置生成一个会话的 `SessionSpec`：system prompt、MCP 服务器、免审批的工具、可访问的目录 |
| GroupChats | `server/groups.ts`、`server/group-store.ts`、`shared/group-chat.ts` | 群聊的全部流程和存储，见 §6 |
| Relay 和 bot 工具 | `server/relay.ts`、`server/tools/*` | 本机 MCP 服务：bot 自己的工具（`bots`）、群聊工具、连接的应用代理；webhook 入口 |
| Scheduler | `server/scheduler.ts`、`server/cards.ts` | 定时任务和 webhook 触发的运行；运行记录；结果卡片 |
| 消息队列 | `server/queue.ts` | bot 忙时排队的消息，由后端在它空闲时逐条发出（关掉网页也照发） |
| ask_bot 的答案 | `server/answers.ts`、`server/tools/bots.ts` | bot 之间私下求助；超时的答案在对方答完后自动送回 |
| 记忆和活动 | `server/memory.ts`、`server/journal.ts`、`server/activity.ts`、`shared/activity.ts` | `MEMORY.md` 注入、每日日志、记忆改动记录（可撤销）、最近的工作摘要 |
| 库 | `server/library.ts`、`server/mcp-probe.ts`、`server/mcp-sources.ts`、`shared/skills.ts` | 技能库（新建、从 GitHub 导入、审阅）、MCP 库（导入配置、测试连接） |
| 连接的应用 | `server/composio.ts`、`shared/apps.ts` | 用你自己的 Composio 项目连接 Gmail、Slack、GitHub 等 |
| 搜索 | `server/search.ts`、`shared/search.ts` | 单聊和群聊消息的全文搜索（FTS5 trigram） |
| 存储 | `server/db.ts` | SQLite：WAL、版本化迁移、事务 |
| 其他 | `server/instance.ts`、`server/config.ts`、`server/service.ts`、`server/share.ts`、`server/images.ts` | 单实例锁、配置、装成 launchd / systemd 服务、bot 导出导入、头像生成 |

Web UI（`packages/app/src/web`）是一个 React 单页应用：`app/` 是页面（侧栏、bot 面板、聊天、群聊、库、设置、搜索面板），`chat/` 是聊天流的纯逻辑（时间线 → 行 → 布局、输入框规则、提问表单），`lib/` 是数据层（RPC 客户端、React Query、SSE 订阅、路由、草稿）。

---

## 3. 组件之间怎么通信

### 3.1 浏览器 ↔ 后端

- **RPC**：每个接口是一对用 zod 定义的请求 / 响应（`shared/rpc.ts`），前后端引用同一份定义，两边都校验。浏览器 `POST /api/rpc/<name>`。调用方的错（参数不对、没有这条消息）回 400，后端自己的失败回 500 并记日志，两种都带原因给界面显示。
- **事件**：`GET /api/events` 是一条 SSE 长连接，推送「什么变了」：`store`（bots.json 的新 revision）、`agent`（某个聊天的状态）、`group`、`queue`、`cards`、`routines` 等。页面收到后让对应的查询失效、重新拉取。连接断了会自动重连并补拉。
- **聊天时间线**：`GET /api/chats/:id/events` 只发「有新内容」的提示；页面先拉一次尾部，之后每次提示只拉游标之后的新条目，更早的按需分页加载。
- **安全**：Web UI 没有登录，默认只监听 `127.0.0.1`；每个请求按 Host 头检查（localhost、IP、`web.hostnames` 里配置的域名），防止别的网页通过 DNS rebinding 调用。

### 3.2 后端内部

组件之间用进程内事件连接（在 `main.ts` 里装配），没有额外的总线：

- ChatService 发出 `agent.updated`、`agent.settled`、`turn.ended`、`input.accepted`、`session.opened`、`compaction`、`permission.requested` / `permission.resolved`、`start.ready` / `start.failed`、`session.reset` 等事件。
- GroupChats 订阅其中和座位有关的：消息被模型收下（推进「模型看过的记录」）、新的模型上下文、启动失败、轮次结束（出错处理）、审批（bot 的提问进群）。
- 消息队列在 `agent.settled` 时发下一条；ask_bot 的答案在被问的聊天 `turn.ended` 时送回；活动记录（每日日志、记忆改动、定时任务结果）挂在轮次的开始和结束上。
- 所有对界面有意义的变化都经 EventHub 变成 SSE 事件。

### 3.3 后端 ↔ runtime 层

一组 TypeScript 接口（`packages/runtime/src/types.ts`），进程内直接调用：

```ts
interface RuntimeAdapter {
  readonly id: "claude" | "codex" | "opencode" | "pi" | "grok";
  readonly capabilities: RuntimeCapabilities;   // 写死在代码里、由合同测试验证
  probe(): Promise<ProbeResult>;                // 装了没有、登录没有、版本
  models(): Promise<ModelDef[]>;
  modes(): ModeDef[];                           // 这个 agent 的审批模式
  open(spec: SessionSpec): Promise<RuntimeSession>;   // 新建，或按 spec.resume 续接
}

interface SessionSpec {
  key: string; cwd: string; model?: string; thinking?: string; mode?: string;
  systemPrompt: string;                         // 追加在 agent 自己的 system prompt 后面
  mcpServers: Record<string, McpServerConfig>;  // bot 的 MCP 服务器，加上 pocket-bots 自己的
  trustedTools: string[];                       // 免审批："server" 或 "server/tool"
  hostedMcpServers?: string[];                  // pocket-bots 自己托管的服务器，适配器可改用原生方式提供
  extraDirectories?: string[];                  // 记忆、技能目录（工作目录之外也免审批）
  approvals: ApprovalHandler;                   // 所有审批请求都回调到这里
  resume?: ResumeHandle;                        // agent 自己的会话 id，存在 SQLite 里
}

interface RuntimeSession {
  send(input: UserInput, opts: { whenBusy: "steer" | "queue" | "interrupt" | "reject"; expectedTurnId?: string; clientMessageId: string }): Promise<SendResult>;
  interrupt(): Promise<{ canceledTurnId: string | null }>;   // 等这一轮真正结束才返回
  commands(): Promise<SlashCommand[]>;          // 这个 agent 的斜杠命令
  usage(): ContextUsage | null;
  liveTurn?: boolean; alive(): boolean | undefined; kill(signal): void; abandonTurn(): void;   // 看护用
  close(): Promise<void>;
  on(listener: (event: RuntimeEvent) => void): () => void;
}

type SendResult =
  | { ok: true; as: "turn" | "steer" | "queued"; turnId: string | null }
  | { ok: false; reason: "busy" | "steer_unavailable" | "turn_mismatch" | "compacting" | "closed" | "error" };

type RuntimeEvent =
  | { type: "session_ready"; handle: ResumeHandle }
  | { type: "turn_started"; turnId: string }
  | { type: "input_accepted"; clientMessageId: string; turnId: string; as: "turn" | "steer" }  // 消息真的进了模型上下文
  | { type: "item"; turnId: string | null; key: string; item: TimelineItem }
  | { type: "usage"; usage: ContextUsage }
  | { type: "turn_ended"; turnId: string; outcome: "completed" | "failed" | "canceled"; error?: string }
  | { type: "exited"; error?: string };
```

两点是群聊的基础：

- **`send` 有明确结果**：开了新一轮、插进了正在跑的一轮、排队了，还是被拒绝（以及为什么）。
- **`input_accepted` 说明消息真的进了模型的上下文**，而不只是写进了进程。群聊靠它判断「这个 bot 的模型知道了什么」。

五个 agent 的输出被统一成同一种**时间线条目**（`TimelineItem`）：用户消息、回复、思考、工具调用（带结构化详情：命令和输出、文件编辑的 diff、读文件、搜索、子 agent…）、待办列表、错误、通知、上下文压缩。存储和界面都只认这一种形状。

`RuntimeCapabilities` 写死每个 agent 已验证的能力：能不能插话、插话落在哪（下一步 / 当前工具调用之后）、「收下」信号是真的送达还是只是排队、能不能看图、有没有子 agent 工具、续接时是否还用开始时的 system prompt、会不会报告上下文压缩、有没有向用户提问的工具。

### 3.4 runtime 层 ↔ agent CLI

每个适配器用这个 CLI 自己的协议，详见 §4。启动任何 CLI 之前先清理子进程环境（去掉 `CLAUDE*`、`ANTHROPIC*`、`MCP_*` 这类变量），避免继承宿主进程的认证代理或配置；Claude 另外关掉它自己的自动记忆和 claude.ai 连接器、不读用户级设置，因为 bot 有自己的记忆和工具。

### 3.5 agent → pocket-bots（反向调用）

agent 要调用 pocket-bots 的工具（`ask_bot`、群聊工具、提议卡片…）或连接的应用时，走 **Relay**：一个只监听 `127.0.0.1` 的 HTTP 服务（默认端口 6881，第一次选定后一直沿用，因为已有会话和 webhook 地址都带着它）。

| 路径 | 作用 |
|---|---|
| `/bots/<botId>/<chatId>` | pocket-bots 自己的工具（MCP 服务器 `bots`），身份由路径和 token 绑定到这个 bot 的这个聊天 |
| `/bots/<botId>/<chatId>/<groupId>` | 同上，群聊座位还多了这个群的群聊工具 |
| `/mcp/<botId>` | 连接的应用：检查这个 bot 能用这个应用和工具后，加上 Composio 的 key 转发过去 |
| `/hooks/<routineId>/<secret>` | 定时任务的 webhook |

每个聊天的 MCP 配置里带一个 bearer token，由只有这个进程知道的密钥签名，relay 凭它认出是哪个 bot 的哪个聊天。身份在开会话时就绑定了，不需要工具调用时再猜是谁。

各 agent 拿到这些工具的方式不同（见 §4 的表），但工具的定义只有一份（`server/tools/*`，用 zod 描述参数），审批时 pocket-bots 自己的工具一律免审批。

---

## 4. 和五个 agent CLI 的关系

pocket-bots 不实现 agent，它是 agent CLI 的「宿主」：给 CLI 一个工作目录、一段追加的 system prompt、一组 MCP 工具，然后以用户的身份和它对话，并替用户回答它的审批。每个 CLI 都用它自己已经登录好的账号。

| | Claude Code | Codex | OpenCode | Pi | Grok Build |
|---|---|---|---|---|---|
| 怎么驱动 | Claude Agent SDK `query()`（流式输入），指向本机 `claude` | `codex app-server`，stdio JSON-RPC | `opencode serve` + `@opencode/client` v2 | `pi --mode rpc`（JSONL）+ pocket-bots 生成的扩展 | ACP：`grok agent stdio` |
| 登录 | 本机 `claude` 的 claude.ai 登录 | `codex login` | OpenCode 自己的配置 | Pi 的 `/login` | grok.com |
| 插话进正在跑的一轮 | 一条 `priority: "next"` 的用户消息，当前工具调用结束后进上下文 | `turn/steer`，下一个模型步骤 | `delivery: "steer"`，当前工具调用后 | RPC `steer` | `_x.ai/interject` |
| 「消息已进上下文」的信号 | 这条消息的生命周期变成 started | `turn/steer` 成功并出现这条 `userMessage` | inbox `delivered` | 队列清空后这条消息的 `message_start` | 没有单独的送达事件（排队即算收下） |
| pocket-bots 的工具 | HTTP MCP（`bots`） | 动态工具（`dynamicTools`） | HTTP MCP + 权限规则 | 扩展注册的 MCP | ACP 会话的 MCP 服务器 |
| 审批回到 pocket-bots | `canUseTool` | app-server 的审批请求 | 权限规则 + `permission.asked` | 扩展的 `tool_call` 钩子 | `session/request_permission` |
| 续接 | `resume: sessionId` | `thread/resume` | 同一个会话 id | `--session-id` + `--session-dir` | `session/resume` |
| 斜杠命令 | SDK 的命令列表，原样发送 | 内置 `/compact` + 技能 | 内置 `/compact` + 命令和技能 | 内置 `/compact` + RPC 命令列表 | ACP 推送的命令列表 |
| 子 agent | ✅ | ✅ | ✅ | ✗ | ✅ |
| 向用户提问的工具 | `AskUserQuestion` | `request_user_input`（只在 plan 模式下有） | `question` | ✗ | `ask_user_question` |

几个由协议决定的细节：

- **Codex 的工具**：pocket-bots 自己托管的 MCP 服务器（`hostedMcpServers`），Codex 适配器自己连上去列出工具，再作为 Codex 的动态工具交出去；调用时适配器转发给 relay。这样 Codex 不会为每次 MCP 调用发确认请求。
- **OpenCode 的工具**：MCP 服务器按会话加入，pocket-bots 的工具和免审批的工具写成 `allow` 权限规则，其余是 `ask`。
- **Grok 的每次 MCP 调用都会请求权限**：pocket-bots 的工具和白名单里的自动回答允许。
- **Pi 原本没有审批**：pocket-bots 生成的扩展在 `tool_call` 钩子里回调到审批策略，Pi 也就有了审批。
- **提问工具**：每个 CLI 的提问工具都被转换成一种「种类为 question 的审批」（`runtime/src/questions.ts`），界面显示成表单，回答按各 CLI 要求的格式送回。
- **续接时的 system prompt**：Claude Code 和 Codex 续接一个会话时会忽略新传的 system prompt，继续用开始时的那份。群聊座位因此记下每个会话按哪个 prompt 跑，prompt 改了就在续接后的第一条输入前补发（§6.6）。

### 4.1 审批

所有审批请求都到 `SessionSpec.approvals`，按顺序判断：

1. pocket-bots 自己的工具（群聊、ask_bot、提议…）：直接放行；
2. bot 设置里免审批的 MCP 工具（`server/tool`），以及命令白名单（同一个命令、同一个目录，完全一致）：放行；
3. 其余的：在这个 bot 的聊天里生成一张审批卡片，等你点；群聊座位的审批在群里只显示「X needs your approval」。

每个 agent 自己的审批模式（Claude 的 permission mode、Codex 的 approval policy 和 sandbox、OpenCode 的权限规则…）照常生效，决定哪些操作会产生审批请求；pocket-bots 决定怎么回答。

### 4.2 会话的一生

1. 第一次往一个聊天发消息时，ChatService 用 bot 当前的配置生成 `SessionSpec`，打开会话，把会话 id（`ResumeHandle`）存进 SQLite。
2. 每个 runtime 事件先合并（流式片段在内存里合并，条目完成或每 250ms 写一次），写进时间线表，再通知界面。
3. 会话空闲 15 分钟就关掉子进程，只留会话 id。下次发消息时用会话 id 续接；每次打开都带上 bot 最新的 prompt、记忆和工具。
4. 续接失败（CLI 那边已经没有这个会话）就开一个新会话，在聊天里记一行说明，不让聊天卡住。
5. pocket-bots 重启时，所有子进程都没了：正在跑的轮次标成中断，聊天照常可以续接。

### 4.3 运行时看护

ChatService 对每个聊天都做这些（常数在 `server/supervision.ts`）：

| 机制 | 规则 |
|---|---|
| 启动排队 | 整个进程一个启动队列，同时最多 6 个在启动，每个比上一个晚至少 0.5 秒（一个群最多 6 个 bot，一条 @everyone 正好全部启动）。排队或打开会话期间发来的消息合进第一条输入 |
| 启动超时 | 拿到启动名额后 2 分钟内运行时必须报出第一个事件，否则这次启动失败（比如 CLI 卡在登录提示上） |
| 看不到的轮次 | 会自己报轮次的 runtime（Codex、Pi）空闲时写进一条，30 秒内没出现这一轮也没有任何事件，聊天回到空闲 |
| 卡住的运行 | 每分钟检查一次；一轮 15 分钟没有任何事件、又不是在等审批：进程已经没了就结束它（SIGTERM，10 秒后 SIGKILL），没收下的输入在续接的会话里再发一次；进程还在就只记一次日志 |
| 压缩不结束 | 报了压缩开始、5 分钟没报结束，在聊天里记一行 |
| 压缩一直失败 | Pi 的会话连着 3 次压缩失败（会话已经大到压缩请求都放不进模型），不再续接它，改开新会话并说明 |

---

## 5. Bot 怎么工作

### 5.1 一个 bot 由什么组成

**配置**存在 `bots.json`（`shared/bot.ts` 的 `BotSchema`）：

| 部分 | 内容 |
|---|---|
| 身份 | 名字、角色、简介、头像、朗读用的声音 |
| 灵魂 | 常驻指令（Standing instructions）、Playbooks（带触发词的流程指引） |
| 模型 | agent（provider）、模型、思考强度、审批模式、能否联系其他 bot、工作目录（托管的或你的项目） |
| 记忆 | 是否允许 bot 自己写记忆（`memoryAutoWrite`，默认关；bot 不能通过提议改它，导入时重置为关；每日日志不受它影响，始终记） |
| 能力 | 用哪些技能、哪些 MCP 服务器、哪些连接的应用（及其工具和账号限制）、免审批的工具 |
| 定时任务 | 计划或 webhook、要做的事、结果贴到哪个聊天 |
| 界面 | 置顶、隐藏、归档 |

**文件**在它的目录 `~/.pocket-bots/Bots/<botId>/`：

```
MEMORY.md                  长期记忆，每个新聊天都注入前 200 行（最多 24 KB）
memory/<topic>.md          主题记忆，bot 需要时自己读
memory/log/YYYY-MM-DD.md   每日日志，每轮结束 pocket-bots 写一行
skills/<name>/             这个 bot 用的技能（链接到共用的技能库）
uploads/                   聊天里上传的非文本文件
```

托管目录同时就是 agent 的工作目录；选了自定义工作目录时，记忆和技能目录作为「额外可访问的目录」交给 agent，读写它们不弹审批。

### 5.2 system prompt

每次开会话时由 `server/prompt.ts` 组装，追加在 agent 自己的 system prompt 后面，分这几段：

1. **Persona**：名字、角色、简介；
2. **Standing instructions**：你写的常驻指令；
3. **Group chat**：只有群聊座位才有，讲怎么在群里协作（§6.9）；
4. **Memory**：`MEMORY.md` 的当前内容和记忆文件的约定。`memoryAutoWrite` 关闭时说记忆只读、值得记的事告诉用户，打开时说自己更新；这句写在常驻部分，切换开关会改变常驻 prompt；
5. **Recent work**：最近两天每个聊天里 bot 最后说的话（来自每日日志），让新聊天知道最近在忙什么；
6. **Skills**：技能名和「什么时候用」，bot 需要时自己读 `SKILL.md`；
7. **Playbooks**：只放触发词出现在第一条消息里的那几个；
8. **Connected apps**：能用的应用、账号和工具范围；
9. **Bot tools**：pocket-bots 自己的工具怎么用。

记忆内容和最近的工作每天都在变，算「易变」部分；其余是「常驻 prompt」，群聊座位按它的哈希判断要不要补发（§6.6）。只有群聊座位会补发：bot 自己的聊天不记常驻 prompt 的哈希，Claude Code 和 Codex 续接的老会话继续用开始时的写法，所以开关的兜底（下面）不依赖 prompt。

### 5.3 一轮对话

1. 你在界面发消息（可以带附件、引用 bot 的某条回复）。图片直接交给能看图的模型（Claude、Codex、Pi）；文本文件附在消息里；其他文件存进 `uploads/`，消息里给路径。
2. ChatService 按「忙时策略」发送：没在跑就开新一轮；在跑就插话（steer）、打断（interrupt），或者交给队列等这一轮结束（queue）。
3. agent 干活：调工具、读写文件、跑命令。需要审批的弹卡片；调 pocket-bots 的工具走 relay。
4. 每个事件写进时间线并推给界面；侧栏的状态点（在跑、等审批、出错、有新回复）由聊天状态和你的已读记录算出，已读记录存在 `bots.json` 里，换浏览器也一样。
5. 一轮结束（`server/activity.ts`）：记忆文件有改动就记进改动记录（可以撤销）；每日日志记一行（时间、哪个聊天、说了什么、用了哪些工具）；定时任务的运行记下结果，队列里的下一条消息发出。

**记忆写入开关的兜底：一轮结束时恢复，不是写入时拦住。** bot 写记忆用的是各个 agent CLI 自己的文件工具（Claude 的 Write/Edit、Codex 的 patch）或命令行，没有专门的「写记忆」工具，runtime 层也没有按路径拦截的统一办法，所以拦在写入那一刻对所有 provider 和 Bash 写入都做不到。做法是 `server/journal.ts` 本来就在轮次开始和结束时给 `MEMORY.md` 和 `memory/*.md` 拍快照比对：

- `turn.ended` 时 `activity.ts` 从 store 读这个 bot 当前的 `memoryAutoWrite`，`journal.end(botId, chat, { readOnly })` 照常把这一轮的改动记为 `actor: "bot"`；
- `readOnly` 时再把有差异的文件恢复成轮次开始时的内容（bot 新建的删掉，删掉的补回），每个恢复各记一条 `via: "restore"` 的记录（`before` 是 bot 的版本，所以能撤销恢复），随后用恢复后的文件重新拍快照，下一轮开始时不会把恢复当成磁盘上的改动；
- `journal.write`（你在 Memory 页签的编辑和撤销）和 `begin()` 不检查开关；你在一轮进行中经应用做的编辑已经更新了快照，不会被恢复；
- 同一个 bot 常有多个轮次并行（群聊座位、私聊、routine），而基线只有一份：`journal` 按 bot 记着进行中的轮次（聊天 id 的集合，不是计数器），`begin(botId, chatId, { readOnly })` 加入，`end()` 和 `leave()`（`turn.ended` 带 `missed` 时）移除，`agent.removed` 时 `forget()` 兜底。`readOnly` 的 bot 在别的轮次还在跑时开始新轮次，不把差异记成 `you/disk`，也不更新基线，先开始的那一轮结束时还能看到这些改动并恢复；没有其他进行中的轮次、或开关打开时，行为不变；
- 每日日志的写入点也在 `turn.ended`，但它是 pocket-bots 自己的记录，不看开关，也不在快照和恢复范围内；
- 已知局限：恢复发生在轮次结束时，轮次进行中文件是 bot 改过的样子；没看到开始的轮次（后端重启期间结束的）没有快照可比；`memory/log/` 不在快照范围；并行的轮次里先结束的那个，会连同别的聊天已写下的改动一起恢复，记录里算在它名下；轮次进行中你在编辑器里直接改文件，会被当成 bot 的改动恢复掉，但 Changes 里有这条恢复记录，可以撤销。

### 5.4 bot 自己的工具

所有 bot 聊天都有 MCP 服务器 `bots`（群聊座位另有群聊工具，见 §6.8）：

| 工具 | 作用 |
|---|---|
| `list_bots`、`ask_bot`、`check_chat` | 看有哪些 bot；把一个问题交给另一个 bot（对方开一个新聊天），取回答案 |
| `search_chats` | 翻自己过去的聊天和记忆文件（含每日日志），只能看自己的 |
| `get_setup` | 读当前的配置（bot、技能、MCP、默认值） |
| `propose_changes`、`propose_routine`、`propose_skill` | 提议改配置、建定时任务、存技能；在聊天里变成一张卡片，你确认后才生效 |

bot 不能直接改自己或别人的设置，只能提议：卡片逐条列出改动，把要写进 prompt 的文字原样显示，扩大权限、删除之类的单独提醒。

**工具列表每次请求都带**，所以尽量短：

- `propose_changes` 的列表里每条改动只写 `type`（13 种之一），不展开各种改动的字段（完整的 schema 约 15K 字符，原来每个聊天每次请求都要带上）。字段写在 `get_setup` 的总览末尾（不带 `bot` 时），由 `shared/changes.ts` 的 `changeFormat` 从 `ChangeSchema` 生成，不会和校验脱节，共用的形状（Avatar、App、Playbook、Schedule）只写一次。工具执行时再按 `ChangeSchema` 校验（`checkChanges`），不合格式的返回每个问题的位置，加上这次用到的那几种改动的格式，bot 照着改了再提。
- zod 给每个整数加的安全整数上下界（±2^53）不放进列表（`tools/mcp.ts`）。
- 有 leader 的群里，成员的座位只列出它干活用得到的工具（§6.8）。

**ask_bot**：被问的 bot 开一个新聊天（标签记着是谁问的），发起方最多等约 50 秒（MCP 客户端大约一分钟放弃一次工具调用）。来得及就直接返回答案；来不及就告诉发起方「答案会自己送来」，等对方这一轮结束，答案作为一条消息送回发起的聊天（它在忙就先进队列）。

### 5.5 技能、MCP、连接的应用

- **技能库**和 **MCP 库**是共用的，每个 bot 勾选自己用哪些。导入的技能、磁盘上被改过的技能要你审阅后才给 bot；新加的 MCP 服务器要先在本机测试连通（列出工具）才打开。
- MCP 服务器原样交给 agent（stdio 命令由 agent 在本机启动；HTTP / SSE 直接连），名字 `bots` 和 `composio` 留给 pocket-bots。
- **连接的应用**走你自己的 Composio 项目：key 只存在本机（`composio.json`，0600），不交给 bot；bot 调 `/mcp/<botId>`，relay 只放行给这个 bot 打开的应用和工具，必要时填上固定的账号。

### 5.6 定时任务和 webhook

- Scheduler 每 30 秒检查一次。每次运行开一个**新聊天**（标题是任务名），第一条消息就是任务要做的事；结束后记下结果，可以把结果卡片贴到 bot 的某个聊天里。
- 上一次还没结束时新的触发跳过；停机期间错过的运行 12 小时内的补跑一次，更早的记成 Missed。
- webhook：`POST http://127.0.0.1:<relay 端口>/hooks/<routineId>/<secret>`，请求体作为「不可信的外部数据」附在任务要做的事后面。每个任务每分钟最多 10 次，同时最多 3 次在跑，请求体最大 256 KB。

---

## 6. 群聊怎么工作

群聊让 2–6 个 bot 和你在一个长期存在的对话里协作。难点是：每个 bot 都是一个独立的编码 agent，各自在跑、各自有上下文；它们要知道什么时候该说话、不重复别人、不抢同一件活、不因为错过新消息而说出过时的话。

### 6.1 基本模型

- **座位**：每个成员 bot 在每个群里有一个**座位**，就是这个 bot 的一个普通聊天（`kind = seat`），用它自己的模型、审批、技能和 MCP。座位在群第一次需要它时才建。一个 bot 在不同群里有不同的座位，互不挤占上下文，可以并行。
- **只通过工具说话**：bot 在座位里输出的文字不会进群；只有用 `group_send` 发出去的才是它在群里说的话。审批、密钥、登录这些私事留在座位里。
- **成员即投递**：群里的每条消息都会写给每个收到它的成员一条**投递记录**，@ 只是在记录上标「这条是找你的」。每个 bot 都看得到全局，由它自己判断要不要说话。
- **叫醒只给提示**：叫醒一个 bot 时只告诉它「哪里有几条新消息、有没有人找你」，不带消息内容；消息由它自己用 `group_read` 读。正在干活的 bot 也只是多收到一条提示，不会被打断。
- **发言前检查**：bot 发言、认领任务、改任务状态之前，pocket-bots 检查它的模型有没有看过目标位置的新消息；没看过就先不发，存成草稿并给它看最新的几条。
- **认领是锁**：一条顶层消息可以变成任务，先认领的生效，别人认领不到就不做同一件事。

### 6.2 消息存储

一个群的所有状态都在 SQLite 里，**按接收者、按会话**分开存。**会话**（conv）是顶层（0），或一个线程（用它顶层消息的编号表示）。

| 表 | 存什么 |
|---|---|
| `groups`、`group_members` | 群（名字、唤醒方式、最后编号）；成员（座位聊天、从第几条开始静音） |
| `group_messages` | 消息：群内递增编号 `seq`、发送者（你、某个 bot、系统）、文字、回复谁、属于哪个线程、@ 了谁、附件、幂等键、系统消息的种类和起因、bot 的提问 |
| `group_inbox` | **投递记录**：每条消息 × 每个收到它的接收者一行：算不算未读、进没进 bot 的待读和原因、是否 @ 它、读走没有、进过哪条提示、座位收下没有、为什么没送到 |
| `group_read_cursors` | **读位置**：每个接收者（你也是）在每个会话读到第几条 |
| `group_seen` | **模型看过的记录**：每个 bot 每个会话的 boundary（到这条为止都看过）、之后零散看过的编号、最近一次读的顺序，以及「座位建起以来给它看到过哪」 |
| `group_drafts` | 被搁置的发言：每个 bot 每个会话一份，带固定的发送 key、被搁置次数、附件路径，10 分钟过期 |
| `group_tasks`、`group_task_events` | 任务（状态、负责人、版本号、卡片的标题和描述、谁建的、完成和关闭时间）和它只追加的历史 |
| `group_mentions` | 每条消息 @ 的成员和原文 |
| `group_reactions` | 表情回应 |
| `group_thread_follows` | 谁关注哪个线程、为什么、取消了没有 |
| `group_reminders`、`group_reminder_events` | bot 给自己定的提醒和每次变化 |
| `group_messages_fts` | 全文索引（trigram） |

一条消息、它的全部投递记录、它引起的线程关注、发送者的读位置，在**同一个事务**里写完。bot 发言带幂等键，进程中途崩溃后重试不会发出两条。

### 6.3 一条消息进来以后

```
发送（你 / bot 的 group_send / 系统消息）
  │
  ├─1 事务：写消息、每个接收者的投递记录、线程关注、发送者读位置
  ├─2 谁要被叫醒：投递记录里进了 bot「待读」的（按群的唤醒方式）
  ├─3 按每个座位的状态投递提示
  │     还没建 → 建座位，第一条是成员名单 + 提示（加上分给它、没完成的任务）
  │     空闲   → 开新的一轮，内容是提示
  │     在忙   → 等 3 秒（这期间的合成一条）再插进当前这一轮；插不进去 15 秒后再试
  │     压缩中 → 这一轮结束后再发
  ├─4 runtime 报 input_accepted：提示进了模型上下文，投递记录记为「座位收下」
  ├─5 bot 自己 group_read：推进它的「看过的记录」和读位置，消息从待读里取走
  └─6 bot 决定说话：group_send → 发言前检查 → 通过就回到第 1 步；没通过就存草稿、给它看新消息
```

**谁收到（投递记录）**：

- 顶层消息：每个成员 bot 和你各一条；发送者自己也有一条（不算未读）。
- 静音的 bot 从静音那条起收不到普通顶层消息的记录（@everyone 也一样），但 @ 它的、指派给它的回执照样有。
- 线程里的消息：线程的关注者，加上这次发送牵涉到的人（发送者、顶层消息的作者、被 @ 的）。在线程里发言、被 @、是顶层作者都会自动关注；取消关注后，被 @ 会重新关注。
- 系统消息（成员变化、建任务、任务状态变化…）各自声明分类：「起因者不算未读」或「不写投递记录」。bot 的轮次失败、bot 向你的提问都不写投递记录，不叫醒任何人。

**进不进待读（唤醒方式）**，每个群可选：

- **Everyone**（默认）：算它的未读就进待读，任何消息都叫醒所有没静音的 bot，由 bot 判断要不要说话。靠静音、搁置、认领控制成本，bot 互相叫醒没有次数上限。
- **Only who it's for**：只有找它的才进待读：@ 它、回复它、指派给它、@everyone，以及你发的、没找任何人的消息。别的照样写投递记录（之后读得到），只是不叫醒它。

**提示**长这样，每个会话一行，最近有动静的在前，不带正文：

```
[Group inbox notice: 3 new messages for you to read.
- top level: 1 new (#16) · latest from the user
- thread #12: 2 new (#14 to #15) · latest from Ada (bot) · you were @mentioned
]
They haven't been read. Read them when it suits you: group_read with unread: true reads everything in your inbox, …
```

每条消息只进一次提示（投递记录记着进过哪条提示），bot 推迟不读也不会被反复催。只有两种情况带正文：被 @ 进一个它还没看过的线程时附上线程上下文（顶层消息、@ 之前最近 6 条回复和那条 @）；座位换新时附上简报。

### 6.4 读、看过的记录、发言前检查

**`group_read` 有四种读**：读全部待读（最多 40 条）；读一个会话读位置之后的；翻一个会话最新的或某条之前的一页；读某条前后的（定位读）。每种读按规则推进「看过的记录」：读到的这一页能和读位置接上，boundary 就前进到最后一条；接不上，就把读到的逐条记为零散看过。读位置跟着「看过」走：从读位置往后，只要模型都看过就前进。

**看过的记录只在一个模型上下文里算数**：新座位、座位换新、上下文压缩、不报告压缩的 runtime（Grok）每次开会话，都让看过的记录作废（读位置和待读不动）；续接同一个会话则保留。作废之后它第一次在某处发言会先被搁置一次，看一眼最新的几条——它的模型确实不再记得了。

**发言前检查**（`group_send`、`group_send_draft`、`group_claim`、`group_task` 改状态）对目标会话依次看：

1. **待读**：这里有投递给它、它的模型没看过的消息 → 搁置，给它看最新 3 条；
2. **第一次碰这个会话**（没有待读也没有 boundary）：最近 3 条里有没看过的 → 搁置；
3. **只对发言**：从 boundary 往后，除掉零散看过的、它自己的、它自己引起的豁免类系统消息，还有没有新的（顶层数它的投递记录，所以静音期间没收到的不算；线程数线程里的全部消息）→ 有就搁置，给它看最新 3 条并告诉它还有几条。

被搁置时给它看的都记为看过。草稿每个 bot 每个会话一份，10 分钟过期：bot 可以改了再发（新内容替换草稿）、原样发（`group_send_draft`，再检查一次）、丢掉，或者不发；被搁置 3 次之后才提示它可以用 `anyway` 强制发出。另外，bot 最近读的是某个线程、却往顶层发，会先确认一次（存成顶层草稿，确实要发再 `group_send_draft`）。

这套机制的效果：两个 bot 同时想回答，先发的生效，后发的被搁置、看到别人已经说了，自己放弃。没有谁给 bot 排顺序。

### 6.5 多个 bot 怎么分工

- **任务**：一条**顶层**消息可以变成任务，任务号就是消息号（task #12 就是消息 #12，它的线程是 thread #12）。状态 `todo → in_progress → in_review → done`，`closed` 表示不做了；最多一个负责人。bot 按允许的转换改状态，你可以设任何状态。
  - **认领**（`group_claim`）先到先得，被拒绝的原因（已归别人、已是自己的、done、closed）就是一把锁：被拒就不做同样的事，觉得派错了去任务线程里说。座位的 prompt 要求「要动手做事（不只是回答）之前先认领」。
  - **指派**不改状态，被指派的人认领了才是 in_progress；指派带上读到的版本号，任务在这之后变过就拒绝，不覆盖别人的改动。**放下**只去掉负责人、不改状态。
  - **建任务**：bot 把一件大事拆成几个能并行的部分，每个标题先作为它自己的消息发出，再变成任务；带负责人时发一条 @ 负责人的回执（静音也收到）。
  - **卡片**：任务有自己的标题和描述，任何成员都能改（`amend`），消息原文不变，读到这条消息时下面附上当前卡片。每次认领、放下、指派、改状态、改卡片都记进只追加的历史。只有建任务的 bot 和你能删任务。
  - 系统消息：把消息变成任务、bot 建任务发在顶层；改状态、你认领 / 放下 / 指派发在任务自己的线程里；bot 自己认领不发，任务标签会变。
- **线程**：支线讨论放进某条顶层消息的线程，只投给关注者和相关的人，顶层保持干净。线程不嵌套。
- **@、回复、@everyone**：@ 一个 bot 是交接（提示里标「找你的」）；回复某条消息，被回复的 bot 知道是在回它；@everyone 投给每个没静音的成员。@ 了群外的 bot 或不存在的名字，发出后告诉发送者这一下没通知任何人、怎么补救（群外的 bot 用 `ask_bot`）。
- **@ 的去向**（`group_mention_delivery`）：查自己一条消息里每个被 @ 的成员：delivered（它的模型读到了）、still in flight（还在它的待读里，不要下结论）、LOST（限流、运行时拒收、座位起不来、离开了群）或 UNKNOWN，并列出这条消息还到了谁。
- **静音**：静音的 bot 收不到普通的顶层消息，也不会被这些消息挡住发言；@ 它、指派给它、它关注的线程照样送到。你可以设，bot 自己也可以设。
- **表情回应**：代替「收到」「好的」这类消息，不叫醒任何人。
- **子 agent**：runtime 能开子 agent 的座位（Claude、Codex、OpenCode、Grok Build），没有 leader 的群里 prompt 多一段：每个子 agent 都是从零开始的新会话，要把它需要的东西重读一遍，所以小活和中等的活自己做；只有大的、能拆成几块并行的活，或者会让它长时间顾不上群的活才交给子 agent，先回话再分派；子 agent 不能用群聊工具，只有它自己在群里说话。有 leader 的群里，leader 把动手的活派给成员；成员的规则里只有一句：派给你的活自己做（leader 已经拆过了），只有能拆成几块大的、值得并行的才开子 agent，并且不让它用群聊工具。原来这一段让成员把所有动手的活都交给子 agent，基准测试里 Haiku 成员把整件活交给一个 Explore 子 agent，多出一个新会话，占了整个群 37% 的 token。
- **提醒**（`group_reminder`）：bot 给自己定的提醒，挂在一条消息上，可以一次性或重复（`every:15m`、`daily@09:00`、`weekly:mon,fri@09:00`，按定的时候的时区），到点只叫醒它自己；要告诉别人，它到时候 @ 对方。整个进程一个计时器，启动时补响停机期间到点的。
- **bot 的附件和提问**：`group_send` 可以带本机的文件（最多 6 个，必须有文字），发出时复制到群的文件夹；别的 bot 读到时看到文件名、类型和路径。bot 用自己 CLI 的提问工具问你（比如 Claude 的 `AskUserQuestion`），问题作为它的一条消息出现在群里，不进任何人的待读；你在群里回答，答案回到它座位里的那个审批。

### 6.6 座位的一生

- **新座位**：群第一次叫醒这个 bot 时建，第一条输入是成员名单和提示。
- **换新**：座位空闲超过 1 小时、上下文超过 128k token 时，下次被叫醒就换一个新座位（旧的归档），从一份约 8k token 以内的**简报**开始：它看过的最近 25 条消息、它正在用的文件（最多 14 个，现在重读的内容）、最近 12 次操作、分给它还没完成的任务。比续接一个缓存已经过期的大上下文便宜。简报只是参考，不算看过。
- **重启后补课**：pocket-bots 启动时，每个还有未读的座位收到一批未读消息本身（最多 8 个地方、每处 5 条、共 20 条，@ 它的在前）；放不下时退回一条受限的提示：每个地方读一遍就停，只有明确找它的事才处理。座位续接的是同一个会话，看过的记录保留。
- **prompt 改了**：Claude Code、Codex 续接会话时还用开始时的 system prompt。每个座位记下它的会话按哪个常驻 prompt 的哈希跑；续接时哈希变了，就在第一条输入前面放上完整的新 prompt，说明它取代原来的（之前的对话不动，prompt 缓存仍然有效）。
- **座位里直接说话**：你在座位里打字只对这个 bot 说，不进群。

### 6.7 出错和恢复

座位的一轮失败了，pocket-bots 读错误文字分类（`server/runtime-errors.ts`）：限流、服务端出错、连不上、流断了、要重新登录、余额用完、模型或套餐不对、输入太大……并算一个去掉 id、数字、密钥后的指纹。

| 情况 | 处理 |
|---|---|
| 时间能解决的（限流、服务端出错、用量上限…） | 先不叫醒它：10 秒起，连着失败就翻倍，最多 5 分钟，加 0–10% 的随机量；这期间的消息攒在待读里，等完一条提示说全部 |
| 同样的错（同一指纹）连着 3 次 | 它的运行时停下，群里记一行；下一条消息（谁发的都算）或它的提醒让它重新开始 |
| 只有你能解决的（没登录、余额、模型不支持…） | 马上停下，不等也不计数；下一条消息再试 |
| 反复停下 | 终止性失败的断路器：同一指纹停 2 次或任意 3 次，暂停自动叫醒 1 小时，之后一次试探，再失败 4 小时、24 小时；一轮正常结束就合上 |
| 启动后不到一分钟就退出，连着 3 次 | 只等你 @ 它 |
| 座位根本建不起来 | 1、2、4、8 秒后各再试一次，第 5 次停下；之后的叫醒再试，还不行就暂停 5 分钟起、翻倍到 6 小时 |

**你 @ 它就是手动启动**：停下、断路器、计数全部清掉，一条提示说全部。这些等待和断路器的状态都在内存里，重启后从头算；待读在 SQLite 里，所以 bot 不会因为暂停而漏掉消息。

### 6.8 群聊工具

座位只属于一个群，工具不需要指定发到哪里。这些工具都在 `bots` MCP 服务器上，所有 agent 都免审批。工具的说明只讲调用做什么，什么时候该调用写在座位的 prompt 里（§6.9），两边不重复。

| 工具 | 作用 |
|---|---|
| `group_send` | 发言：`thread` 发进线程，`reply_to` 回复某条，`files` 附上本机文件；先过发言前检查 |
| `group_send_draft` | 发出被搁置的草稿（再检查一次）；`discard` 丢掉，`anyway` 跳过检查 |
| `group_read` | 读待读、读一个会话的未读、翻一页、定位读 |
| `group_inbox` | 列出哪些地方有未读，只看不读 |
| `group_search` | 按词搜群消息，只给预览，不算看过 |
| `group_claim` | 认领任务（给消息号，不是任务的先变成任务） |
| `group_task` | 建任务、把消息变成任务、改状态、指派、放下、改卡片、看卡片、看历史、删除、列出 |
| `group_react` | 表情回应 |
| `group_mute` | 静音或取消静音自己 |
| `group_follow` | 关注或取消关注线程（取消时带理由），列出关注的线程 |
| `group_reminder` | 给自己定、列出、推迟、改、取消提醒，看记录 |
| `group_mention_delivery` | 查自己一条消息里每个被 @ 的成员收到没有 |
| `group_members` | 成员、在忙还是空闲、是否静音、手上的任务 |

**有 leader 的群里，成员只列出干活用得到的工具**：`group_send`、`group_send_draft`、`group_read`、`group_claim`、`group_react`、`group_members`，加上 `search_chats`（工具上标着 `led`，`tools/mcp.ts` 的 `ledMember` 按 `GroupChats.ledBy` 判断）。计划、任务、提醒、关注、静音、@ 的去向、问别的 bot、改配置这些它的规则里用不到，就不放进它每次请求都要带的工具列表；它的 prompt 里「Bot tools」一段也只提这些。只是不列出，调用照样执行：会话只在开始时取一次工具列表，换 leader 后已经开着的会话列表是旧的，下次开会话时才更新（prompt 也一样）。成员 @ 了群外的 bot，结果里不再建议用 `ask_bot`。

### 6.9 座位的 prompt

座位的 system prompt 多一段 Group chat（`shared/group-chat.ts` 的 `groupPrompt`），讲：只有工具发出的内容会进群；提示不带内容，用 `group_read` 读；每条消息显示编号、发送者、时间和所在线程；系统消息只是通知；要动手做事先认领，认领失败就别做；不是自己做的事不替别人汇报；没有实质内容就不发；别人在来回对话时没被 @ 就不插嘴；被搁置后不发也是正常结果；提醒用 `group_reminder`；约束和权限要看当前的来源；能开子 agent、能提问的 runtime 各多一段说明。

这一段每次请求都带，所以只写群的代码依赖的规则：工具说明或工具结果里已经讲了的（草稿被搁置后的几种选择、提醒的重复规则）不再重复。按角色裁剪：

| 角色 | 有的部分 | 大小 |
|---|---|---|
| 没有 leader 的群 | 消息、被叫醒时、线程和历史、任务（认领、in_review、建任务和拆活）、提醒和 @、子 agent（能开时）、写法、礼节、约束和权限 | 约 6.9K 字符，带子 agent 约 8K |
| leader | leader 一段（计划、派活、核对、成员和模型），加上面除「认领、in_review、拆活」和子 agent 以外的部分 | 约 8.5K |
| 成员 | 成员一段（只做派给它的、做完在线程里汇报一次就停、不改状态、卡住问 leader、能开子 agent 时自己做），加消息、写法、约束和权限 | 约 4.8K |

原来分别是 12.5K（带子 agent 15.1K）、15.1K 和 15.8K。

---

## 7. 存储

### 7.1 原则

- `node:sqlite`（Node ≥ 24），`journal_mode = WAL`、`synchronous = NORMAL`：进程崩溃不丢已提交的数据，断电可能丢最后一次提交。
- 迁移带版本号（`schema_version`），每个迁移在一个事务里跑完。
- 先提交，再推给界面、再投递给 bot；群消息只追加。
- bot 的配置、技能、记忆是文件（`bots.json` 和 bot 目录），因为 Web UI 的保存模型依赖 `bots.json`，记忆和技能本来就要是 bot 能直接读写的文件。

### 7.2 数据目录

```
~/.pocket-bots/
  bots.json                  bot、技能库、MCP 库、默认值、预设、界面状态
  pocket-bots.sqlite         聊天、时间线、群聊（见下）
  config.json                可选：web.host / web.port / web.hostnames / relay.port
  Bots/<botId>/              每个 bot 的工作目录、记忆、技能、上传
  library/skills/            共用的技能库
  groups/<groupId>/files/    群聊里的附件
  composio.json、webhooks.json、logs/ …
```

### 7.3 表

```
schema_version   version
chats            id, bot_id, provider, model, thinking, mode, cwd, title, labels, resume(会话 id),
                 status, last_error, last_usage, attention, attention_at, seq, last_user_message_at,
                 archived_at, created_at, updated_at,
                 standing_prompt       -- 会话按哪个常驻 prompt 的哈希跑
                 compaction_failures   -- 会话、模型、压缩连着失败几次
                 indexed_seq           -- 搜索索引补到了时间线的哪一条
timeline         chat_id, key, seq_start, seq_end, turn_id, ts, item(JSON)   -- 合并过流式片段的时间线条目
turns            chat_id, turn_id, started_at, ended_at, outcome, error, usage
timeline_fts     FTS5 trigram：单聊里你和 bot 的消息
groups … group_reminder_events、group_messages_fts   -- 见 §6.2
```

搜索（⌘K、聊天里的 ⌘F）用两张 FTS5 trigram 表：群消息发出时就进索引；单聊的回复是一点点流进来的，所以 `timeline_fts` 不在写入时维护，而是每次搜索前把各聊天新增的条目补进去。trigram 能查词的任意一部分和中文；不到三个字的词改成在命中的行里过滤。

---

## 8. 配置和运行

| 配置项 | 环境变量 | 默认值 |
|---|---|---|
| 数据目录 | `POCKET_BOTS_HOME` | `~/.pocket-bots` |
| `web.host` | `POCKET_BOTS_HOST` | `127.0.0.1` |
| `web.port` | `POCKET_BOTS_PORT` | `6880` |
| `web.hostnames` | `POCKET_BOTS_HOSTNAMES` | `[]` |
| `relay.port` | `POCKET_BOTS_RELAY_PORT` | 第一次用 `6881`，之后沿用 |

- 一个数据目录只能跑一个实例（`server/instance.ts` 用一个本地 socket 加锁）。
- `npm run service -- install` 装成登录后自动启动的服务（macOS launchd、Linux systemd），只带 PATH、HOME 和 `POCKET_BOTS_*` 环境变量，所以各 CLI 用它们自己的登录。

---

## 9. 测试

| 测试 | 内容 |
|---|---|
| `packages/runtime/test/contract.ts` | 每个适配器跑同一套合同测试：调用 pocket-bots 的 MCP 工具；一条需要审批的命令；跑到一半插话并被执行；打断；关掉会话后在新进程续接，还记得前文、工具还能用。`npm run test:live -- <runtime>` 用真的 CLI 和登录跑 |
| `packages/runtime/test/live-commands.ts`、`live-prompt-resume.ts` | 真 CLI 上列出斜杠命令并跑 `/compact`；验证续接的会话是否还用开始时的 prompt |
| `npm test` | 单元和端到端测试，用脚本化的假 runtime，不调模型：ChatService 的会话、续接和看护（假计时器）；群聊的存储规则、投递、读、发言前检查、草稿、任务、线程、提醒、@ 的去向、出错和断路器、座位换新、重启补课、bot 的附件和提问；定时任务、队列、ask_bot、记忆、技能、导入导出、搜索、HTTP 错误码等 |
