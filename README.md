# opencode-route-standard

在 opencode 上还原 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) v0.3.0 的 **standard 模式**（RL 接口还原）：首轮 system 只有 RL 训练句 + shell/edit 窄工具面，模型走 think-act 短循环。单文件、零 npm 依赖。

## 效果

模型的 think 全程为**复数协作形式**（`We need to` / `Let's` / `We should` / `We can`），不再出现单数自述（`I` / `Let me`）——对齐 DSH standard 模式在 deepseek-v4-flash 上的实测接口形状：

```
Thinking: We need to inspect the current directory for buggy.js. Let's list files.
```

实测记录（deepseek/deepseek-v4-flash，think 变体）：

| 任务类型 | 任务 | think 特征 |
|---------|------|-----------|
| build | greet.js 创建 | 全 Let's，0 个 I/Let me |
| build | calc.js CLI + 测试 | 全 Let's，0 个 I/Let me |
| fix | buggy.js 修 bug | We need to ×3 + Let's ×5 + We should/We can，0 个 I/Let me |
| fix | buggy2.js 修 bug | We need + Let's ×2 + Should we，0 个 I/Let me |

## 原理

5 个 hook 协作实现 RL 接口还原：

| hook | 作用 |
|------|------|
| `chat.message` | 首轮窄工具面：非核心工具**显式置 false**（`resolveTools` 只过滤 `user.tools[k]===false` → 工具从请求 schema 消失） |
| `experimental.chat.system.transform` | system **完全替换**为 RL 训练句（`You are a helpful software engineer assistant.`）+ 一行 cwd 锚点（opencode 内置基础提示是唯一承载 cwd 的地方，完全替换后模型会丢失工作目录锚点，实测曾写到 `Temp\opencode`） |
| `tool.definition` | bash/edit 的 description 与参数描述压缩为 RL 简洁版（内置工具描述携带大量指令文本，模型 think 会引用并据此推理，把接口拉离 RL 训练形状） |
| `tool.execute.before` | 记录首个工具调用 → 后续请求放开全量工具 |
| `tool.dev_router_status` | 查看会话路由状态（窄面/已放开、persona、核心工具集） |

首轮后模型只看到 `bash` + `edit` 两个工具；第一个工具调用后全量恢复。

## 安装

### 1. 注册插件

在全局 `~/.config/opencode/opencode.json` 的 `plugin` 数组加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "~/.config/opencode/plugins/opencode-route-standard/opencode-route-standard.js"
  ]
}
```

只想对某个项目启用时，把同一行写进该项目根目录的 `opencode.json` 即可（插件注册到哪，就在哪生效）。

### 2. 安装 agent 预设

```sh
cp agents/router-standard.md ~/.config/opencode/agent/router-standard.md
```

用 `opencode --agent router-standard` 启动，或 TUI 内 `/agents` 选择。

### 3. 验证

```sh
opencode run --agent router-standard --model deepseek/deepseek-v4-flash --variant max --thinking "用 buggy.js 排查修复" --dir <测试目录>
```

预期：think 出现 `We need to` / `Let's` 等复数协作形式，无 `I` / `Let me`；首轮工具只有 `bash`/`edit`。

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

配置每次请求重读（热重载），改完即生效，无需重启。

> 定位：纯 Agent 路由增强。路由只接管首轮 system 与工具面，完成后按 opencode 正常流程走，不改变用户既有的使用习惯（AGENTS.md、基础提示等正常生效——`system_mode: "append"` 时完全保留）。

## 能力边界

- **不能自动感知 provider 额度/失效**：provider 管理是 opencode 的事，插件只做消息改写。
- **不能按 agent 区分路由**：hook 输入无 agent 名（SDK 限制）。
- **跨进程状态不共享**：窄化状态为进程内单例，首个工具调用放开全量需交互式 TUI 会话验证（`opencode run` 是一次性进程）。

## 上游参考

- [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) —— standard 模式原始实现（v0.3.0）
