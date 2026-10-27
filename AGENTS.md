# AGENTS.md

给 coding agent 看的代码库说明。面向用户的介绍见 [README.md](README.md)（英文，默认）和 [README.zh-CN.md](README.zh-CN.md)（中文），完整设计见 [docs/design.md](docs/design.md)。

## 项目是什么

pocket-bots 是跑在用户自己电脑上的个人 bot 平台。一个 bot = 一份配置（身份、指令、模型、技能、MCP、连接的应用、定时任务）+ 一个工作目录（记忆、技能、上传的文件）。bot 不直接调模型 API，而是驱动本机已登录的编码 agent CLI（Claude Code、Codex、DeepSeek Harness、OpenCode、Pi、Grok Build）当「大脑」：pocket-bots 负责开会话、给它工具、替用户回答审批、把输出存下来给 Web UI 看。几个 bot 还能进同一个群聊分工协作。

## 架构

```
浏览器 (React) ──HTTP RPC / SSE──▶ App 后端（一个 Node 进程）──进程内调用──▶ packages/runtime ──▶ 六个 agent CLI
                                     │  SQLite + bots.json                           │
                                     └── 127.0.0.1 Relay（MCP：bot 工具、应用代理、webhook）◀── agent 反向调用
```

- **两个包，职责分开。** `packages/runtime` 只管「驱动一个 agent 会话」（开、发送、插话、打断、审批、续接、把输出统一成 `TimelineItem`），不知道 bot、群、记忆。这些业务概念全在 `packages/app`。不要把业务逻辑放进 runtime。
- **统一接口**在 `packages/runtime/src/types.ts`：`RuntimeAdapter.open(SessionSpec) → RuntimeSession`，会话发出 `RuntimeEvent`。每个 CLI 一个适配器（`src/adapters/*`），能力写死在 `RuntimeCapabilities` 里，由合同测试（`test/contract.ts`）验证。
- **一个进程独占一个数据目录**（`~/.pocket-bots`，`POCKET_BOTS_HOME` 可改；启动时加锁）。`bots.json` 存 bot 和库（`server/store.ts`，带 revision 的乐观并发）；`pocket-bots.sqlite` 存聊天、时间线、群聊（`server/db.ts`，`node:sqlite`，WAL）。
- **先提交，再展示。** runtime 事件、群消息都先写进 SQLite，再推给界面、再投递给 bot。进程随时被杀，重启后状态要一致。
- **前后端通信**：每个 RPC 是一对 zod 定义（`shared/rpc.ts`，前后端共用），浏览器 `POST /api/rpc/<name>`；`GET /api/events`（SSE）推「什么变了」，页面让对应查询失效重拉。
- **后端内部**：组件在 `server/main.ts` 装配，用进程内事件连接（ChatService 发 `agent.settled`、`turn.ended`、`input.accepted` 等，GroupChats、队列、活动记录订阅）。
- **审批都由 pocket-bots 回答**：bot 自己的工具和白名单放行，其余在聊天里弹卡片。
- **用 CLI 自己的登录**：不保存、不注入任何模型 API key。
- **群聊**：每个 bot 在群里有自己的座位（一个普通聊天；leader 带的成员每个地方一个，一次跑一个），只通过 `group_send` 等工具说话；叫醒只给提示，发言前检查它是否看过新消息。规则复杂，改群聊前先读 [docs/group-chats.md](docs/group-chats.md) 和 design.md §6；消息流程、每一步读写的状态和各种组合，见 [docs/group-protocol.md](docs/group-protocol.md)。

## 源码目录

```
packages/
├── runtime/                     @pocket-bots/runtime，直接导出 src/*.ts（无构建步骤）
│   ├── src/types.ts             runtime 层的全部接口
│   ├── src/adapters/            claude / codex / dsh / opencode / pi / grok，fake.ts 是测试用的脚本化 runtime
│   ├── src/session-base.ts      适配器共用的会话状态
│   ├── src/tool-detail.ts       工具调用 → 时间线详情
│   ├── src/questions.ts         各 CLI 的提问工具 → question 审批
│   ├── src/env.ts               启动 CLI 前清理环境变量
│   └── test/                    *.test.ts 单元测试；contract.ts 合同测试；live*.ts 跑真 CLI
└── app/                         @pocket-bots/app
    ├── src/server/              后端（Hono，tsx 直接跑）
    │   ├── main.ts              装配入口
    │   ├── http.ts、rpc-handlers.ts、events.ts、hosts.ts
    │   ├── store.ts、db.ts      bots.json；SQLite 和 MIGRATIONS
    │   ├── host.ts、providers.ts
    │   ├── chat-service.ts、supervision.ts、chats.ts、prompt.ts
    │   ├── groups.ts、group-store.ts、briefing.ts、reminders.ts、breakers.ts
    │   ├── relay.ts、tools/     MCP relay；bot 工具（tools/index.ts 是总表）
    │   └── scheduler.ts、queue.ts、answers.ts、memory.ts、journal.ts、library.ts、composio.ts、search.ts …
    ├── src/shared/              前后端共用：zod 模型（bot.ts、group-chat.ts）、RPC（rpc.ts、rpc-core.ts）、纯逻辑
    ├── src/web/                 React SPA：app/ 页面，chat/ 聊天流纯逻辑，components/，lib/（RPC 客户端、SSE、路由）
    ├── tests/                   vitest；helpers.ts 有 makeBot 等工厂
    └── scripts/dev.mjs
docs/                            features.md、USAGE.md、design.md、group-chats.md、group-protocol.md（中文）
spikes/                          早期协议验证脚本，不参与构建和测试，一般不用改
```

