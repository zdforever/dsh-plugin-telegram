# dsh-plugin-telegram

Control [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) from your phone via Telegram: start tasks, watch live progress, and answer DSH's approval requests and questions — all from the Telegram chat.

用手机通过 Telegram 遥控本机运行的 DSH：发任务、看实时进度、在手机上回答 DSH 的提问与审批。

它是一个跑在 DSH 宿主进程内的 Cordis 插件（与 `dsh-plugin-writing-guard` 等官方插件同一加载机制）：无需 HTTP 端口、无需鉴权服务，原生订阅 DSH 会话事件。Telegram 客户端为零依赖纯 Node 实现（`node:net` / `node:tls` 长轮询），支持 SOCKS5 与 HTTP CONNECT 代理——在需要代理才能访问 Telegram 的网络（如校园网/公司网）下可用。

## Features / 功能

- 🆕 `/new <任务>` — 新建 DSH 会话并开始执行
- 💬 直接发文字 — 继续当前会话的对话
- 📋 `/list` / `/open` — 切换、选择已有会话（带按钮）
- 📜 `/tail [n]` / `/status` — 查看历史与待办进度（todo 列表实时推送）
- ⏹ `/cancel` — 取消当前回合
- ✅ **审批转发**：DSH 请求权限提升时推送到手机，「允许一次 / 拒绝」按钮直接回答
- ❓ **提问转发**：`ask_user_question` 的选项按钮推到手机，也可直接回复自定义文字
- 🔁 启动带退避重试：开机时代理未就绪也能自愈
- 🛡 空配置不崩（loader 无 `config` 时安全跳过，回退 `DSH_TELEGRAM_TOKEN` 环境变量）

## Install / 安装

