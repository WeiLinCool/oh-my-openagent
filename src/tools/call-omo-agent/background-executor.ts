import type { CallOmoAgentArgs } from "./types"
import type { BackgroundManager } from "../../features/background-agent"
import type { PluginInput } from "@opencode-ai/plugin"
import type { FilePart } from "@opencode-ai/sdk"
import { log } from "../../shared"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getMessageDir } from "./message-dir"
import { getSessionTools } from "../../shared/session-tools-store"

export async function executeBackground(
  args: CallOmoAgentArgs,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
  manager: BackgroundManager,
  client: PluginInput["client"],
  fallbackChain?: FallbackEntry[],
  model?: DelegatedModelConfig,
): Promise<string> {
  try {
    const messageDir = getMessageDir(toolContext.sessionID)
    const { prevMessage, firstMessageAgent } = await resolveMessageContext(
      toolContext.sessionID,
      client,
      messageDir
    )

    const sessionAgent = getSessionAgent(toolContext.sessionID)
    const parentAgent = toolContext.agent ?? sessionAgent ?? firstMessageAgent ?? prevMessage?.agent
    
    log("[call_omo_agent] parentAgent resolution", {
      sessionID: toolContext.sessionID,
      messageDir,
      ctxAgent: toolContext.agent,
      sessionAgent,
      firstMessageAgent,
      prevMessageAgent: prevMessage?.agent,
      resolvedParentAgent: parentAgent,
    })

    // 从父 session 最新用户消息提取 file parts
    let extractedFileParts: Array<{ type: "file"; mime: string; url: string; filename?: string }> | undefined
    try {
      const messagesResponse = await client.session.messages({ path: { id: toolContext.sessionID } })
      if (messagesResponse.data && messagesResponse.data.length > 0) {
        const userMessages = messagesResponse.data
          .filter(msg => msg.info?.role === "user")
          .sort((a, b) => {
            const aTime = a.info?.time?.created ?? 0
            const bTime = b.info?.time?.created ?? 0
            return bTime - aTime
          })

        if (userMessages.length > 0) {
          const latestUserMessage = userMessages[0]
          const parts = latestUserMessage.parts ?? []
          extractedFileParts = parts
            .filter((part): part is FilePart => part.type === "file" && "mime" in part && typeof part.mime === "string" && part.mime.startsWith("image/"))
            .map(part => ({
              type: "file" as const,
              mime: part.mime,
              url: part.url,
              filename: part.filename,
            }))

          if (extractedFileParts.length > 0) {
            log("[call_omo_agent] 提取到 file parts", {
              sessionID: toolContext.sessionID,
              filePartsCount: extractedFileParts.length,
            })
          }
        }
      }
    } catch (error) {
      log("[call_omo_agent] 提取 file parts 失败", { sessionID: toolContext.sessionID, error: String(error) })
    }

    const task = await manager.launch({

      description: args.description,
      prompt: args.prompt,
      agent: args.subagent_type,
      parentSessionID: toolContext.sessionID,
      parentMessageID: toolContext.messageID,
      parentAgent,
      parentTools: getSessionTools(toolContext.sessionID),
      model,
      fallbackChain,
      parts: [...(args.parts ?? []), ...(extractedFileParts ?? [])],
    })

    const WAIT_FOR_SESSION_INTERVAL_MS = 50
    const WAIT_FOR_SESSION_TIMEOUT_MS = 30000
    const waitStart = Date.now()
    let sessionId = task.sessionID
    while (!sessionId && Date.now() - waitStart < WAIT_FOR_SESSION_TIMEOUT_MS) {
      const updated = manager.getTask(task.id)
      if (updated?.status === "error" || updated?.status === "cancelled" || updated?.status === "interrupt") {
        return `Task failed to start (status: ${updated.status}).\n\nTask ID: ${task.id}`
      }
      sessionId = updated?.sessionID
      if (sessionId) {
        break
      }
      if (toolContext.abort?.aborted) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, WAIT_FOR_SESSION_INTERVAL_MS))
    }

    await toolContext.metadata?.({
      title: args.description,
      metadata: { sessionId: sessionId ?? "pending" },
    })

    return `Background agent task launched successfully.

Task ID: ${task.id}
Session ID: ${sessionId ?? "pending"}
Description: ${task.description}
Agent: ${task.agent} (subagent)
Status: ${task.status}

System notifies on completion. Use \`background_output\` with task_id="${task.id}" to check.

Do NOT call background_output now. Wait for <system-reminder> notification first.`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Failed to launch background agent task: ${message}`
  }
}