大多数源文件开头都有一段注释说明它负责什么；找代码先看那里。

## 运行指令

需要 Node.js ≥ 24（用到 `node:sqlite` 和直接运行 `.ts`）。

```bash
npm install
npm run dev              # 后端（tsx watch，6880）+ Vite（http://127.0.0.1:5180，/api 转发给后端）
npm run build            # 构建 Web UI 到 packages/app/dist/web
npm start                # 生产方式启动，http://127.0.0.1:6880
npm run typecheck        # runtime + app 的 server / web 三份 tsconfig
npm test                 # runtime 和 app 的全部 vitest（用 fake runtime，不调模型）
npx vitest run --root packages/app tests/groups.test.ts   # 只跑一个文件
npm run test:live -- claude   # 合同测试跑真 CLI（会消耗用户额度，只在改适配器时跑）
node packages/runtime/test/live-dsh-patch.ts [model]   # 只在改 DSH 版本相关的东西时跑：它的私有条目还在不在、bot 指令还进不进 prompt
```

开发时用单独的数据目录，别动用户真实的 `~/.pocket-bots`：`POCKET_BOTS_HOME=/tmp/pb-dev npm run dev`。`POCKET_BOTS_FAKE_RUNTIME=1` 会多出一个脚本化的 fake runtime。

## 开发流程

每次改动都从最新的 `main` 切出一个分支，改完提 PR，不直接往 `main` 提交：

```bash
git fetch origin
git checkout main && git pull --ff-only
git checkout -b <kebab-case 分支名>      # 如 chat-group-folders、folder-picker-paths
# 改代码、补测试、更新文档
npm run typecheck && npm test
git push -u origin <分支名>
gh pr create --base main
```

- **提交信息**用英文：祈使句标题（如 `Add working folders for chats and group chats`），正文说明为什么改、用户看到什么变化。
- 提 PR 前 `npm run typecheck` 和 `npm test` 都要过。

## 代码规范

- **TypeScript strict**（`noUncheckedIndexedAccess`、`noUnusedLocals/Parameters`），ESM，双引号、分号、两格缩进。没有 linter / formatter 配置，照周围代码的风格写。
- **import 扩展名**：`packages/runtime` 里写 `./types.ts`（会被 `node` 直接运行）；`packages/app` 里不写扩展名。
- **注释**：英文，解释「为什么」和约束，不复述代码；文件开头一段说明这个文件负责什么。
- **校验用 zod**，类型尽量从 schema 推出；共用的类型和纯逻辑放 `src/shared`，不要在 server 和 web 里各写一份。
- 调用方的错抛 `RequestError`（`server/errors.ts`，回 400）；后端自己的失败回 500。

常见改动落在哪：

| 要做的事 | 改哪里 |
|---|---|
| 新 RPC | `shared/rpc.ts` 用 `defineRpc` 定义 → `server/rpc-handlers.ts` 里 `handle(...)` → web 用 `lib/api.ts` 的 `rpc(contract, input)` 调 |
| 改 SQLite 表 | 在 `server/db.ts` 的 `MIGRATIONS` 末尾追加一条（带编号注释），不要改已有的迁移 |
| bot 配置加字段 | `shared/bot.ts` 的 `BotSchema`，用 `.default(...)` 兼容旧的 `bots.json` |
| 新 bot 工具 | `server/tools/*.ts` 定义（zod 描述参数），在 `server/tools/index.ts` 的 `BOT_TOOLS` 里登记 |
| system prompt | `server/prompt.ts` |
| 某个 CLI 的行为 | `packages/runtime/src/adapters/<cli>.ts`，必要时更新 `RuntimeCapabilities` 并跑 `npm run test:live -- <cli>` |

## 测试和文档

- 新功能、修 bug 都要补测试：纯逻辑测 `shared/` 的函数；涉及会话、群聊、队列的用 fake runtime 写端到端测试（参考 `tests/chat-service.test.ts`、`tests/groups.test.ts`）。测试里不要调真的模型。
- 用户能看到的行为变了，同一个 PR 里更新 `docs/`：功能清单 `features.md`，用法 `USAGE.md`，实现 `design.md`，群聊规则 `group-chats.md`，群聊通信协议 `group-protocol.md`。文档用中文。README 有英文（`README.md`）和中文（`README.zh-CN.md`）两份，改一份时同步改另一份。
