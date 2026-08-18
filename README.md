# opencode-route-standard

Opencode-Zen Deepseek-v4-flash-free代餐，主包用的是WSL内的DSH，用DeepSeek-v4-flash-free一直说免费额度用完，但是在Win的Opencode就能用，所以计划做Win端Opencode端的代餐（毕竟是免费的），因为上下文才200k就不用Route-spec预设了，只做了Route-standard。

> 现状：免费额度（`opencode/deepseek-v4-flash-free`）已用尽，实测走 `opencode-go/deepseek-v4-flash`（OpenCode Go 直连付费，无额度限制）；其他 provider 可按环境替换。

在 opencode 上还原 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) v0.3.0 的 **standard 模式**（RL 接口还原）：首轮 system 只有 RL 训练句 + shell/edit 窄工具面，模型走 think-act 短循环。单文件、零 npm 依赖。

## 作用域（issue #1 修复）

**agent gate：所有路由 hook 只作用于 `router-standard` 预设的会话**（`UserMessage.agent` 字段判定；`system.transform` 无 agent 输入，从会话历史取最近一条用户消息的 agent）。其他 agent 预设（Build/Plan 等）**完全不干预**：不窄工具面、不替换 system——无需手动删插件配置来恢复其他预设。

## 效果

模型的 think **以复数协作形式为主**（`We need to` / `Let's` / `We should` / `We can`），单数自述（`I` / `Let me`）明显减少——对齐 DSH standard 模式在 deepseek-v4-flash 上的实测接口形状：

```
Thinking: We need to inspect the current directory for buggy.js. Let's list files.
```

> 注意：复数自述受推理 variant 影响——`reasoning: "low"` 会**强烈抑制**复数自述（实测 we/let's 计数为 0），验证时用默认 variant（不传 reasoning 参数）。

实测记录（deepseek-v4-flash）：

| 任务类型 | 任务 | think 特征 |
|---------|------|-----------|
| build | greet.js 创建 | 全 Let's，0 个 I/Let me |
| build | calc.js CLI + 测试 | 全 Let's，0 个 I/Let me |
| fix | buggy.js 修 bug | We need to ×3 + Let's ×5 + We should/We can，0 个 I/Let me |
| fix | buggy2.js 修 bug | We need + Let's ×2 + Should we，0 个 I/Let me |

## 原理

5 个 hook + 1 个 dev 工具协作实现 RL 接口还原：

| hook / 工具 | 作用 |
|------|------|
| `chat.message` | 首轮窄工具面：非核心工具**显式置 false**（`resolveTools` 黑名单语义 `user.tools[k]===false` → 工具从请求 schema 消失）；插件 dev 工具与 `narrowExclude` 配置项同样显式 false；**agent gate**：非 router-standard 会话直接跳过 |
| `experimental.chat.system.transform` | system **完全替换**为 RL 训练句（`You are a helpful software engineer assistant.`）+ 一行 cwd 锚点（opencode 内置基础提示是唯一承载 cwd 的地方，完全替换后模型会丢失工作目录锚点，实测曾写到 `Temp\opencode`）；**agent gate**：从会话历史判定 agent |
| `tool.definition` | bash/edit 的 description 与参数描述压缩为 RL 简洁版（内置工具描述携带大量指令文本，模型 think 会引用并据此推理，把接口拉离 RL 训练形状）；工具描述保持环境无关，本机环境由 messages.transform 近距锚点注入 |
| `experimental.chat.messages.transform` | **近距 RL 环境锚点**：把 RL 身份 + cwd + 本机环境（Windows + PowerShell 5.1）以 synthetic 文本**追加到当前用户消息末尾**（最后注入，幂等守卫按锚点文本去重）；**第二轮调用前**补注入第一轮被屏蔽且不会再现的 AGENTS.md（项目根 + 全局，每会话一次）；**agent gate**：只作用于 router-standard 会话 |
| `tool.execute.before` | 记录首个工具调用 → 后续请求放开全量工具 |
| `tool.dev_router_status` | 查看会话路由状态（窄面/已放开、persona、核心工具集） |

首轮后模型只看到 `bash` + `edit` 两个工具；第一个工具调用后全量恢复。

> **注入时机（2026-08-18 实测）**：opencode 插件 hook **注册顺序 = 执行顺序**（plugin 数组先注册的先执行）。要让本插件注入最后生效，必须**注册在会注入内容的插件之后**（如 superpowers 的 bootstrap），且本插件用"追加到用户消息末尾"，天然晚于任何 prepend 型注入。全局配置中 `superpowers` 在前、本插件在最后即满足该约定；若未来 super-injector 统一注入 skill/AGENTS.md/MCP，本插件仍需保持在其后注册/执行。

## 安装

> 定位：这是**代餐插件（临时用用）**——只在需要复现 DSH standard 路由形状时启用。优先推荐**隔离 git 目录**方式安装，用完即弃、不污染全局配置与既有项目。

### 1. 准备隔离 git 目录（推荐，先询问用户）

> 本 README 供安装方的用户/模型阅读：**不要自行假设安装目录**。执行前先向用户确认把隔离 git 目录建在哪里（例如 `~/route-standard-playground`、`D:\dev\route-standard`，或某个项目内子目录），用户明确指定后再动手。

