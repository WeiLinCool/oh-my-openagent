import type { ToolContextWithMetadata } from "./types"
import type { OpencodeClient } from "./types"
import type { ParentContext } from "./executor-types"
import type { FilePart } from "@opencode-ai/sdk"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { log } from "../../shared/logger"
import { getMessageDir } from "../../shared/opencode-message-dir"

export async function resolveParentContext(
  ctx: ToolContextWithMetadata,
  client: OpencodeClient
): Promise<ParentContext> {
  const messageDir = getMessageDir(ctx.sessionID)
  const { prevMessage, firstMessageAgent } = await resolveMessageContext(
    ctx.sessionID,
    client,
    messageDir
  )

  const sessionAgent = getSessionAgent(ctx.sessionID)
  const parentAgent = ctx.agent ?? sessionAgent ?? firstMessageAgent ?? prevMessage?.agent

  log("[task] parentAgent resolution", {
    sessionID: ctx.sessionID,
    messageDir,
    ctxAgent: ctx.agent,
    sessionAgent,
    firstMessageAgent,
    prevMessageAgent: prevMessage?.agent,
    resolvedParentAgent: parentAgent,
  })

  const parentModel = prevMessage?.model?.providerID && prevMessage?.model?.modelID
    ? {
        providerID: prevMessage.model.providerID,
        modelID: prevMessage.model.modelID,
        ...(prevMessage.model.variant ? { variant: prevMessage.model.variant } : {}),
      }
    : undefined

  // 从父 session 最新用户消息提取 file parts
  let fileParts: Array<{ type: "file"; mime: string; url: string; filename?: string }> | undefined

  try {
    const messagesResponse = await client.session.messages({ path: { id: ctx.sessionID } })
    if (messagesResponse.data && messagesResponse.data.length > 0) {
      // 找到最新的用户消息
      const userMessages = messagesResponse.data
        .filter(msg => msg.info?.role === "user")
        .sort((a, b) => {
          const aTime = a.info?.time?.created ?? 0
          const bTime = b.info?.time?.created ?? 0
          return bTime - aTime // 降序，最新的在前
        })

      if (userMessages.length > 0) {
        const latestUserMessage = userMessages[0]
        const parts = latestUserMessage.parts ?? []
        // 提取 file parts（图片）
        fileParts = parts
          .filter((part): part is FilePart => part.type === "file" && "mime" in part && typeof part.mime === "string" && part.mime.startsWith("image/"))
          .map(part => ({
            type: "file" as const,
            mime: part.mime,
            url: part.url,
            filename: part.filename,
          }))

        if (fileParts.length > 0) {
          log("[task] 提取到 file parts", {
            sessionID: ctx.sessionID,
            filePartsCount: fileParts.length,
            filePartsMimes: fileParts.map(p => p.mime),
          })
        }
      }
    }
  } catch (error) {
    log("[task] 提取 file parts 失败", { sessionID: ctx.sessionID, error: String(error) })
  }

  return {
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    agent: parentAgent,
    model: parentModel,
    fileParts,
  }
}
