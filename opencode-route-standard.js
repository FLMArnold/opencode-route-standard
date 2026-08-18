// opencode-route-standard.js —— opencode 上的 dsh-router-standard standard 模式还原（Flash 版）
// 单文件、零 npm 依赖。效果：think 全程复数协作形式（We need / Let's / We should），
// 无 "I" / "Let me" 单数自述（对齐 yjh051108/dsh-router-standard v0.3.0 standard 模式 RL 接口形状）。
//
// 作用域（issue #1 修复）：agent gate —— 所有路由 hook 只作用于 router-standard 预设的会话
//   （UserMessage 携带 agent 字段；chat.message 的 input.agent 直读，
//   system.transform 无 agent 输入 → 从会话历史取最近一条用户消息的 agent）。
//   其他 agent 预设（Build/Plan 等）完全不干预：不窄工具面、不替换 system。
//
// hook 映射（4 hook + 1 dev 工具）：
//   chat.message                         → 首轮窄工具面（只留 edit + bash，其余显式 false）
//   experimental.chat.system.transform   → system 完全替换为 RL 训练句 + cwd 锚点
//   tool.definition                      → bash/edit 描述压缩为 RL 简洁版
//   tool.execute.before                  → 记录首次工具调用 → 后续放开全量
//   tool.dev_router_status               → 路由状态查看（dev 工具，非 hook）
//
// 全局约束：零 npm 依赖；hook 内一切异常静默吞；原地修改 output 不切断引用；
// 配置放独立 opencode-route-standard.json（opencode.json 严格 schema 校验）。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const PLUGIN_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")

// RL 训练句：首轮 system 只有这一句 + cwd 锚点，其余基础提示全部替换
const RL_PERSONA = "You are a helpful software engineer assistant."

// 首轮核心工具（RL 形状：编辑工具 + shell；bash 由下方附加）
const CORE_TOOLS = ["edit"]

// 已调用过工具的会话：首轮窄面 → 首个工具调用后放开全量
const toolCalledSessions = new Set()
// 已补注入过第二轮上下文（AGENTS.md）的会话：只注入一次
const contextInjectedSessions = new Set()

// agent gate：路由只作用于 router-standard 预设（其余 agent 会话完全不干预）。
// opencode 的 UserMessage 携带 agent 字段（agent 预设文件名）；system.transform
// 无 agent 输入 → 从会话历史取最近一条用户消息的 agent。
function isRouterStandardAgent(agent) {
  return typeof agent === "string" && /router-standard/i.test(agent)
}

async function sessionAgent(client, sessionID) {
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const msgs = Array.isArray(res) ? res : res?.data
    if (Array.isArray(msgs)) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info
        if (info?.role === "user" && typeof info.agent === "string" && info.agent) {
          return info.agent
        }
      }
    }
  } catch { /* fall through */ }
  return ""
}

function readConfig() {
  try {
    const candidates = [
      path.join(process.cwd(), "opencode-route-standard.json"),
      path.join(homedir(), ".config", "opencode", "opencode-route-standard.json"),
      path.join(PLUGIN_DIR, "opencode-route-standard.json"),
    ]
    for (const p of candidates) {
      try {
        const cfg = JSON.parse(stripBOM(readFileSync(p, "utf8")))
        if (cfg && typeof cfg === "object") return cfg
      } catch { /* try next */ }
    }
    return { enabled: true, debug: false, system_mode: "replace" }
  } catch {
    return { enabled: true, debug: false, system_mode: "replace" }
  }
}

