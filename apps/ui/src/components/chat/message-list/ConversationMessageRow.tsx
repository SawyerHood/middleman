import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import type { ArtifactReference } from '@/lib/artifacts'
import { MessageAttachments } from './MessageAttachments'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { ConversationMessageEntry } from './types'

interface ConversationMessageRowProps {
  message: ConversationMessageEntry
  onArtifactClick?: (artifact: ArtifactReference) => void
  wsUrl?: string
}

export function ConversationMessageRow({
  message,
  onArtifactClick,
  wsUrl,
}: ConversationMessageRowProps) {
  const normalizedText = message.text.trim()
  const hasText = normalizedText.length > 0 && normalizedText !== '.'
  const attachments = message.attachments ?? []

  if (!hasText && attachments.length === 0) {
    return null
  }

  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  if (message.role === 'system') {
    return (
      <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
        <div className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300/90">
          System
        </div>
        <div className="mt-1 space-y-2">
          {hasText ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {normalizedText}
            </p>
          ) : null}
          <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
        </div>
        {timestampLabel || sourceContext ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            <SourceBadge sourceContext={sourceContext} />
            {timestampLabel ? <span>{timestampLabel}</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="user-message-bubble max-w-[85%] rounded-lg rounded-tr-sm px-3 py-2">
          <div className="space-y-2">
            <MessageAttachments attachments={attachments} isUser wsUrl={wsUrl} />
            {hasText ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel || sourceContext ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <SourceBadge sourceContext={sourceContext} isUser />
              {timestampLabel ? (
                <p className="user-message-bubble-meta text-right text-[10px] leading-none">
                  {timestampLabel}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-2 text-foreground">
      {hasText ? (
        <MarkdownMessage content={normalizedText} onArtifactClick={onArtifactClick} />
      ) : null}
      <MessageAttachments attachments={attachments} isUser={false} wsUrl={wsUrl} />
      {timestampLabel || sourceContext ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
