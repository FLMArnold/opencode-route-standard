import { appendFileSync } from "node:fs"
import path from "node:path"
const LOG = path.join(process.cwd(), "sandbox", "hook-debug.log")

function log(label, input, output) {
  try {
    const keys = input && typeof input === "object" ? Object.keys(input) : []
    const agent = input?.agent ?? input?.message?.agent ?? "(none)"
    appendFileSync(LOG, `${new Date().toISOString()} [${label}] keys=${JSON.stringify(keys)} sessionID=${input?.sessionID ?? "(none)"} agent=${JSON.stringify(agent)} toolID=${input?.toolID ?? "(none)"} model=${JSON.stringify(input?.model?.id ?? input?.model?.modelID ?? "(none)")}\n`)
  } catch {}
}

export const DebugHooks = async () => {
  return {
    "chat.message": async (input, output) => {
      log("chat.message", { ...input, agent: input?.agent ?? output?.message?.agent })
    },
    "experimental.chat.system.transform": async (input, output) => {
      log("system.transform", input)
    },
    "tool.definition": async (input, output) => {
      log("tool.definition", input)
    },
    "tool.execute.before": async (input, output) => {
      log("tool.execute.before", input)
    },
  }
}