插件注册到哪，就在哪生效。代餐场景建议单独建一个 git 隔离目录，把插件装进该项目级配置：

```sh
mkdir <用户指定的目录> && cd <用户指定的目录>
git init   # 独立 git 仓库（harness-RnD 铁律：不 init ~/.config/opencode）
```

在该目录根目录放 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "~/.config/opencode/plugins/opencode-route-standard/opencode-route-standard.js"
  ]
}
```

只在该目录启动 opencode 时插件生效，其他项目完全不受影响。用完删除该目录即可（不残留全局注册）。

### 2. 安装 agent 预设

```sh
cp agents/router-standard.md ~/.config/opencode/agent/router-standard.md
```

用 `opencode --agent router-standard` 启动，或 TUI 内 `/agents` 选择。mode 为 all，可作主 agent 也可作 task 子代理。

### 3. 全局安装（可选，不推荐代餐场景）

在全局 `~/.config/opencode/opencode.json` 的 `plugin` 数组加入同一路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "~/.config/opencode/plugins/opencode-route-standard/opencode-route-standard.js"
  ]
}
```

全局启用时若想对某个项目豁免，在该项目根目录放 `opencode-route-standard.json` 且 `enabled: false`。

### 4. 验证

```sh
opencode run --agent router-standard --model opencode-go/deepseek-v4-flash --thinking "列出你当前可用的所有工具名称" --dir <测试目录>
```

预期：首轮工具只有 `bash`/`edit`；think 以 `We need to` / `Let's` 等复数协作形式为主（默认 variant）。

环境锚点与注入时机验证（2026-08-18）：

```sh
# 明确答 PowerShell，不再猜/探测
opencode run --agent router-standard "本机 Shell 是什么？只根据上下文回答，不要运行探测命令" --model opencode-go/deepseek-v4-flash
# 建文件：第一条命令即 PowerShell（New-Item/Set-Content），无 POSIX 报错
opencode run --agent router-standard "在 sandbox 目录创建 r2.txt，内容 hello-r2，然后确认存在" --model opencode-go/deepseek-v4-flash
# debug=true 时确认近距锚点最后注入
opencode run --agent router-standard "列出你当前可用的所有工具名称" --model opencode-go/deepseek-v4-flash --print-logs
# 建文件任务触发首个工具调用后，应额外看到 router: second-call context injected
opencode run --agent router-standard "在 sandbox 目录创建 r2.txt，内容 hello-r2，然后确认存在" --model opencode-go/deepseek-v4-flash --print-logs
```

预期：Shell 明确答 Windows PowerShell 5.1；建文件首条命令即 PowerShell；debug 日志出现 `router: standard-anchor injected` 与（建文件任务）`router: second-call context injected agent=router-standard`；首轮工具面仍只有 bash+edit；第二轮注入后路由不失败、任务正常完成。

agent gate 负向验证（issue #1 验收）：

```sh
opencode run --agent build --model opencode-go/deepseek-v4-flash "列出你当前可用的所有工具名称" --dir <测试目录>
```

预期：build 会话看到全量工具，无任何路由干预（debug 日志无 router 行）。

## 配置

插件配置**不在** `opencode.json`（opencode 严格 schema 校验），而在独立文件 `opencode-route-standard.json`。读取优先级：

1. `<cwd>/opencode-route-standard.json`（项目级）
2. `~/.config/opencode/opencode-route-standard.json`（全局级）
3. `<插件目录>/opencode-route-standard.json`（插件目录兜底）
4. 全部缺失 → 内置默认

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 总开关。`false` 时所有 hook 跳过 |
| `debug` | boolean | `false` | true 时用 `client.app.log()` 记录路由结果（TUI 按 `L` 查日志，搜 `opencode-route-standard`） |
| `system_mode` | string | `"replace"` | `"replace"` = system 完全替换为 RL 训练句；`"append"` = 追加到末尾（保留 opencode 基础提示） |
| `narrowExclude` | string[] | `[]` | 首轮窄面时额外显式排除的工具 id（如 MCP 工具名）；列出的 id 在窄面请求中显式置 false（resolveTools 黑名单语义） |

配置每次请求重读（热重载），改完即生效，无需重启。

> 定位：纯 Agent 路由增强。路由只接管首轮 system 与工具面，完成后按 opencode 正常流程走，不改变用户既有的使用习惯（AGENTS.md、基础提示等正常生效——`system_mode: "append"` 时完全保留）。

## 能力边界

- **不能自动感知 provider 额度/失效**：provider 管理是 opencode 的事，插件只做消息改写。
- **`tool.definition` 无 agent gate**：hook input 只有 toolID，无法按 agent 区分（SDK 限制）；它只压缩工具描述文本，不影响工具行为与权限判定。
- **`tool.execute.before` 无 agent gate**：hook input 无 agent，记录状态对非 router-standard 会话也无副作用（窄化 gate 在 `chat.message`，其他预设从不窄化）。
- **跨进程状态不共享**：窄化状态为进程内单例，首个工具调用放开全量需交互式 TUI 会话验证（`opencode run` 是一次性进程）。

## 上游参考

- [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) —— standard 模式原始实现（v0.3.0）
