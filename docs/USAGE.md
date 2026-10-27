# Pocket Bots 使用指南

这份指南按实际使用顺序把每个功能走一遍。示例里的 agent 大多是 Claude Code（`claude`），其他几个（Codex、DeepSeek Harness、OpenCode、Pi、Grok Build）用法一样。每个 CLI 用它自己登录的账号和订阅额度，pocket-bots 不碰任何 API key。

> 安装、配置文件和数据目录见 [README](../README.zh-CN.md)。这里只讲怎么用。

## 目录

1. [准备工作](#1-准备工作)
2. [新建 bot](#2-新建-bot)
3. [聊天](#3-聊天)
4. [审批](#4-审批)
5. [记忆](#5-记忆)
6. [Bot 设置面板](#6-bot-设置面板)
7. [技能（Skills）](#7-技能skills)
8. [MCP 服务器](#8-mcp-服务器)
9. [定时任务（Routines）](#9-定时任务routines)
10. [团队和 bot 之间协作](#10-团队和-bot-之间协作)
11. [提议卡片](#11-提议卡片)
12. [连接的应用（Composio）](#12-连接的应用composio)
13. [管理 bot](#13-管理-bot)
14. [侧栏](#14-侧栏)
15. [搜索和跳转（⌘K）](#15-搜索和跳转k)
16. [设置](#16-设置)
17. [常见问题](#17-常见问题)

---

## 1. 准备工作

1. 装好并登录至少一个 agent CLI，比如在终端里运行一次 `claude` 并登录。其他几个：`codex login`、`grok`（登录 grok.com）、`opencode`、`pi`（`/login`）；DeepSeek Harness 装桌面版就行，但要先给它的 `acp` profile 配一个模型，见下面。
2. 启动 pocket-bots：

   ```bash
   npm install
   npm run build
   npm start
   ```

   打开 <http://127.0.0.1:6880>。左上角会列出已经就绪的 agent（比如 **Claude, Codex ready**）。鼠标停在上面能看到每个 CLI 的状态；没登录的会写原因。

3. 第一次启动时会建好 `~/.pocket-bots/`。之后 bot 的记忆、技能、聊天、群聊、定时任务记录都在这里。

4. 想让它一直开着（登录后自动启动、意外退出后自动重启），装成服务：

   ```bash
   npm run service -- install
   ```

   macOS 上是一个 launchd 用户代理（`~/Library/LaunchAgents/local.pocket-bots.plist`，日志在 `~/.pocket-bots/logs/server.log`），Linux 上是一个 systemd 用户服务（日志用 `journalctl --user -u pocket-bots` 看；要开机就启动、不等你登录，再运行一次 `loginctl enable-linger $USER`）。它跑的就是 `npm start`，用的是你安装时终端里的 PATH，所以各个 CLI 照样用它们自己的登录。

   - `npm run service -- status` 看是否在运行，`npm run service -- uninstall` 去掉，`npm run service -- print` 只打印要写的文件、不安装。
   - 装好以后不要再自己 `npm start`：一个数据目录只能跑一个 pocket-bots。
   - 更新代码后（`git pull`、`npm install`、`npm run build`），再运行一次 `install` 重启它。

### 用 DeepSeek Harness

DeepSeek Harness（DSH）从一个 profile 启动，pocket-bots 用的是它的 `acp` profile，所以要先把那个 profile 配好：

1. **装 DSH。** 桌面版自带 CLI（macOS 上在 `/Applications/DeepSeek Harness.app` 里，pocket-bots 会自动找到），或者 `npm install -g @deepseek-ai/dsh`。装了多个、想指定用哪个，用环境变量 `POCKET_BOTS_DSH_BINARY`。
2. **给 `acp` profile 配 provider 和模型。** 桌面版设置页写的是 `desktop` profile，两边不共享插件配置。先运行一次 `dsh --profile acp --dump-config` 生成 profile，然后在 `~/.dsh/profiles/acp/cordis.patch.yml` 里写：

   ```yaml
   - id: llm-pi-ai
     name: '@deepseek-ai/dsh-llm-pi-ai'
     config:
       providers:
         sophon:
           apiKeyEnv: SOPHON_API_KEY
           api: openai-completions
           baseURL: https://sophon-ai.bytedance.net/gateway/openapi/model/chatCompletion
           models:
             - id: DeepSeek-V4.1-Flash-1017-merlin

   - id: acp
     name: '@deepseek-ai/dsh-acp'
     config:
       provider: sophon
       model: DeepSeek-V4.1-Flash-1017-merlin
   ```

   第一次真正启动一个 profile（`dsh --profile acp`）时它会装插件，可能要几分钟；pocket-bots 的启动超时只有 2 分钟，所以先在终端里跑一次，之后再让 pocket-bots 用。profile 还没建好时 pocket-bots 会直接告诉你先跑哪条命令，不会让聊天卡两分钟。

3. **key。** DSH 把它存在自己的凭据文件里（`~/.dsh/.credentials.yaml`），所有 profile 共用，所以桌面版里存过的 key 不用再存一次；也可以在启动 pocket-bots 的环境里设 `SOPHON_API_KEY` 之类的变量。
4. 重启 pocket-bots，左上角出现 **DeepSeek Harness** 就说明就绪了。bot 的 **Model** 下拉里是 DSH 自己列出的模型（按 `provider/model` 显示），**Thinking** 是这个模型的推理档位。

和别的 agent 不一样的地方：

- **不插话**：DSH 一次只收一条 prompt。一轮还在跑的时候再发消息会**排队**，等这一轮结束立刻发，界面上显示成「排队中」，不是报错。
- **审批模式是 DSH 自己的沙箱**：**Read only**、**Workspace write**（默认）、**Full access**。前两档下越界的工具调用（改工作目录外的文件、跑要联网的命令…）会弹卡片，pocket-bots 照你的回答放行或拒绝；**Full access** 下 DSH 什么都不问。
- 没有斜杠命令，也没有向你提问的工具。
- bot 的指令是每个会话单独传给 DSH 的 system prompt 的，续接一个老会话时也一样生效。

## 2. 新建 bot

点首页或侧栏的 **New bot**，有两个页签：

- **Start**：从空白 bot 或一个角色模板开始。模板会填好名字、角色、简介和一段「Standing instructions」（常驻指令）：
  | 模板 | 用途 |
  |---|---|
  | Blank bot | 空白，指令自己写 |
  | Assistant | 通用助手 |
  | Inbox | 邮件分拣（需要连上邮箱应用） |
  | Scout | 调研，带来源的简报 |
  | Watch | 社区监控，适合配定时任务 |
  | Ops | 日程、待办和跟进 |
  | Elephant | 先设计再写代码的设计伙伴（EGM），见[先设计再写代码（EGM）](#先设计再写代码egm) |
  | Goldfish | 替 Elephant 审设计文档的审阅者（EGM） |

  Elephant 和 Goldfish 还带着它们要用的技能和设置：
  | | Elephant | Goldfish |
  |---|---|---|
  | 技能 | `egm`（随 pocket-bots 发布，放进技能库并算已审阅，见[随 pocket-bots 发布的技能](#随-pocket-bots-发布的技能)） | `egm-goldfish`（同左） |
  | Agent | 照 **New bots start with** | Codex 或 DeepSeek Harness 有一个就绪就用它（第一个是 Codex），否则照 **New bots start with** |
  | 审批模式 | 照 **New bots start with** | Codex、DeepSeek Harness 上是 **Read only**；别的 agent 上是 **Always Ask**，不管默认值是什么 |
  | Contact other bots | **Allowed**：每次审阅都要问 Goldfish，逐个审批会卡住每个阶段 | **Off** |
  | Recent work | 开 | **关** |
  | 开场示例 | 四条 `egm …` 命令 | 无 |

  在设置里保存过的 **Preset**（预设）也会出现在这里。
- **Import**：导入别人导出的 bot 文件或多个 bot 的文件，见[导出和导入](#导出和导入)。

新 bot 的 provider、模型和审批模式来自 **设置 → New bots start with**。默认是「Whichever is ready」，有 Claude 时优先选 Claude。

建好后右侧会打开 **Bot settings** 面板，左侧 bot 列表里出现这个 bot。

### 选模型

**Model** 页签：

- **Provider**：选 `Claude`。不可用的 provider 后面会标 `(unavailable)`。
- **Model**：`Provider default` 跟随 Claude Code 自己的默认模型（括号里显示当前解析成哪个）。日常聊天可以选 Sonnet，重活选 Opus。
- **Thinking**：思考强度，`Default` 交给 Claude Code。
- 改动只影响**新开的聊天**，已经开着的聊天保持原来的设置。

每次改设置都会在 **History** 页签留一个快照，可以随时恢复。

## 3. 聊天

在中间的输入框里输入，回车发送（Shift+回车换行）。第一条消息会新建一个聊天，侧栏 bot 下面会出现它，标题取自第一条消息。

聊天界面里能看到：

- **工具调用**：比如 `Shell pwd && ls -la`、`Write MEMORY.md`，点开看输入输出。
- **计时**：bot 在干活时显示 `Working… 12s`，结束后每条回复下面有时间和耗时。
- **上下文占用**：输入框右下角的圆环和百分比，是这个聊天用掉的上下文窗口比例。
- **每条回复**：复制、朗读（浏览器自带的语音，见 **Identity → Voice**）。
- **回到底部**：往上翻了之后，右下角有个按钮跳回最新消息。

### 开场示例（Starters）

还没开始的聊天，开场页在 bot 的简介下面列出几条「可以这样问」。点一条，它的文字会填进输入框（替换已经输入的内容），光标停在末尾，补上想法或路径再发，不会自动发送。

在 **Identity → Starters** 里增删改，每条有两项：要填进输入框的文字，和一行说明它是做什么的（可以不写）；最多 6 条。开场示例只给你看，不进 bot 的 prompt。改动记在 **History** 里，存预设、导出 bot 时一起带走。

侧栏聊天前的小圆点：蓝色闪烁 = 正在干活，黄色 = 等你审批，红色 = 这一轮出错（下一轮正常结束后就不红了），绿色 = 有新回复还没看（打开这个聊天就消失）。已读状态由 pocket-bots 自己记，换个浏览器打开也一样。

### bot 忙的时候再发消息

bot 还在干活时，回车发出的消息怎么处理，在 **设置 → Chats** 里选：

| 选项 | 效果 |
|---|---|
| Steers（默认） | 消息插进正在进行的这一轮，bot 会把它考虑进去，比如「回复最后加一句……」 |
| Interrupts | 打断当前这一轮，从这条消息重新开始 |
| Queues | 排队，等 bot 这一轮做完再自动发 |

**⌘↵**（Windows 上是 Ctrl+Enter）做另一种：默认设置下是排队，选了 Queues 时是打断。用 DeepSeek Harness 的 bot 没有插话这一说，选了 **Steers** 也按 **Queues** 处理：这一轮跑完再发。排队的消息显示在输入框上方，可以编辑、立即发送或删掉。排队靠后端发送，关掉网页也会照发。

### Stop

bot 干活时，输入框右下的 **Stop** 会结束这一轮（Esc 同样有效）；它正在等你审批时，Stop 会先拒绝那个请求。被你停下的这一轮不算失败：侧栏不会变红，每日日志也不记失败，正在跑的命令显示为 Canceled。

### 附件

- 点输入框左下的回形针：**Upload files** 选文件，或 **Paste text** 把一大段文字（邮件、日志）作为附件发，正文保持简短。
- 也可以直接把文件拖进来，或在输入框里粘贴图片、文件。
- 限制：图片 10 MB，文本 1 MB，其他文件 25 MB。
- 图片直接给 Claude 看；CSV、代码等文本附在消息里；其他文件存到 bot 目录的 `uploads/` 里，bot 按路径读取。
- 时间线只保存消息的文字，所以发出去的附件缩略图只在当前浏览器会话里显示，刷新后不再显示，导出的对话记录里也没有。

### 斜杠命令

在空输入框里输入 `/` 会弹出命令列表：pocket-bots 自己的 **/learn**（见[技能](#7-技能skills)），加上这个 bot 用的 agent 自带的命令和技能，比如 **/compact**（把对话总结一下，腾出上下文）、Claude Code 的自定义命令、Codex / OpenCode / Pi 的技能、OpenCode 的 `/review`。上下键选择，回车或 Tab 补全，补全后接着写参数再发送。

- 列表第一次打开时要先连上 bot 的会话，可能要等几秒。
- 命令由 agent 自己执行，效果和在它的终端里输入一样。有些 Claude Code 命令只在它的终端界面里有用（比如 `/config`），在这里发出去没有效果。

### 回复 bot 的某条消息

bot 一次给了好几个结果，想说清楚你指的是哪一个：鼠标移到 bot 的那条消息上，点右上角的回复箭头（**Reply**）。

- 先在消息里选中一段（比如列表里的一项）再点 **Reply**，就只引用选中的这段；不选就引用整条消息（太长的只取前 2000 个字）。
- 输入框上方出现「Replying to …」，写好回复照常发送；点 **×** 或按 Esc 取消。
- 发出去的消息上方显示引用的内容，点它会跳回 bot 的原消息（原消息要已经加载出来）。
- bot 收到的是引用加你的话：开头一行 `Replying to your earlier message:`，接着是 Markdown 引用块（`> …`），空一行后是你写的内容。所以即使它的上下文被压缩过，也知道你指的是哪段。
- 排队的消息也可以是回复，队列里会显示回复箭头。斜杠命令不能带引用（命令要原样交给 agent）。
- 只有 bot 的消息能回复；单聊里没有表情回应。团队 session 里的回复见[团队](#团队)。

### 在聊天里查找（⌘F）

在打开的聊天里按 **⌘F**（Windows 上是 Ctrl+F），或点顶栏的放大镜，顶部出现查找框。它查的是这个聊天的全部历史（不只是已经加载的部分），每个词都要出现，词的一部分也算（输入 `releas` 能找到 release）。

- 从最新的匹配开始，显示「3 of 12」；回车跳到更早的一条，Shift+回车跳回更新的一条，还没加载的旧消息会自动加载。
- 匹配的词在消息里会被标出来。Esc 或 **×** 关掉。
- 团队的 session 里 ⌘F 打开 session 自己的搜索框（见[团队](#团队)）。

### 草稿

没发出去的文字和附件按聊天保存在浏览器里，换聊天、刷新页面都不会丢。

### 聊天菜单

聊天顶栏右边的 **…**（侧栏里每个聊天也有同样的菜单）：

- **Pin to top** / **Move up** / **Move down**：在侧栏里置顶、调整顺序（顺序要在显示设置里选 Manual 才生效，见[侧栏](#14-侧栏)）。
- **Copy chat ID**、**Copy path**（工作目录）。
- **Copy transcript** / **Export transcript**：把对话导出成 Markdown，包括谁说了什么、什么时间、用了哪些工具。
- **Archive chat**：从列表里移走，对话仍保存在 pocket-bots 里；再发一条消息就会接着原来的会话继续。

### bot 在哪里干活

默认每个 bot 有一个自己的工作目录 `~/.pocket-bots/Bots/<botId>/`，里面放 `MEMORY.md`、`memory/`（主题记忆和每日日志）和 `skills/`。Claude Code 就在这个目录里启动。

想让 bot 在你的某个项目里干活，在 **Model → Working folder** 里选 **Custom** 并挑一个文件夹。记忆和技能仍然放在 bot 自己的目录里，pocket-bots 会告诉 Claude Code 这些目录也归它用，读写记忆不会因为「在工作目录之外」而弹审批（这对 Claude 和 Codex 成立，Codex 是在 Auto 模式下；OpenCode、Pi、Grok、DeepSeek Harness 没有这个功能，读写工作目录之外的记忆和技能仍可能弹审批）。

**只给某个聊天换目录**：同一个 bot 在不同的仓库里干不同的活时，不用改 bot 的设置。新聊天的输入框左下角有个 📁 按钮，默认是 **Bot's folder**（bot 自己的工作目录）；点开从用过的目录里选（bot、群和最近的聊天用过的），或者 **Other folder…** 填一个绝对路径，比如 `/Users/me/code/my-repo`（`~/` 也行）。发出第一条消息时，这个聊天就在那个目录里启动。目录必须存在，不在就发不出去，提示哪里不对。选过的目录按 bot 记在浏览器里，这个 bot 的下一个新聊天也默认用它，点开选 **The bot's folder** 换回去。聊天开始以后，主目录就定了，不能再换：输入框里显示它在哪个目录（悬停看完整路径），**Copy path** 复制。要换主目录就开新聊天。记忆和技能照样放在 bot 自己的目录里，读写不弹审批。

**给聊天再加几个文件夹**：主目录之外，聊天还能同时用别的文件夹（比如一个仓库改代码，另一个仓库查资料）。新聊天的输入框里，📁 旁边的 **+**（**Add folder**）从用过的目录里选，或者 **Other folder…** 填绝对路径；加进去的显示成带 × 的小标签，开聊天时一起带上。已开的聊天也一样，随时 **+** 加、× 去掉，不用开新聊天：会话接着原来的往下走，不丢上下文。聊天空闲时下一条消息就带着新列表继续；正在跑的一轮不被打断，跑完以后再生效。最多 20 个，必须是本机上存在的文件夹，和主目录相同的、重复的会自动去掉。

- Claude 把它们当作自己能访问的附加目录。Codex 把它们加进沙箱的可写目录（Auto、Always Ask 模式），在里面改文件和在主目录里一样；改列表时 Codex 的会话不用重开，下一轮就用新的。OpenCode、Pi、Grok、DeepSeek Harness 不支持这个功能，它们的 agent 照样可以按绝对路径读写这些文件夹：pocket-bots 在 system prompt 里列出路径，列表中途改了，下一条消息前面会带一句说明（聊天里折叠成一行「Extra folders updated」）。这些 CLI 上输入框下面会有一行提示：这个 CLI 会按路径访问这些文件夹，操作可能需要审批。
- 额外文件夹不会自动加进信任的文件夹。Claude 上它和主目录一样：读文件不问，改文件按审批模式来（默认模式会问）；Codex 上也和主目录一样（Auto 模式下读写都不问）；其他 CLI 读文件一般不问，改文件、跑命令可能会问。审批卡的 **Allow in folder…** 里，如果请求在某个额外文件夹里，会把那个文件夹排在前面，一点就信任整个文件夹。
- 群里的座位是普通聊天，但它的额外文件夹跟着群走，在座位的聊天里只能看、不能改，要到群里改。

团队也能设一个目录，它的 session 都在里面干活，见[团队](#团队)。

## 4. 审批

Claude Code 要做需要授权的事（跑命令、写文件、调 MCP 工具）时，聊天里会出现一张卡片，标着 **Waiting for you**，下面有 **Deny** / **Accept**。侧栏对应的聊天会出现黄点。

- 审批模式在 **Model → Permissions → Approval mode** 里设，选项来自 Claude Code：
  | 模式 | 说明 |
  |---|---|
  | Provider default | 用 Claude Code 自己的默认模式，目前是 `auto` |
  | Plan Mode | 只分析不动手 |
  | Always Ask | 每类工具第一次用都要你批 |
  | Accept File Edits | 文件编辑自动通过，命令仍要审批 |
  | Auto mode | Claude Code 用一个分类模型替你审：常规操作直接放行，有风险的才弹卡片 |
  | Bypass | 全部放行，不建议 |
- 在 `auto` 模式下，bot 读写自己的记忆、读技能、跑只读命令一般都不会打扰你；有风险的操作才会弹卡片。想每一步都自己把关，选 **Always Ask**。
- **命令白名单**：shell 命令的审批卡片上有 **Always allow**，点了之后，同一个命令在同一个目录里以后会自动通过（必须完全一致，多一个参数都不算）。白名单在 **Access → Allowed commands** 里管理，只存在本机，不会被导出。
- **信任的目录**：命令和读、写、改、搜文件的审批卡片上有 **Allow in folder…**，从列表里选一个目录（聊天的工作目录排在最前，然后是这次操作所在的目录和它的上级）。之后这个 bot 在这个目录里跑命令、读写改搜文件都不再问，等着的其他审批如果也落在这个目录里，一起放行。命令里写了目录外的路径（`/etc/...`、`~/.ssh`、`../别的项目`）照样会问，here-document 里的文本是写进文件的内容，不算路径；软链接按实际指向算。也可以直接在 **Access → Trusted folders** 里填一个目录。家目录和它的上级太宽，不能选。这是省事的办法，不是沙箱：命令仍可能以字面上看不出的方式碰到目录外。只存在本机，不会被导出。

## 5. 记忆

bot 的长期记忆是它工作目录里的 `MEMORY.md`。每个新聊天开始时，`MEMORY.md` 的前 200 行（最多 24 KB）会放进 system prompt。

### Memory writing 开关

**Memory** 页签顶部有个 **Memory writing** 开关，**默认关闭**：新建的 bot、升级前就有的 bot、导入的 bot 都是关闭的。

| | 关闭（默认） | 打开 |
|---|---|---|
| bot 读记忆（注入 `MEMORY.md`、Recent work、`search_chats`） | 照常 | 照常 |
| 你在 Memory 页签查看、编辑、撤销 | 照常 | 照常 |
| bot 改 `MEMORY.md` 和主题文件 | 不行：这一轮结束时恢复成原样 | 可以 |
| 每一轮结束记每日日志（pocket-bots 自己记，不是 bot 写的） | 照常 | 照常 |

关闭时，system prompt 的 Memory 段会告诉 bot 记忆是只读的：值得记的事告诉你，由你自己加到 Memory 页签，或者请你打开开关。已经记下的内容（`MEMORY.md`）不受影响，仍会进新聊天的 prompt；每日日志也照常记，Recent work 照常更新。

**兜底是「一轮结束时恢复」，不是「写的时候拦住」。** bot 是用各个 agent 自带的文件工具或命令行改文件的，pocket-bots 拦不住这一下。所以每一轮结束时，pocket-bots 把这一轮开始时的 `MEMORY.md` 和 `memory/<topic>.md` 同现在的比一遍：bot 改过的改回去，新建的删掉，删掉的补回来。**Changes** 里会各记一条：bot 做了什么，以及恢复了什么（来源标着 `memory writing is off`）。恢复这一条也能点撤销，把 bot 的版本放回来。

- 开关在一轮结束时读取，所以改了开关，从下一个结束的轮次起生效。
- 开着时让 bot 记东西，直接说：

  > 请记住：我叫小牛，平时用中文交流，喜欢简洁的回答；我在新加坡，时区是 Asia/Singapore。把这些写进你的长期记忆。

- 关着时，上面这句话 bot 会回答你应该把什么加进 Memory 页签，而不是自己写。
- 开关的改动和别的设置一样记在 **History** 里。bot 自己没办法通过「提议」改这个开关。
- 这个开关写在 prompt 的常驻部分：新开的聊天一定带着新写法；群聊座位续接后的第一条输入前会补发；bot 自己的聊天里，Claude Code 和 Codex 续接的老会话会忽略新传的 prompt，继续按开始时的写法行事。老会话里 bot 即使还以为自己能写，一轮结束时也会被恢复。
- 同一个 bot 同时在跑好几个聊天（群聊座位、私聊、定时任务）时，bot 在任何一个里写的改动，都在某个聊天结束时被恢复。
- 局限：恢复只在一轮结束时发生，轮次进行中文件里是 bot 改过的样子；一轮的开始没被看到（后端重启期间结束的轮次）时没法恢复；`memory/log/` 里的每日日志不在恢复范围内；你在轮次进行中用编辑器直接改 `MEMORY.md` 或主题文件，会被当成 bot 的改动恢复掉，不过 Changes 里有这条恢复记录，可以撤销（经 Memory 页签做的编辑不受影响）。

### Recent work 开关

Memory writing 下面是 **Recent work** 开关，**默认打开**：新聊天的 system prompt 里有一段 Recent work，列出最近两天这个 bot 在每个聊天里最后说的话（最多 10 条，每条截到 160 字），让它知道最近在忙什么。

关掉后，新聊天不再带这一段，bot 只知道 prompt 里其余的东西和你这次给它的消息。适合每次都该从头看的 bot。比如一个专门审设计文档的 bot：开着时，它重审改过的文档，prompt 里会先看到自己上次说的「Blocker：去重键没有定义」，容易变成核对上次的意见改了没有，而不是把文档当新的来读；关掉就没有这个问题。

- 只影响之后新开的聊天，已经开着的聊天保持开始时的样子。
- 每日日志照常记，Daily log 里照常能看；bot 想翻的话 `search_chats` 照常能用，`MEMORY.md` 照常注入。
- 开关的改动记在 **History** 里；导出 bot 时带着这个设置，导入后还是一样。

### Memory 页签

bot 的记忆之后在 **Memory** 页签里能看到：

- **Files**：`MEMORY.md` 和主题文件（`memory/<topic>.md`），可以直接编辑保存，也可以 **Add topic** 新建主题文件。主题文件不会自动进 prompt，bot 需要时自己读。
- **Daily log**：pocket-bots 在每一轮结束时自动记一行（时间、哪个聊天、bot 说了什么、用了哪些工具）。这是 pocket-bots 自己的记录，不受 Memory writing 开关影响。最近两天的最新几行会作为「Recent work」进新聊天的 prompt，bot 也能用 `search_chats` 工具翻。
- **Changes**：记忆文件的每次改动（bot 改的、你改的、关闭开关时被恢复的），点撤销按钮就能恢复成改之前的样子。

> 记忆日志、撤销记录都是 pocket-bots 后端在每轮开始和结束时记的，所以后端要一直开着。后端停机期间结束的轮次，重启后会补上日志。

## 6. Bot 设置面板

点聊天顶栏右边的面板按钮打开或收起。共九个页签：

| 页签 | 内容 |
|---|---|
| Overview | 概览、用量统计、「Set up with the bot」引导、导出、复制、存为预设、删除 |
| Identity | 名字、角色、简介、开场示例、头像、朗读用的声音 |
| Soul | 常驻指令（Standing instructions）、Playbooks、预览 system prompt |
| Model | provider、模型、思考强度、审批模式、能否联系其他 bot、工作目录 |
| Skills | 从技能库里给这个 bot 勾选技能 |
| Access | MCP 服务器、连接的应用、命令白名单、免审批的工具 |
| Routines | 定时任务和 webhook |
| Memory | 记忆写入开关、Recent work 开关、记忆文件、每日日志、改动记录 |
| History | 设置的历史快照，可恢复 |

### 预览 system prompt

**Soul → Preview prompt** 能看到新聊天会收到的完整 system prompt，按段落分开：Persona（名字、角色、简介）、Standing instructions、Project guidance（所有 bot 都有：让 bot 开始工作前先读工作目录里的 `AGENTS.md`，没有就跳过）、Memory（含当前记忆）、Recent work、Bot tools，有技能、Playbook 时还会多几段；bot 在群聊里的座位还会多一段 Group chat。可以填一条「第一条消息」看看它会匹配哪些 Playbook。

## 7. 技能（Skills）

技能是一个带 `SKILL.md` 的文件夹，写的是「遇到某类任务时怎么做」。所有技能放在一个共用的库里（**Skills & Tools → Skills**），每个 bot 自己勾选要用哪些。

### 新建或导入

- **New skill**：填三项。
  - **Name**：小写加连字符，比如 `standup-note`。
  - **When to use it**：一句话，bot 靠这句话判断要不要读这个技能，写清楚触发场景，比如 `Use when the user asks for a standup note, daily update, or 站会纪要.`
  - **Instructions**：Markdown 正文，写具体做法和格式。
- **Import**：从 GitHub 导入，支持 `owner/repo`、`owner/repo/path/to/skill`、GitHub 文件夹链接或 `SKILL.md` 链接，比如 `anthropics/skills/skills/pdf`。
- **/learn**：在聊天里让 bot 做完一件事后发 `/learn`（可以跟一句重点），bot 会把刚才的做法整理成技能，以提议卡片的形式给你确认。

### 审阅

导入的技能，以及之后在磁盘上被改过的技能，会标成 **Review**：你读过并点 **Mark reviewed and turn on** 之前，bot 拿不到它。技能就是 bot 会照做的指令，所以这一步不要跳过。

### 给 bot 用

在技能详情页底部的 **Bots using it** 里打开对应 bot 的开关，或者在 bot 的 **Skills** 页签里勾选。之后**新开的聊天**里，system prompt 会列出技能名和「When to use it」，bot 判断用得上时自己去读 `skills/<name>/SKILL.md`。

示例：给 Assistant 打开 `standup-note` 后发「帮我写今天的站会纪要：……」，它会先读技能，再按技能规定的三段格式输出。

> bot 读技能文件不会弹审批：pocket-bots 会把这个 bot 用到的技能目录告诉 Claude Code，作为它可以直接访问的目录。

### 随 pocket-bots 发布的技能

有的模板要用的技能是跟着 pocket-bots 一起发布的，现在有 EGM 的 `egm` 和 `egm-goldfish`。它们不会一开始就在技能库里：用 Elephant 或 Goldfish 模板建 bot 时（或者你在提议卡片上确认建这种 bot 时），pocket-bots 才把文件夹复制进技能库，并直接算已审阅，因为它们是作为 pocket-bots 的一部分审过的。来源一栏写着 `pocket-bots`。

放进来以后它们就是普通的技能：可以勾给别的 bot，也可以改。

- 你没改过：pocket-bots 更新后启动时，换成新版本，仍然算已审阅。
- 你改过：一直保留你的版本，也不再自动更新；和别的技能一样，改过之后要重新审阅才生效。
- 删掉了：之后再用模板建 bot，会重新放进来。

## 8. MCP 服务器

MCP 服务器给 bot 增加工具。和技能一样，服务器放在共用的库里（**Skills & Tools → MCP servers**），每个 bot 自己选。

### 添加

- **New server**：选类型。
  - **Command (stdio)**：一条命令，比如 `npx -y @modelcontextprotocol/server-github`。它在这台电脑上由 bot 用的 agent 启动。
  - **HTTP** / **SSE**：一个 URL，可以加请求头。
  - **Environment / Headers**：每行一个 `KEY=value`，用来放 token。这些值保存在 pocket-bots 的设置里，也会写进每个聊天的 MCP 配置，导出时会被隐去。
- **Import config**：粘贴 Claude Code、Cursor 或 `.mcp.json` 里的 `{"mcpServers": {...}}`。如果这台电脑上的 Claude Code、Claude Desktop 或 Cursor 配过 MCP 服务器，这里会直接列出来让你挑。

新加的服务器默认是**关闭**的。点 **Test and turn on**：pocket-bots 会在本机启动它、列出工具，连得上才打开。之后随时可以 **Test again**。

服务器名就是工具名的前缀：名为 `clock` 的服务器，工具在 bot 那边叫 `clock/now`（在 Claude Code 里显示为 `mcp__clock__now`）。

### 给 bot 用

1. 在服务器详情页的 **Bots using it** 打开对应 bot，或者在 bot 的 **Access → MCP servers** 里打开。
2. **Access** 里每个服务器下面列着它的工具。勾上某个工具，表示这个 bot 调用它时**不用审批**。下面的 **Always allowed tools** 文本框是同一份列表，每行一个 `服务器/工具`。
3. 新开的聊天就能用了。

> 所有 agent 的审批都由 pocket-bots 自己回答，所以勾上的工具在六个 agent 上都免审批。在 Claude 的 `auto` 模式下，没勾的工具也可能被 Claude Code 的自动审批放行；想每次都问，把 bot 的审批模式设成 **Always Ask**。

## 9. 定时任务（Routines）

定时任务让 bot 按计划或在收到 webhook 时自己干活。每次运行都开一个**新聊天**（标题是任务名），干完后可以把结果卡片贴到你指定的聊天里。

### 两种建法

- **让 bot 提议**：在聊天里说「请提议一个定时任务：每个工作日 9 点……，结果发到这个聊天」。bot 会调用 `propose_routine`，聊天里出现一张卡片，显示名称、计划、下一次运行时间和要做的事，点 **Create routine** 才会真正创建。
- **自己建**：**Routines → New routine**。
  - **Name**、**What to do**（每次运行发给 bot 的第一条消息，要写得脱离上下文也能看懂）。
  - **When**：
    | 选项 | 说明 |
    |---|---|
    | Days | 每周哪几天的几点 |
    | Every | 每隔 N 分钟（5 到 1440） |
    | Cron | 五段 cron 表达式，本地时间，带几个常用预设 |
    | Once | 某个时间点只跑一次，格式 `YYYY-MM-DD HH:MM` |
    | Webhook | 收到 POST 时运行 |
  - **Post results to**：选这个 bot 的一个聊天，每次运行都会在那里贴一张结果卡片；选 Nowhere 就只在 Routines 页签里看。

### 查看和管理

**Routines** 页签顶部的 **At a glance** 列出未来 7 天的运行计划和最近几次运行，点一条就能打开那次运行的聊天。每个任务有开关、**Run now**（立即跑一次）和菜单（编辑、删除、webhook 地址）。

结果卡片显示任务名、状态（Done / Failed / Missed / Skipped）、触发方式、时间和 bot 回复的摘要，**Open the run's chat** 打开完整对话。

上一次运行还没结束时，新的定时触发会被跳过（Skipped）。后端停机期间错过的运行，如果在 12 小时以内，重启后会补跑一次；更早的记成 Missed。

### Webhook

1. 新建一个 **When = Webhook** 的任务。
2. 保存后在任务菜单里点 **Copy webhook URL**（或者 **New webhook URL** 换一个新密钥，旧地址立即失效）。如果浏览器不让写剪贴板，会弹出对话框显示地址，手动复制即可。
3. 用 POST 调用它，请求体会作为数据附在这次运行的消息后面：

   ```bash
   curl -X POST -H 'content-type: application/json' \
     -d '{"event":"deploy","service":"pocket-bots","status":"ok"}' \
     http://127.0.0.1:<relay 端口>/hooks/<routineId>/<secret>
   ```

   返回 `{"status":"running","chat":"<聊天 id>"}`。

- 地址只监听 `127.0.0.1`，外部服务要调用得自己做转发（反向代理、隧道等）。
- 请求体会被标成「不可信的外部数据」交给 bot，bot 只把它当数据用，不会照着里面的指令做事。
- 限流：每个任务每分钟最多 10 次调用，同时最多 3 次运行在跑。请求体最大 256 KB。

> 定时任务由 pocket-bots 后端调度，后端不在跑的时候不会触发。

## 10. 团队和 bot 之间协作

### 团队

你把一个任务交给几个 bot、要它们分工做完再把结果交给你时，用团队。团队里有一个 leader 负责计划、派活和把关，你不用自己指挥。规则和原因见 [docs/group-chats.md](group-chats.md)。

**新建团队**：侧栏 **Teams** 旁边的 **+**（或首页的 **New team**）→ 勾选 2–6 个 bot → **Leader** 选其中一个 → 名字可以不填，默认用 bot 的名字拼成（比如「Lena, Dev, Ezra +1」）→ **Create**。每个 bot 的角色写在它自己的设置里（标题和描述），leader 按这些决定谁做什么。之后在团队页的齿轮（**Team settings**）里可以改成员、leader、名字、说明和目录。

**团队说明**（**Instructions**）：团队里每个 bot 都要遵守的话，比如「改完要跑 npm test」「交付时写清改了哪些文件」。每个 session 里每个 bot 的 prompt 都带上它，放在角色规则后面；bot 自己的指令照样有效。

**工作目录**：几个 bot 一起改同一个仓库时，**Working folder** 填仓库的路径（绝对路径或 `~/`，会提示用过的目录）。之后这个团队每个 session 里的每个 bot 都在这个目录里干活；空着就是各自用 bot 自己的工作目录。记忆和技能还在各自 bot 的目录里。**Extra folders** 是每个 bot 还能用的别的文件夹（比如参考资料的仓库），用法和限制同聊天的额外文件夹（Claude、Codex 原生支持，其他 CLI 靠路径访问、可能弹审批）。

**开一个 session**：点侧栏的团队（或团队旁边的 **+**）进团队页。页面上有成员、团队说明和工作目录，在下面的输入框写任务、发送。发送就开了一个 session：一个用任务开头命名的群聊，任务是它的第一条消息，列在侧栏的团队下面。

- 一个任务一个 session。做完以后 session 留着，和 bot 的聊天一样：之后可以回到里面追问、要求返工，bot 的座位还记得上下文。session 菜单里可以改名、删除。
- 改了团队（成员、leader、说明、目录），只影响之后开的 session；已经开的 session 保持开始时的样子。
- 这一次要在别的目录里做，点工作目录旁边的 **Change for this session**。这个目录里正有别的 session 在跑时，页面上会提示：两个 session 会同时改同一批文件。
- session 顶栏下面有一行 **Extra folders**，可以直接 **+** 加、× 去掉。这不算换目录：座位不换新，也不带简报，空闲的下一条消息、正在跑的等这一轮结束后用新列表。改的时候 session 里记一条「📁 the user set the group's extra folders to …」，不叫醒谁。
- 任务里可以带图片和文本文件；别的文件等 session 开了以后再发（文件要放进 session 自己的文件夹，开之前还没有）。

**leader 怎么带团队**：

- 你直接说要做什么，不用 @ 谁：只有 leader 被叫醒。leader 拆好步骤，每一步用一条顶层消息 @ 一个成员，写清楚目标、涉及的文件、约束、做完的标准和要汇报什么。
- **新活是一条新的 @ 消息，老活的迭代在它的线程里**：成员每接一件新活，都开一个新会话，不带之前任何活的上下文，那条消息就是全部说明（直接放在叫醒它的那条输入里，不用它再去读）。它认领、做完，在这条消息的线程里 @ leader 汇报。leader 不满意，就在同一个线程里 @ 它说要改什么，线程就是这件活的上下文；满意了，leader 把任务标成 done，下一件活再发一条新的 @ 消息。
- **一件活一个会话，一次做一件**：成员的每件活都有自己的会话。它一次只在一个会话里干活：正在做这件时，派给它的下一件、别人在别处找它的消息都先等着，这一轮结束后再切到对应的会话。不同的成员可以同时干活；几件活要改同一批文件时，leader 会按顺序派：大家都在同一个目录里干活。
- **回到老活就回到它的会话**：leader 在老线程里又 @ 成员（哪怕它中间做过别的活），还是那件活的会话接着做，它记得之前做到哪。这个会话空闲超过一小时、上下文又很大时，换一个新会话，带上这件活的简报。
- 成员只在这几种时候被叫醒：leader 或你派活给它、回复它、给它派任务，或者另一个成员找它。别的消息到不了它。你或 leader 发的 @everyone 会送到它，进它当前的会话，不另开一个。它不发「收到」「进度」这类消息，不改任务状态（由 leader 定）；卡住了就在线程里问派活给它的那个。
- **成员之间直接找**：消息发在哪里，对方就在哪里的上下文里处理。不管在哪里问，答案都回到发问的那件活的会话。
  - **默认：在顶层发请求**。写清楚要什么，比如「@Ezra 列出所有 import theme.ts 的文件和行号」。对方开一个新会话来做，在这条请求的线程里回答；需要它自己做过什么时，它自己去查。开发拿到答案后接着做 #2，来回几轮都在这条请求的线程里。这条请求在群里标着 **for #2**，点它打开 #2 的线程。
  - **要对方了解这件活**：在这件活的线程里 @ 它，比如开发在 #2 的线程里问 explorer「这次要改的参数解析在哪」。只叫醒被问的那个；它为 #2 开一个会话（不打断它手上的活），带上 #2 线程的内容，在 #2 里回答。之后在 #2 里再 @ 它，还是这个会话。
  - **问的是对方手上那件活，而且知道那件活的编号**（leader 的派活说明里写了，或者别人的回答里提到了）：在那件活的线程里 @ 它。它在做那件活的会话里回答，正忙就插进当前这一轮。成员不会为了这个去翻群找别人的活：不知道编号就在顶层发请求。leader 派活时，预计成员要找谁，会把对方那件活的编号写进说明。
  - **在 #2 里看得到去了哪**：#2 的线程里会按时间插一行链接，比如「↗ Dev asked Ezra in #7: …」「↗ Dev asked Quinn in a request, #9: …」，点它打开那个线程。这只是界面上的链接，bot 看不到；成员自己会在汇报里写清从谁那里拿到了什么、在哪里，leader 读 #2 就知道依据。
  - 请求不是任务，不用认领。整件活要换人做，告诉 leader。成员的 @everyone 只到 leader。leader 不会被这些来回叫醒，它读那些线程时能看到。
  - 成员只在需要对方做点什么时 @ 它，不说「谢谢」「收到」：每个 @ 都会叫醒对方。
- **验证**：成员做完先尽量自己验证（跑覆盖它的测试、试一下改的东西、再看一遍改动），汇报时说清验证了什么、怎么验证的（跑了哪些命令、结果如何），哪些没验证或没法验证。leader 不重复成员做过的检查，自己判断还要不要再验证：小的（一条命令、看一眼文件）自己做，大的（补测试、整体 review）派给成员，并说清已经验证过什么，免得重做。
- 适合按模型分工省额度：比如 leader 用 Opus 计划、遇到卡住时给方向，开发用 Sonnet 写代码，探索用 Haiku 搜文件，QA 写测试、跑测试。leader 的 prompt 里列着每个成员的介绍和用的模型，它按这个派活；每个成员的 prompt 里列着别的成员是做什么的，它知道该问谁。成员之间的问答不经过 leader，用的是便宜模型之间的来回。
- 成员的座位只带干活用得到的规则和工具（发言、读、搜群里的消息、认领、表情回应、看成员、搜自己的聊天），不带任务、提醒、改配置这些，每次请求少带很多 token。成员派到的活自己做，不再整件交给子 agent。
- 你的请求全部做完后，leader 回复你那条请求，写结果、验证过什么、怎么验证的，以及没验证或遗留的事，所以结论就在你提问的地方。派活、汇报、返工这些过程在各件活的线程里，想看再点开。
- 成员在一件活上出错了（比如被限流），或者为这件活开不了新会话（比如 CLI 起不来），这件活的线程里会出现一条 @ leader 的提醒，leader 决定让它接着做还是交给别人；只有你能处理的错误（比如没登录），leader 会告诉你。
- 你随时可以直接 @ 某个成员。

@ 只送到 session 里的成员。bot @ 了一个不在团队里的 bot，或者写错了名字，发出后会被告知这一下没有送到任何人：只有你能把那个 bot 加进团队（**Team settings**，之后开的 session 里才有它）。bot 也能查自己某条消息里 @ 的人收到没有、读了没有（`group_mention_delivery`）：还在路上就不催；对方被限流、座位起不来，就换人或者晚点再找。

**bot 出错的时候**：bot 被限流、或者它的服务端出错，它先歇一会儿（10 秒起，连着出错就翻倍，最多 5 分钟），这期间的消息攒着，歇完一起告诉它。同样的错误连着 3 次，群里记一行「X stopped after 3 repeated runtime errors…」，之后不再叫醒它；问题解决后在群里 @ 它，它就重新开始，攒下的消息一起告诉它。座位起不来（比如那个 CLI 没装、没登录）也一样：试几次后停下、记一行，修好后 @ 它。

一个好用的任务：说清要什么、做完的标准，分工交给 leader。

> 给 textkit 加一个 `--version` 参数，输出 package.json 里的版本号，补上测试。改完跑 `npm test`，告诉我改了哪些文件。

**不抢答、不重复**：bot 发言、认领、改任务状态之前，pocket-bots 会检查它的模型有没有看过要发的地方（顶层或某个线程）的新消息。没看过的话，这条先存成草稿，bot 看到新消息后再决定是改一下、原样发、丢掉还是不发。几个 bot 同时想回答一个问题时，先发的那个算数，其他的看到后一般就不再重复。

**任务**：成员接到 leader 派的活，先认领那条消息，它就成了一个任务（task #12 就是消息 #12），消息下面显示「task #12 · In progress · Dev」。认领是一把锁：别的 bot 认领不到，就不会重复做同一件事。成员做完在线程里汇报，leader 核对后改成 **Done**；不做了是 **Closed**。

- 消息上的任务按钮（清单图标）：**Claim: I'm doing it**（你自己来）、**Make it a task**（先记下来，没人负责）、**Assign to …**（交给某个 bot，它认领了才算开始）。指派只在任务的线程里记一行，不会单独通知这个 bot；要它马上开工，在群里 @ 它。
- 点任务标签可以改成任何状态、**Unclaim**（放下：去掉负责人，状态不变；Done 的任务不能放下）、改派，或者 **Remove task**（只去掉任务，消息留着）。
- session 顶栏的清单按钮打开**任务看板**：按 In progress / To do 分组，点一条跳到那条消息；Done 和 Closed 默认收起。看板下面列出 bot 们定的提醒（见下面的「提醒」）。
- 发消息前点输入框里的 **As task**，这条消息发出去就是一个任务（To do、没人负责），不另记系统消息。只在顶层能用。
- leader 也可以用任务拆活：把一件大事拆成几个能并行的部分，各给一个负责人（同时在群里 @ 他们）。
- 把消息变成任务、bot 建任务，会在群里记一行灰色的系统消息；改状态、你认领、放下、指派，记在任务自己的线程里，打开线程能看到来龙去脉。bot 自己认领不记，看任务标签就知道。
- 任务有自己的**卡片**：标题（一开始就是那条消息）和描述。bot 可以改卡片，比如负责 review 的 bot 补上验收标准；消息原文不变，bot 读到这条消息时会看到改过的标题和描述，任务看板显示改过的标题。改卡片、认领、放下、指派、改状态，每一次都记在任务的历史里，bot 用 `group_task history` 能按顺序看到谁在什么时候改了什么。界面里还不能改卡片。
- bot 只能删自己建的任务（去掉任务，消息留着），别人建的它会建议关掉（Closed）；你能删任何任务。

**表情**：鼠标移到消息上点笑脸按钮，选一个表情回应，代替「收到」「好的」这种消息；不会叫醒任何 bot，bot 下次读群消息时能看到。点消息下面的表情可以加上或撤回你的那一个。

**线程**：鼠标移到一条顶层消息上，点对话气泡按钮（**Reply in thread**），右侧打开这条消息的线程，在下面的输入框里回复；有回复的消息下面会显示「3 replies · 5m ago」，点它打开。

- 线程里的消息只送给关注这个线程的 bot：顶层消息的作者、在线程里说过话的、在线程里被 @ 的。团队里，只有被 @、被回复的会被叫醒，其余的等它读这个线程时看到。想把某个 bot 拉进来，在线程里 @ 它。
- bot 觉得线程的事做完了，可以自己取消关注，线程里会记一行它为什么不再关注；之后在线程里 @ 它会让它重新关注。
- 你发的消息有了回复、你回复过的线程有了新消息时，线程链接旁边会有一个小点，打开线程就算读了。
- 线程里的消息不能是任务，任务是它的顶层消息。
- 适合放支线讨论、一件事的来回细节，主对话保持清爽。线程里不能再开线程。

**提醒**：bot 要等一件现在还没发生的事（构建跑完、明早再看一次结果），会给自己定一个提醒，挂在相关的那条消息上，到点只叫醒它自己；要告诉别人，它到时候在群里 @ 对方。你也可以直接让它「半小时后提醒我看一下」。它定的提醒可以推迟、改、取消，也可以每隔多久、每天几点、每周几几点重复。任务看板下面的 **Reminders** 列出还没响的提醒：谁定的、什么时候响、挂在哪条消息上，点一条跳到那条消息。这里只能看，要改就跟那个 bot 说。pocket-bots 没开着的时候到点的提醒，下次启动时补响一次。

**回到原来的位置**：离开一个群再回来，会回到上次看到的位置，而不是跳到最底下；下面有新消息时，右下角的按钮显示有几条新的，点一下到底部。

**搜索**：点 session 顶栏的放大镜（或按 ⌘F），输入词（三个字以上用全文索引），列出匹配的消息，点一条跳过去，更早的消息会自动加载；线程里的消息会打开它的线程。要跨所有 session 和单聊找，用 [⌘K](#15-搜索和跳转k)。

**bot 怎么知道有新消息**：群里有新消息时，bot 收到的只是一条提示（哪里有几条新消息、有没有人找它），消息本身由它自己去读，所以在它的座位里能看到它先调用 `group_read` 再决定说不说话。正在干活的 bot 也只收到这条提示，不会被打断，你直接 @ 它也一样；它做完手上的事再读。它也可以用 `group_inbox` 看哪些地方有没读的。

**成员之间来回**：成员之间的问答没有次数上限。如果发现两个成员来回问个没完，在那件活的线程里说一句让它们停下，或者告诉 leader。

**bot 在群里的那一面**：每个 bot 在每个群里有一个自己的聊天（座位），用这个 bot 自己的模型、审批、技能和工具干活，群里只显示它用 `group_send` 发出来的消息。团队里，leader 只有一个座位；每个成员每件活一个座位（见上面的「一件活一个会话」）。

- 输入框上方会显示谁在干活（**Writer is working…**，团队成员是 **Writer is working on #2…**）、谁在等你审批（**Writer needs your approval**），点一下进它的座位。
- 审批、要你填的密钥、登录这些都在座位里处理，不出现在群里。bot 问你的问题例外，出现在群里（见下面的「bot 问你问题」）。
- session 菜单里的 **X's side**（团队成员是每件活一项，**X's side · #2**）、bot 消息上的 ↗ 按钮也能进座位。座位不出现在侧栏 bot 的聊天列表里，打开后顶部有一条说明，可以跳回群。
- 在座位里直接打字，是只对这个 bot 说，不进群。
- 座位里，群发来的提示折叠成一行 **Group chat · 群名**。bot 的指令、记忆写入开关这类常驻 prompt 改了以后，用 Claude Code、Codex 的座位续接时第一条输入前会补发新的 prompt，显示成折叠的一行 **Instructions updated**，点开能看到补发的内容。
- 用 Claude、Codex、DeepSeek Harness、OpenCode、Grok Build 的 bot 能开子 agent。团队里，leader 把动手的活派给成员，不交给子 agent；成员自己做派给它的活，只有能拆成几块大的、值得并行的才开子 agent，子 agent 不在群里说话。用 Pi 的 bot 没有子 agent。
- 座位空闲超过一小时、上下文又很大时，下次被叫醒会换一个新座位，带上一份简报：最近的群消息、它正在用的文件（重新读的当前内容）、最近做过的操作，以及它还没完成的任务：比续用一个冷掉的大上下文便宜。
- pocket-bots 重启后，还有未读消息的 bot 会各收到一条补课提示：把未读读一遍就停，只有明确找它的事才处理。

**bot 问你问题**：bot 遇到只有你能定的事（几个方案选哪个、它查不到的事实），会用它自己的提问工具问你：Claude 的 `AskUserQuestion`、OpenCode 的 `question`、Grok Build 的 `ask_user_question`（DeepSeek Harness 没有提问工具）。问题出现在群里，是这个 bot 的一条消息，显示成一张卡片，标着 **Waiting for you**：选好选项（或者在 **Something else…** 里自己写）点 **Submit**，答案回到问的那个 bot，它接着干活；不想答就点 **Dismiss**。答过以后卡片上显示 **Answered** 和你的回答。

- 问题只是给你的：它不叫醒别的 bot，也不算它们的未读；别的 bot 读群消息时能看到问题和你的回答。
- 在它的座位里回答也一样，群里的卡片跟着变。bot 这一轮没等到回答就结束了（比如你停了它），卡片显示 **Not answered**，不能再答。
- 要你填密钥这类的问题（Codex 标成 secret 的）不进群，和审批一样在座位里，群里显示「X needs your approval」。
- Codex 只在 plan 模式下才有提问工具（`request_user_input`），pocket-bots 的 Codex 不用 plan 模式，所以一般不会问；Pi 没有提问工具。

**附件**：你在群里发的消息可以带图片、文本和文件，被叫醒的 bot 会连同附件一起收到。bot 发言也可以带文件：`group_send` 带上本机的文件路径（最多 6 个，限制和你的一样：图片 10 MB、其他文件 25 MB），文件复制到群的文件夹里，在群里和你的附件一样显示（图片显示缩略图，其他文件显示文件名）。别的 bot 收到这条消息时也收到这些文件：读群消息时看到每个文件的名字、类型和路径；被拉进线程、重启补课时，文件随消息一起给它（图片给模型看，文本文件附在消息里，其他文件给路径）。bot 之间的交接以文字为主：bot 的消息必须有文字，说清楚每个文件是什么、要对方做什么；只发文件不发文字会被拒绝。

**删除 session 和团队**：session 菜单 → **Delete session**，消息会删掉，每个 bot 的座位归档，bot 本身不受影响。团队菜单 → **Delete team**，它的 session 一起删掉，bot 本身同样不受影响。

### bot 找 bot 帮忙（私下）

每个 bot 都有 `list_bots`、`ask_bot`、`check_chat` 工具：它可以看有哪些 bot，把一个问题交给另一个 bot（对方会开一个新聊天，标题是「发起者: 问题」），再取回答案。不需要公开的一对一交接用这个，群聊里的 bot 也能用。

`ask_bot` 最多等约 50 秒（MCP 客户端一分钟左右就会放弃一次工具调用）。对方在这之内答完，答案直接回到这一轮；超过的话，对方答完后答案会作为一条消息自动送回发起的聊天，发起的 bot 收到后开新的一轮接着处理（转述给你，或者继续下一步）。发起的聊天正忙的话，这条消息先排进队列，等它空闲再送。转成自动送回之后，`check_chat` 只看一眼当前状态，不再等待，bot 会告诉你答案在路上，然后结束这一轮。bot 用 `check_chat` 先看到答案的，就不会再送一遍。

**Model → Contact other bots** 控制 `ask_bot`（群聊里的发言不受它限制，把 bot 拉进群就是允许它在群里说话）：

| 选项 | 效果 |
|---|---|
| Ask first（默认） | 每次 `ask_bot` 都按审批规则走（`auto` 模式下由 Claude Code 判断，Always Ask 下弹卡片） |
| Allowed | 直接问，不用审批 |
| Off | 不能找别的 bot |

示例：对 Assistant 说「请把这个问题交给 Scout：用两句话解释什么是 MCP，拿到回答后转述给我」，Assistant 会调用 `ask_bot`，Scout 那边多出一个聊天，Assistant 拿到回答后转述给你。

被问的 bot 默认在它自己的工作目录里开聊天。发起的 bot 可以让它在**发起的聊天的目录**里开（`ask_bot` 的 `in_my_folder`），比如请它审一份项目里的文档：对方就能按相对路径读、搜这个项目的文件，Claude Code 也不会每读一个文件弹一次审批。发起的聊天开在发起者自己的 bot 目录（那里有它的记忆）时不能这样用，bot 会被告知改用绝对路径。

### 先设计再写代码（EGM）

[Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model)（EGM）是 Google 开源的一套做法：功能先写成设计文档，再交给没有上下文的审阅者挑刺，最后由你决定改什么，批准后才写代码。pocket-bots 用两个 bot 实现它：

- **Elephant**：你的设计伙伴，带着你们讨论的全部上下文，起草和修改文档。
- **Goldfish**：审阅者。Elephant 每派一个审阅任务，它就开一个新聊天，只读任务里写的 persona、评审标准和文件，看不到你们的讨论，也不带 Recent work。

**准备**

1. **New bot → Elephant**，工作目录可以不改：每个聊天开始时在输入框的 📁 里选项目目录就行。
2. **New bot → Goldfish**。有 Codex 或 DeepSeek Harness 时它会用上，并设成 Read only；没有的话用默认的 agent，设成 Always Ask：读文件不问，写文件会弹卡片（它按指令不该写），拒绝即可。
3. 两个 bot 的技能、开关都已设好，不用再动。
4. Elephant 在 Claude 上默认是 Always Ask，每写一份 brief、草稿或报告都会弹一张审批卡。第一次弹卡时点 **Allow in folder…**，选项目目录：之后它在这个项目里读写文件、跑命令都不再问（命令写了目录外的路径照样问）。只想放行改文件、不想放行命令的话，改成在 **Model** 页签把审批模式设为 **Accept File Edits**。

**用法**：在 Elephant 的新聊天里（开场页有示例可以点）：

| 说 | 做什么 | 产出 |
|---|---|---|
| `egm brainstorm 给项目加 webhook 投递` | 一次问一个问题把想法问清楚；你确认后，6 个金鱼从 YAGNI、成本、易用性、迁移、可观测性、维护负担挑刺 | `concepts_brief.md` |
| `egm draft` | 把 brief 逐节写成设计文档，每节等你批准；有多个合理方案的决定交给你选 | `design_draft.md`，定稿后存到 `docs/designs/` |
| `egm review docs/designs/webhooks.md` | 先选模式，再分 5 个阶段审：zoom-out、新人能否看懂、设计、再 zoom-out、实现计划 | 每阶段一份报告 |
| `egm resolve` | Elephant 逐条判断审阅意见（反驳要有金鱼能读到的证据），你决定改哪些 | `goldfish_review_report.md`，改好的文档 |
| `egm drift report docs/designs/` | 对比设计文档和现在的代码，只报不一致的地方（不需要金鱼） | `日期_DRIFT_REPORT.md` |

审阅时 Elephant 一次发出一个阶段的全部任务，告诉你在等几个审阅者，然后结束这一轮；答案一条条送回来，到齐后它写报告、问你怎么继续。每个审阅者的回答最后有一行 `Read:`，列出它读过的文件和搜过的代码，报告里跟着它的意见一起写，看得出一条关于代码的意见是对照什么得出的。每个任务在 Goldfish 下面是一个聊天，可以点进去看它读了什么。

文件默认写在 Elephant 聊天的目录里；想放到别处，在消息或项目的 `AGENTS.md` 里写一行 `EGM artifact directory: .dev/egm`。

**几点说明**

- 命令前面不要加 `/`：`egm …` 是普通的话，由 Elephant 的技能识别；`/` 开头的是 agent 自己的斜杠命令。
- Goldfish 的 agent 额度用完或者连不上模型时，那个阶段的审阅者会出错。Elephant 会告诉你，把这个阶段记成「没审完」，不会当成没问题，报告里也这样写。到 Goldfish 的 **Model** 页签换一个能用的 agent（换成 Claude 的话审批模式选 Always Ask，模板在 Claude 上就是这样设的），再在 Elephant 的聊天里说「Goldfish 换好了，重跑第 9 阶段」（换成没跑完的那个阶段），它会重发这一阶段并更新报告。
- 完整一轮 review 要开 9 个审阅聊天，每个都要读文档、标准和相关代码；Goldfish 用便宜的模型可以省额度，和 Elephant 用不同的模型还能少一些共同的盲点。
- Goldfish 不读 `AGENTS.md`、不用 `search_chats`、不碰记忆，是靠它的常驻指令和技能约束的，不是硬性限制；只读在 Codex、DeepSeek Harness 上由沙箱保证。
- 想每周查一次文档和代码有没有对不上，给 Elephant 建一个定时任务，内容写 `egm drift report docs/designs/`。

## 11. 提议卡片

bot 不能自己改自己的设置、建技能或建定时任务，只能**提议**，你在聊天里的卡片上确认后才生效。卡片有三种：

| 卡片 | 来自 | 确认按钮 |
|---|---|---|
| New skill | `propose_skill`（比如 `/learn`） | **Save skill**：存进技能库、标为已审阅，并给这个 bot 打开 |
| New routine | `propose_routine` | **Create routine** |
| Setup changes | `propose_changes` | **Apply changes** |

要改配置时 bot 先读 `get_setup`（当前的配置和每种改动怎么写），再一次提出全部改动。这些提议只在 bot 自己的聊天里有：群聊里（不管是不是 leader）没有，在群里让 bot 改配置、建定时任务或存技能，它会请你到它自己的聊天里说。

Setup changes 能改的东西很多：建 bot、改 bot 的指令/模型/审批模式/技能/MCP/应用/Playbook、建定时任务、改默认值等。卡片会：

- 逐条列出改动；
- 把要写进 prompt 的文字（bot 的指令、定时任务要做的事、Playbook）**原文**显示出来，确认前能读到 bot 到底会被告诉什么；
- 对扩大权限、删除之类的改动单独列出 **Check these first** 提醒。

点 **Dismiss** 就丢弃。改 bot 设置之前的样子会留在它的 **History** 里。

### Set up with the bot

**Overview → Set up with the bot → Start** 会开一个聊天，bot 一次问一个问题（想让它做什么、你喜欢怎么工作、什么不能做），然后用 Setup changes 卡片提议它自己的常驻指令，再给出一份 `MEMORY.md` 草稿，等你确认后写入。嫌问得多，可以一次说完并告诉它「其余按合理默认直接提议」。

## 12. 连接的应用（Composio）

让 bot 用 Gmail、Slack、GitHub、日历等应用，走的是**你自己的 Composio 账号**：

1. 在 [dashboard.composio.dev](https://dashboard.composio.dev) 建一个项目，从项目的 **Settings → API Keys** 复制 project API key（`ak_…` 开头）。不要用 **Sessions & API Key** 里的 consumer key（`ck_…`）：它只能给 MCP 客户端用，pocket-bots 调的是 Composio 的 REST API。
2. **Skills & Tools → Connected apps → Connect**，粘贴 key。key 只存在本机（`composio.json`，权限 0600），不会交给 bot。
3. 在应用列表里连接你要用的应用并登录。同一个应用可以连多个账号（比如工作和个人），可以给账号起名。
4. 在 bot 的 **Access → Connected apps** 里给它打开需要的应用，并选：
   - **Tools**：全部、只读，或者手动挑几个工具；
   - **Account**：固定用某个账号，或者让 bot 按名字自己选。

bot 通过 pocket-bots 本地的 relay 调 Composio，relay 只放行你给这个 bot 打开的应用和工具。

## 13. 管理 bot

都在 **Overview → Manage**（侧栏 bot 的右键菜单里也有）：

| 操作 | 说明 |
|---|---|
| Export | 导出一个 bot 文件：身份、指令、模型、技能、MCP 服务器、Playbook、定时任务（导入后是暂停的）。MCP 配置里的密钥会被隐去 |
| Export with memory | 同上，再加上 `MEMORY.md`、主题记忆和每日日志 |
| Duplicate | 复制一个「xxx copy」，记忆不复制 |
| Save as preset | 存成预设，之后 **New bot** 里能直接从它开始；预设在 **设置 → Presets** 里删 |
| Pin to top | 在侧栏置顶 |
| Hide from sidebar | 从侧栏的主列表拿走，放进底部的 **Hidden bots**；bot 照常工作：定时任务照跑，也照样能开新聊天、进群聊、被别的 bot 找。**Show in sidebar** 放回来 |
| Archive | 归档：从列表隐藏，不能再开新聊天，定时任务也不跑；随时 **Restore** |
| Delete bot | 删除设置和定时任务，它不再参与所在的群聊；它所在的团队要在 **Team settings** 里把它去掉才能开新 session；聊天留在 pocket-bots 里，记忆文件留在磁盘上 |

### 导出和导入

- 导出的文件格式是 `"format": "pocket-bots"`；改名之前导出的旧文件也能导入。
- **New bot → Import**：选文件或直接粘贴 JSON，可以是单个 bot，也可以是多个 bot 的文件（**设置 → Back up** 导出的；旧文件里的团队不会导入）。导入的 bot 是新 bot，名字冲突时自动加编号（比如「Scout 2」），Memory writing 开关是关闭的。库里已有的同名技能、同名 MCP 服务器会直接复用；新带进来的技能要先在 **Skills & Tools** 里审阅才会生效，新的 MCP 服务器要先测试才会打开。
- **设置 → Back up → Export all bots / Export with memory**：所有 bot 打成一个文件，适合备份或搬到另一台电脑。团队和 session 不在里面。

### 历史

**History** 页签保存这个 bot 最近 20 次设置改动之前的样子（一分钟内的连续修改算一次）。每条显示和现在相比哪里不同，**Restore** 恢复。恢复本身也会被记下来，所以恢复错了可以再恢复回去。

## 14. 侧栏

- **Teams**：最上面是团队，每个团队显示成员头像和 leader，下面列出它的 session，和 bot 下面列聊天一样（最近 20 个，多了有 **Show all**）；每个 session 有状态点（有 bot 在干活、在等审批、或有新消息），团队的状态点汇总它的 session。**Teams** 旁边的 **+** 新建团队，团队旁边的 **+** 开新 session，团队和 session 的菜单里能改设置、改名、删除。点标题可以折叠。以前建的、不属于任何团队的群聊不在侧栏列出。
- **每个 bot 下面**列出它的聊天，最近 20 个，多了有 **Show more**。点 bot 名字旁边的箭头折叠。
- **置顶的聊天**排在最前面。
- **Search**（顶部的搜索框，或 ⌘K）：打开搜索和跳转，见[下一节](#15-搜索和跳转k)。
- **Hidden bots**：侧栏最底下，列出藏起来的 bot（bot 菜单里的 **Hide from sidebar**），点标题展开。藏起来只是不占主列表，bot 本身照常工作；想放回去，在它的菜单里选 **Show in sidebar**。如果所有 bot 都藏起来了，列表里会有 **Show hidden bots** 按钮。要停掉一个 bot 用 **Archive**（见[管理 bot](#13-管理-bot)）。
- **Display preferences**（顶部的 ≡ 按钮）：
  - **Archived bots**：显示或隐藏已归档的 bot。
  - **Chat order**：按最近活动排序，或 Manual（用聊天菜单里的 Move up / Move down 手动排）。
- 侧栏的置顶、顺序、折叠状态存在 `bots.json` 里，换浏览器打开也一样。

## 15. 搜索和跳转（⌘K）

在任何页面按 **⌘K**（Windows 上是 Ctrl+K），或点侧栏顶部的 **Search**，打开搜索框：

- **Jump to**：按名字跳到 bot、团队、session、聊天（按标题）或定时任务。名字和「在哪」都能匹配，比如输入 `ada` 也会列出有 Ada 的团队，输入 `ada budget` 找 Ada 那个讲预算的聊天。藏起来的、归档的 bot 也在，带 **Hidden** / **Archived** 标记。选定时任务会打开那个 bot 的 **Routines** 页签并闪一下那个任务。
- **Messages**：输入两个字以上，同时查过去的消息：所有单聊（你和 bot 说的话，包括归档的聊天）和所有 session（你和 bot 发的消息）。每个词都要出现，词的一部分也算，中文也行。每条结果写着在哪（「Ada › 聊天标题」或「session 名 › thread #12」）、谁说的、什么时候，匹配的词会标出来。
- 选一条消息，会打开那个聊天或 session（线程里的消息会打开线程），自动加载到那条消息、滚过去并闪一下，匹配的词标亮约 10 秒。
- 上下键移动，回车打开，Esc 关闭。不输入时列出 bot、团队、最近的 session 和最近的聊天。

bot 在 session 里的那一侧（座位）不单独搜：它看到的内容在 session 里能搜到。单聊消息的全文索引在第一次搜索时补上最新的内容，所以刚说过的话也搜得到；升级前的聊天在升级后第一次启动时就建好索引。

## 16. 设置

侧栏左下角的齿轮：

- **pocket-bots**：每个 agent CLI 的状态和版本、定时任务是否在跑、数据目录、版本。端口要改 `config.json` 或环境变量后重启，见 README。
- **Chats**：bot 忙时新消息的处理方式（Steers / Interrupts / Queues）。
- **New bots start with**：新 bot 默认的 provider、模型、审批模式、能否联系其他 bot。
- **Presets**：管理预设。
- **Avatar pictures**：填一个 OpenAI key 后，**Identity → Draw a picture** 可以按描述画头像。key 只存在本机。不填也能用像素头像、上传图片或图片 URL。
- **Back up**：导出所有 bot。

## 17. 常见问题

**左上角显示 No agent CLI ready，或某个 agent 不可用**
鼠标停在上面看原因：没装（不在 PATH 上）或没登录。在终端里登录一次（`claude`、`codex login`、`grok`、`pi` 里的 `/login`），然后刷新页面（agent 列表最多缓存五分钟）。

**改了模型或审批模式没生效**
设置只影响**新开的聊天**。点顶栏的 **+** 开一个新聊天。

**bot 一直在问我要不要批准**
看 **Model → Approval mode**：`Always Ask` 下每类工具第一次都要批。常用命令可以在卡片上点 **Always allow**；常用的 MCP 工具在 **Access** 里勾上；或者改用 `Provider default`（Claude Code 的 auto 模式）。

**定时任务没跑**
定时任务由 pocket-bots 后端调度（每 30 秒检查一次），后端必须开着。在 **Routines → At a glance** 看下一次运行时间和最近的运行状态；bot 是否被归档；任务开关是否打开。

**webhook 调不通**
地址只监听 `127.0.0.1`，必须在同一台电脑上调用。relay 端口不会自己变；如果你在 `config.json` 里改过 `relay.port`，旧地址会失效，重新复制一次。

**页面上的状态不更新**
页面通过 `/api/events` 接收实时更新，断线会自动重连并补拉数据（静默断开的连接最多 45 秒后发现）。实在不行刷新一下页面。

**从手机或另一台电脑打开**
默认只监听 `127.0.0.1`。在 `config.json` 里把 `web.host` 改成 `0.0.0.0`（或 Tailscale 地址），用域名访问时把域名加进 `web.hostnames`。Web UI 没有登录，只在可信网络里这样做。通过 `http://` 加 IP 访问时浏览器不允许直接写剪贴板，复制按钮会自动改用兼容方式，webhook 地址复制不了时会弹窗显示。
