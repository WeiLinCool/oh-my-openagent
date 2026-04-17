import type { ALLOWED_AGENTS } from "./constants"

export type AllowedAgentType = (typeof ALLOWED_AGENTS)[number]

export interface CallOmoAgentArgs {
  description: string
  prompt: string
  subagent_type: string
  run_in_background: boolean
  session_id?: string
  /** 附加的消息 parts（图片/文件附件），将传递给子 agent */
  parts?: Array<{ type: "file"; mime: string; url: string; filename?: string } | { type: "text"; text: string }>
}

export interface CallOmoAgentSyncResult {
  title: string
  metadata: {
    summary?: Array<{
      id: string
      tool: string
      state: {
        status: string
        title?: string
      }
    }>
    sessionId: string
  }
  output: string
}
export type ToolContextWithMetadata = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
}