需要：DSH Desktop（或任意使用 profile 机制的 dsh 宿主）+ 一个 Telegram bot token（找 [@BotFather](https://t.me/BotFather) 创建）。

```powershell
dsh plugin --profile desktop add git+https://github.com/zdforever/dsh-plugin-telegram.git
```

然后**在本机安装副本里填入你的 token**（安装副本路径：`~/.dsh/profiles/desktop/node_modules/dsh-plugin-telegram/cordis.patch.yml`）：

```yaml
      config:
        token: "123456789:AA...你的token..."
        proxyUrl: ""          # 需要代理时填，如 socks5://127.0.0.1:10808
        workspace: "D:\\work" # /new 新建会话的工作目录
```

重启 DSH Desktop，在手机上给你的 bot 发 `/start` 即完成连接。

> `dsh plugin` 是 pnpm 转发器，也接受 `github:zdforever/dsh-plugin-telegram` 等写法。本插件无构建脚本，git 安装不会被 pnpm 的 allowBuilds 拦截。

## Configuration / 配置

配置写在安装副本的 `cordis.patch.yml` 的 `config:` 下（loader 启动期只读这一份）：

| 键 | 默认 | 说明 |
|---|---|---|
| `token` | `""` | bot token。**不要写进任何会被提交的文件** |
| `tokenEnv` | `DSH_TELEGRAM_TOKEN` | token 的环境变量兜底 |
| `apiBaseUrl` | `https://api.telegram.org` | Bot API 地址（自建 API 网关可改） |
| `proxyUrl` | `""` | `socks5://host:port` 或 `http://host:port`（HTTP 走 CONNECT 隧道） |
| `allowedChats` | `[]` | 授权的 chat id 列表；**空 = 首个 `/start` 自动授权** |
| `autoAuthorize` | `true` | 空列表时是否允许首个 `/start` 授权 |
| `workspace` | `""` | `/new` 新建会话的工作目录 |
| `agentPreset` / `permissionPreset` | `default` / `workspace-write` | 新建会话的预设 |
| `modelProvider` / `modelId` | `""` | 指定模型；留空用宿主默认 |
| `notifyUserMessages` / `notifyAssistantMessages` | `true` | 推送用户/助手消息 |
| `notifyToolCalls` / `notifyTurnSummary` / `notifyTodos` | `false` / `true` / `true` | 推送工具调用/回合摘要/待办 |
| `forwardApprovals` / `forwardQuestions` | `true` | 转发审批/提问到手机 |
| `approvalTimeoutSeconds` / `questionTimeoutSeconds` | `300` / `600` | 等手机回答的超时（超时回退宿主默认行为） |
| `maxMessageLength` / `pollTimeoutSeconds` / `listMax` | `3800` / `50` / `8` | 消息截断/长轮询时长/列表条数 |

### Token 放哪里 / Where to put the token

按优先级三种方式：

1. **环境变量**（推荐，永不落盘进插件目录）：给 DSH Desktop 进程设置 `DSH_TELEGRAM_TOKEN`
2. **安装副本的 yml**：编辑 `<profile>/node_modules/dsh-plugin-telegram/cordis.patch.yml`——注意 `dsh plugin add` / `pnpm add` 刷新安装会覆盖它，刷新后需重填
3. **profile 用户层覆盖**（刷新安全）：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加一段 id 定向覆盖。注意 `config` 是**整体替换**（非深合并），要把需要的键都带上：

```yaml
- id: dsh-plugin-telegram
  config:
    token: "123456789:AA..."
    proxyUrl: "socks5://127.0.0.1:10808"
    workspace: "D:\\work"
```

### ⚠️ Security notes / 安全须知

- **空 `allowedChats` + `autoAuthorize: true` 意味着第一个给 bot 发 `/start` 的人就能控制你的 DSH**（等同坐在你电脑前）。公网 bot 建议先用自动授权连一次，再把自己的 chat id（可从 @userinfobot 获取）写进 `allowedChats` 并重启
- token 等同 bot 的完整控制权，泄露了就去 @BotFather `/revoke`
- 本插件在宿主进程内运行，权限等同 DSH 本身——请只安装你审阅过代码的版本

## Phone commands / 手机端命令

| 命令 | 作用 |
|---|---|
| `/start` `/help` | 授权并查看帮助 |
| `/new <任务描述>` | 新建会话并开始 |
| `/list` `/sessions` | 最近会话列表（带「打开」按钮） |
| `/open <id>` `/link <id>` | 选择当前会话（支持短 id） |
| 直接发文字 | 发给当前会话 |
| `/ask [sessionId] <内容>` | 显式继续某个会话 |
| `/tail [sessionId] [n]` | 最近 n 条历史（默认 5） |
| `/status [sessionId]` | 会话状态与待办 |
| `/cancel [sessionId]` | 取消当前回合 |
| `/ping` | 连通性测试 |

被 `/open` 或 `/new` 关联的会话，其助手回复、回合进度、待办列表会实时推送到该聊天。

## How it works / 工作原理

- 以 Cordis 插件形式加载（`dsh.bundle.patch` → loader entry + config），`inject` 七个 DSH 服务：`agents` / `agentDefaultModel` / `agentPresets` / `permissionPresets` / `sessionQuery` / `sessionTitle` / `workspaceRegistry`
- 订阅 `session/created` / `session/event` / `session/disposed` 推送进度，`approval/request` 与 `user-questions/request` 走 waterfall 转发到手机（`allowed-once` / `rejected` 语义与宿主一致）
- Telegram 侧为 getUpdates 长轮询 + sendMessage/editMessageText/answerCallbackQuery，HTML parse_mode，inline keyboard 按钮
- 授权状态持久化在 `~/.dsh/telegram-bridge.json`

## Uninstall / 卸载

```powershell
dsh plugin --profile desktop remove dsh-plugin-telegram
```

（`dsh` CLI 会同步把它从 `dsh.profile.bundles` 移除；手动安装的话从 `package.json` 的 bundles 里删掉该行。）重启宿主生效。

## Changelog / 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](./LICENSE)