function stripBOM(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

// 第二轮调用前补注入的"第一轮被屏蔽且不会再现"的上下文：目前 = AGENTS.md
// （项目根 + 全局配置目录，opencode 原生注入这两份，system 完全替换后不会自己回来）。
// MCP 工具在放开全量后会随工具 schema 再现，skill 由 superpowers bootstrap 常驻，故不在此补。
function readBlockedContext(cwd) {
  const chunks = []
  const candidates = [
    path.join(cwd, "AGENTS.md"),
    path.join(homedir(), ".config", "opencode", "AGENTS.md"),
  ]
  for (const p of candidates) {
    try {
      const s = stripBOM(readFileSync(p, "utf8")).trim()
      if (s) chunks.push(s)
    } catch { /* skip */ }
  }
  if (chunks.length === 0) return ""
  return `\n\n[Re-injected context after first-round routing]\n${chunks.join("\n\n---\n\n")}`
}

export const OpencodeRouteStandard = async ({ client, directory }) => {
  const cwd = directory || process.cwd()
  return {
    // 首轮窄工具面：非核心工具显式置 false（resolveTools 过滤 → 从请求 schema 消失）。
    // agent gate：只有 router-standard 预设的会话进入路由逻辑。
    "chat.message": async (_input, output) => {
      try {
        const cfg = readConfig()
        if (!cfg || cfg.enabled === false) return
        const sessionID = _input.sessionID
        const message = output.message
        if (!message || typeof message !== "object") return
        const agent = _input.agent || (await sessionAgent(client, sessionID))
        if (!isRouterStandardAgent(agent)) return
        if (toolCalledSessions.has(sessionID)) return // 已调用过工具，放开全量

        let allIds = []
        try {
          const res = await client.tool.ids()
          allIds = (Array.isArray(res) ? res : res?.data) || []
        } catch { allIds = [] }
        if (allIds.length === 0) return

        const core = new Set([...CORE_TOOLS, "bash"])
        const tools = {}
        for (const id of allIds) tools[id] = core.has(id)
        // 插件自身 dev 工具（client.tool.ids() 不含它们）+ 配置扩展的排除项
        // 显式置 false —— resolveTools 是黑名单语义（user.tools[k]!==false 才保留），
        // 只要 message.tools 覆盖到 key，无论工具来自插件还是 MCP 都能过滤。
        for (const id of ["dev_router_status", ...(cfg.narrowExclude || [])]) {
          if (typeof id === "string" && id) tools[id] = false
        }
        message.tools = tools

        if (cfg.debug) {
          await client.app.log({
            body: {
              service: "opencode-route-standard",
              level: "info",
              message: `router: agent=${agent} tools=[${[...core].join(",")}]`,
            },
          })
        }
      } catch { /* silent */ }
    },

    // persona：system 完全替换为 RL 训练句 + cwd 锚点（DSH minimal `complete: true` 语义）。
    // opencode 内置基础提示是唯一承载 cwd 的地方，完全替换后模型会丢失工作目录锚点
    // （实测曾写到 Temp\opencode），故追加一行 cwd 陈述。
    // 配置 system_mode="append" 时改为追加（保留基础提示，自带 cwd）。
    // agent gate：system.transform 无 agent 输入 → 从会话历史取 agent 判定。
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const cfg = readConfig()
        if (!cfg || cfg.enabled === false) return
        const sessionID = input.sessionID
        const agent = sessionID ? await sessionAgent(client, sessionID) : ""
        if (!isRouterStandardAgent(agent)) return
        const system = output.system
        if (cfg.system_mode === "append") {
          const idx = system.findIndex((s) => /persona/i.test(s))
          if (idx === -1) system.push(RL_PERSONA)
          else system[idx] = RL_PERSONA
          return
        }
        system.length = 0
        system.push(`${RL_PERSONA}\n\nCurrent working directory: ${cwd}`)
        if (cfg.debug) {
          try {
            await client.app.log({
              body: {
                service: "opencode-route-standard",
                level: "info",
                message: `router: system.replace agent=${agent} system=[${system.length}段]`,
                extra: { systemAfter: [...system].join("\n---\n").slice(0, 600) },
              },
            })
          } catch { /* silent */ }
        }
      } catch { /* silent */ }
    },

    // 接口净化：bash/edit 描述压缩为 RL 简洁版。opencode 内置工具描述携带大量指令
    // 文本（"DO NOT use it for file operations" "Use this instead of 'cd' commands" 等），
    // 模型 think 会引用并据此推理，把接口拉离 RL 训练形状。
    // tool.definition 只改发给模型的描述，工具行为与权限判定不受影响。
    // 注：hook input 无 sessionID/agent，无法按 agent gate（SDK 限制，见 README 能力边界）。
    "tool.definition": async (input, output) => {
      try {
        const cfg = readConfig()
        if (!cfg || cfg.enabled === false) return
        const RL_TOOL_DESCRIPTIONS = {
          // 环境信息不硬编码进工具描述（工具 schema 保持环境无关/RL 纯净）；
          // 本机环境（Windows + PowerShell 5.1）由 messages.transform 近距锚点注入。
          bash: "Execute terminal commands in the current working directory.",
          edit: "Edit a file by exact string replacement.",
        }
        const desc = RL_TOOL_DESCRIPTIONS[input.toolID]
        if (desc) output.description = desc
        const RL_PARAM_DESCRIPTIONS = {
          bash: { command: "The command to execute", workdir: "Working directory for the command" },
          edit: { filePath: "The file to edit", oldString: "The text to replace", newString: "The replacement text" },
        }
        const params = RL_PARAM_DESCRIPTIONS[input.toolID]
        if (params) {
          const props = output.parameters?.properties
          if (props && typeof props === "object") {
            for (const [key, text] of Object.entries(params)) {
              if (props[key] && typeof props[key] === "object") props[key].description = text
            }
          }
        }
      } catch { /* silent */ }
    },

    // 近距 RL 环境锚点（standard）：把 RL 身份 + cwd + 本机环境以 synthetic
    // 文本追加到当前用户消息末尾。注册顺序=执行顺序，本插件须注册在会注入
    // 内容的插件（如 superpowers bootstrap）之后；追加在末尾天然晚于任何
    // prepend 型注入，保证本插件注入时机最后生效。system 仍为纯 RL 句（静态
    // 前缀，缓存友好），此处只做近距补强，不改 RL_PERSONA 原文。
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const cfg = readConfig()
        if (!cfg || cfg.enabled === false) return
        const messages = output.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        // agent gate：从后往前找带 agent 的用户消息（synthetic 消息也带 agent）
        let agent = ""
        for (let i = messages.length - 1; i >= 0; i--) {
          const info = messages[i]?.info
          if (info?.role === "user" && typeof info.agent === "string" && info.agent) {
            agent = info.agent
            break
          }
        }
        if (!isRouterStandardAgent(agent)) return
        const lastUser = [...messages].reverse().find((m) => m.info?.role === "user")
        if (!lastUser || !Array.isArray(lastUser.parts)) return
        const sessionID = lastUser.info.sessionID
        // 剥离 superpowers bootstrap（首条用户消息开头的 EXTREMELY_IMPORTANT 块）：
        // 本插件注册在 superpowers 之后（注册顺序=执行顺序），此处后执行，负责把
        // 会压掉 RL 步开头复数自述的强指令块移除，恢复 standard 接口纯净。
        const firstUser = messages.find((m) => m.info?.role === "user")
        if (firstUser && Array.isArray(firstUser.parts)) {
          const stripped = firstUser.parts.filter(
            (p) => !(p.type === "text" && p.text && p.text.includes("EXTREMELY_IMPORTANT"))
          )
          if (stripped.length !== firstUser.parts.length) {
            firstUser.parts.splice(0, firstUser.parts.length, ...stripped)
            if (cfg.debug) {
              try {
                await client.app.log({
                  body: {
                    service: "opencode-route-standard",
                    level: "info",
                    message: `router: standard bootstrap stripped agent=${agent}`,
                  },
                })
              } catch { /* silent */ }
            }
          }
        }
        // 近距 RL 环境锚点（每轮幂等追加；环境信息不硬编码进工具 schema）
        if (!lastUser.parts.some((p) => p.text && p.text.includes("Environment: Windows"))) {
          const anchor =
            `\n${RL_PERSONA} Current working directory: ${cwd}. Environment: Windows, Shell: Windows PowerShell 5.1.`
          lastUser.parts.push({ type: "text", text: anchor, synthetic: true })
          if (cfg.debug) {
            try {
              await client.app.log({
                body: {
                  service: "opencode-route-standard",
                  level: "info",
                  message: `router: standard-anchor injected agent=${agent}`,
                },
              })
            } catch { /* silent */ }
          }
        }
        // 第二轮调用前补注入：第一轮被 system 替换屏蔽、且之后不会自己再现的
        // 上下文（AGENTS.md：项目根 + 全局配置目录）。只在首个工具调用发生后注入一次。
        if (toolCalledSessions.has(sessionID) && !contextInjectedSessions.has(sessionID)) {
          const ctx = readBlockedContext(cwd)
          if (ctx) {
            lastUser.parts.push({ type: "text", text: ctx, synthetic: true })
            contextInjectedSessions.add(sessionID)
            if (cfg.debug) {
              try {
                await client.app.log({
                  body: {
                    service: "opencode-route-standard",
                    level: "info",
                    message: `router: second-call context injected agent=${agent}`,
                  },
                })
              } catch { /* silent */ }
            }
          }
        }
      } catch { /* silent */ }
    },

    // 首个工具调用 → 放开全量（后续请求不再窄化）
    "tool.execute.before": async (input) => {
      try {
        toolCalledSessions.add(input.sessionID)
      } catch { /* silent */ }
    },

    // 路由状态查看
    tool: {
      dev_router_status: {
        description: "Show route-standard session state: narrowed tool set and persona.",
        execute: async ({ sessionID }) => {
          try {
            const cfg = readConfig()
            return [
              "mode=standard (RL interface restore)",
              `persona=${RL_PERSONA}`,
              `first-turn core=[${[...CORE_TOOLS, "bash"].join(", ")}]`,
              `narrowed=${!toolCalledSessions.has(sessionID)}`,
              `system_mode=${cfg.system_mode}`,
            ].join("\n")
          } catch { /* silent */ }
        },
      },
    },
  }
}
