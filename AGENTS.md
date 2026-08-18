# AGENTS.md — opencode-route-standard

## 项目定位

在 opencode 上还原 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) v0.3.0 的 **standard 模式**（RL 接口还原）：首轮 system 只有 RL 训练句 + shell/edit 窄工具面，模型走 think-act 短循环。路由增强 dsv4flash 的 Agent 预设（DeepSeek-v4-flash-free 在 Win 端 opencode 的免费代餐）。

## 核心原理

1. **agent gate（issue #1 修复）**：所有路由 hook 只作用于 `router-standard` 预设的会话（`UserMessage.agent` 字段判定；system.transform 从会话历史取 agent）。其他 agent 预设（Build/Plan）完全不干预——不窄工具面、不替换 system。
2. **强力替换 systemprompt**：首轮 system 完全替换为 RL 训练句 `You are a helpful software engineer assistant.` + 一行 `Current working directory: <cwd>`（DSH minimal `complete: true` 语义；原地 `length=0`+`push` 保持数组引用）。cwd 锚点必须保留（完全替换后模型会丢工作目录，曾实测写到 Temp\opencode）。
3. **首轮窄工具面**：`chat.message` 把非核心工具显式置 `false`（resolveTools 黑名单语义 `user.tools[k]!==false` 即过滤）；插件自身 dev 工具与 `narrowExclude` 配置项同样显式 false。
4. **首个工具调用后放开全量**：`tool.execute.before` 记录 → 后续请求不再窄化。
5. **接口净化**：`tool.definition` 把 bash/edit 描述压缩为 RL 简洁版（内置描述携带大量指令文本，会把模型 think 拉离 RL 训练形状）。

## 架构铁律（保持精简）

- **单文件插件 + 零 npm 依赖**：所有逻辑内联在 `opencode-route-standard.js`，不拆分 src/ 模块。
- **仓库保持精简**：只保留插件主文件、配置、agents/ 预设、README、AGENTS.md、sandbox/。不复制 `src/`、`test/`、`docs/`、`eval/`、`archive/` 等。
- **完整演进版在开发目录**：`~/.config/opencode/plugins/opencode-routing-suite/` 是完整开发版（agent gate + standard/spec 双模式 + 单元测试 + 设计文档），本仓库是它的精简交付镜像。
- **同步方式**：routing-suite 的代码演进 → 手动 inline 同步到本单文件 → 沙盒测试 → 推送。

## 测试方法

### 1. 沙盒验证（不注册全局）

```sh
cd sandbox
opencode run --agent router-standard "列出你当前可用的所有工具名称" --model opencode/deepseek-v4-flash-free
```

预期：首条消息只看到 bash + edit（standard 窄面），后续放开全量。

### 2. agent gate 双向验证（issue #1 验收）

```sh
# 正向：router-standard 首轮窄面
opencode run --agent router-standard "列出你当前可用的所有工具名称" --model opencode/deepseek-v4-flash-free --print-logs
# 负向：build 会话应看到全量工具、无路由日志
opencode run --agent build "列出你当前可用的所有工具名称" --model opencode/deepseek-v4-flash-free --print-logs
```

预期：router-standard 会话 debug 日志出现 `router: agent=router-standard tools=[edit,bash]` 与 `system.replace`；build 会话无任何 router 日志、工具全量。

### 3. RL 形状生效标志（关键验证）

使用 **router-standard 预设 + dsv4flash** 会话，检查模型**思维链（reasoning）**中是否出现 **（We need / Let's）的复数自述**。注意：`reasoning: "low"`（variant low）会抑制复数自述，验证时用默认 variant。

判定流程：路由生效的充分证据链 = ① system 被替换为 RL 训练句（debug 日志）→ ② 工具面窄化为 bash+edit（模型自述）→ ③ 思维链复数自述（default variant 下）。

## Git 规范

- 提交风格：conventional commits + 中文描述（如 `fix: ...`、`feat: ...`）。
- 推送远程（FLMArnold/opencode-route-standard）前必须先沙盒测试确认，用户确认无误后才 push。

## Git 隔离规则

- 本仓库是独立 git 仓库（harness-RnD 铁律）。**禁止**对 `~/.config/opencode/`（含 3.7GB `opencode.db`）git init。
- 测试通过前不注册全局 `opencode.json` plugin 数组，只注册在 `sandbox/opencode.json`。
- provider apiKey 走 `/connect`（auth.json），不写入任何配置文件。
