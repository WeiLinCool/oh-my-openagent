import type { CallOmoAgentArgs } from "./types"
import type { PluginInput } from "@opencode-ai/plugin"
import type { FilePart } from "@opencode-ai/sdk"
import { subagentSessions, syncSubagentSessions } from "../../features/claude-code-session-state"
import { clearSessionFallbackChain, setSessionFallbackChain } from "../../hooks/model-fallback/hook"
import { getAgentToolRestrictions, log } from "../../shared"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { stripAgentListSortPrefix } from "../../shared/agent-display-names"
import { waitForCompletion } from "./completion-poller"
import { processMessages } from "./message-processor"
import { createOrGetSession } from "./session-creator"

type SessionWithPromptAsync = {
  promptAsync: (opts: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown>
}

type ExecuteSyncDeps = {
  createOrGetSession: typeof createOrGetSession
  waitForCompletion: typeof waitForCompletion
  processMessages: typeof processMessages
  setSessionFallbackChain: typeof setSessionFallbackChain
  clearSessionFallbackChain: typeof clearSessionFallbackChain
}

type SpawnReservation = {
  commit: () => number
  rollback: () => void
}

const defaultDeps: ExecuteSyncDeps = {
  createOrGetSession,
  waitForCompletion,
  processMessages,
  setSessionFallbackChain,
  clearSessionFallbackChain,
}

function buildPromptGenerationParams(model: DelegatedModelConfig | undefined): Record<string, unknown> {
  if (!model) {
    return {}
  }

  const promptOptions: Record<string, unknown> = {
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.thinking ? { thinking: model.thinking } : {}),
  }

  return {
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.top_p !== undefined ? { topP: model.top_p } : {}),
    ...(model.maxTokens !== undefined ? { maxOutputTokens: model.maxTokens } : {}),
    ...(Object.keys(promptOptions).length > 0 ? { options: promptOptions } : {}),
  }
}

export async function executeSync(
  args: CallOmoAgentArgs,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void | Promise<void>
  },
  ctx: PluginInput,
  deps: ExecuteSyncDeps = defaultDeps,
  fallbackChain?: FallbackEntry[],
  spawnReservation?: SpawnReservation,
  model?: DelegatedModelConfig,
): Promise<string> {
  let sessionID: string | undefined
  let createdSessionForExecution = false
  let appliedFallbackChain = false

  try {
    const session = await deps.createOrGetSession(args, toolContext, ctx)
    sessionID = session.sessionID
    createdSessionForExecution = session.isNew
    subagentSessions.add(sessionID)
    syncSubagentSessions.add(sessionID)

    if (session.isNew) {
      spawnReservation?.commit()
    }

    if (fallbackChain && fallbackChain.length > 0) {
      deps.setSessionFallbackChain(sessionID, fallbackChain)
      appliedFallbackChain = true
    }

    applySessionPromptParams(sessionID, model)

    // 从父 session 最新用户消息提取 file parts
    let extractedFileParts: Array<{ type: "file"; mime: string; url: string; filename?: string }> | undefined
    try {
      const messagesResponse = await ctx.client.session.messages({ path: { id: toolContext.sessionID } })
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

    await Promise.resolve(

      toolContext.metadata?.({
        title: args.description,
        metadata: { sessionId: sessionID },
      })
    )

    log(`[call_omo_agent] Sending prompt to session ${sessionID}`)
    log(`[call_omo_agent] Prompt text:`, args.prompt.substring(0, 100))
    const normalizedSubagentType = stripAgentListSortPrefix(args.subagent_type)

    try {
      await (ctx.client.session as unknown as SessionWithPromptAsync).promptAsync({
        path: { id: sessionID },
        body: {
          agent: normalizedSubagentType,
          tools: {
            ...getAgentToolRestrictions(normalizedSubagentType),
            task: false,
            question: false,
          },
          parts: [{ type: "text", text: args.prompt }, ...(args.parts ?? []), ...(extractedFileParts ?? [])],
          ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          ...(model?.variant ? { variant: model.variant } : {}),
          ...buildPromptGenerationParams(model),
        },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`[call_omo_agent] Prompt error:`, errorMessage)
      if (errorMessage.includes("agent.name") || errorMessage.includes("undefined")) {
        return `Error: Agent "${normalizedSubagentType}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.\n\n<task_metadata>\nsession_id: ${sessionID}\n</task_metadata>`
      }
      return `Error: Failed to send prompt: ${errorMessage}\n\n<task_metadata>\nsession_id: ${sessionID}\n</task_metadata>`
    }

    await deps.waitForCompletion(sessionID, toolContext, ctx)

    const responseText = await deps.processMessages(sessionID, ctx)

    return responseText + "\n\n" + ["<task_metadata>", `session_id: ${sessionID}`, "</task_metadata>"].join("\n")
  } catch (error) {
    spawnReservation?.rollback()
    throw error
  } finally {
    if (sessionID && appliedFallbackChain) {
      deps.clearSessionFallbackChain(sessionID)
    }

    if (sessionID && createdSessionForExecution) {
      subagentSessions.delete(sessionID)
      syncSubagentSessions.delete(sessionID)
    }
  }
}
