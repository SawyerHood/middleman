import { memo, useEffect, useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  isInternalAgentMessage,
  resolveAgentLabel,
  type AgentLookup,
} from '@/lib/agent-message-utils'
import { cn } from '@/lib/utils'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { AgentMessageEntry } from './types'

function formatDeliveryModeLabel(
  deliveryMode: AgentMessageEntry['requestedDelivery'] | AgentMessageEntry['acceptedMode'],
): string | null {
  if (!deliveryMode) {
    return null
  }

  return deliveryMode === 'followUp' ? 'follow-up' : deliveryMode
}

export const AgentMessageRow = memo(function AgentMessageRow({
  message,
  agentLookup,
}: {
  message: AgentMessageEntry
  agentLookup: AgentLookup
}) {
  const isInternalChatter = isInternalAgentMessage(message)
  const [isExpanded, setIsExpanded] = useState(() => !isInternalChatter)
  const contentId = useId()

  useEffect(() => {
    setIsExpanded(!isInternalChatter)
  }, [
    isInternalChatter,
    message.acceptedMode,
    message.attachmentCount,
    message.fromAgentId,
    message.requestedDelivery,
    message.source,
    message.text,
    message.timestamp,
    message.toAgentId,
  ])

  const fromLabel =
    message.source === 'user_to_agent'
      ? 'User'
      : resolveAgentLabel(message.fromAgentId, agentLookup, 'Agent')
  const toLabel = resolveAgentLabel(message.toAgentId, agentLookup, 'Unknown')
  const normalizedText = message.text.trim()
  const attachmentCount = message.attachmentCount ?? 0
  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext
  const deliveryLabel = formatDeliveryModeLabel(message.requestedDelivery ?? message.acceptedMode)
  const routingSummary = deliveryLabel ? `${fromLabel} → ${toLabel} · ${deliveryLabel}` : `${fromLabel} → ${toLabel}`
  const routingHeader = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
      <span>{fromLabel}</span>
      <span aria-hidden="true">→</span>
      <span>{toLabel}</span>
      {deliveryLabel ? <span className="normal-case tracking-normal">{deliveryLabel}</span> : null}
    </div>
  )
  const detailContent = (
    <>
      {normalizedText ? (
        <p className="mt-1 text-size-chat whitespace-pre-wrap break-words text-[var(--chat-exec-muted-strong)]">
          {normalizedText}
        </p>
      ) : attachmentCount > 0 ? null : (
        <p className="mt-1 text-size-chat-sm italic text-[var(--chat-exec-muted)]">
          Empty message
        </p>
      )}

      {attachmentCount > 0 ? (
        <p className="mt-1 text-size-chat-sm text-[var(--chat-exec-muted)]">
          Sent {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
        </p>
      ) : null}

      {timestampLabel || sourceContext ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-size-chat-sm text-[var(--chat-exec-muted)]">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </>
  )

  return (
    <div className="border-l border-[var(--chat-exec-border)] pl-3">
      {isInternalChatter ? (
        <Button
          type="button"
          variant="ghost"
          aria-controls={contentId}
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((current) => !current)}
          className={cn(
            'h-auto w-full items-center justify-start gap-2 rounded-md px-1 py-1 text-left font-normal',
            'text-[var(--chat-exec-muted)] hover:bg-transparent hover:text-[var(--chat-exec-muted-strong)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-[var(--chat-exec-muted)] transition-transform duration-200',
              isExpanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[10px] tracking-[0.14em]">
            {routingSummary}
          </span>
        </Button>
      ) : (
        routingHeader
      )}

      {isInternalChatter ? (
        isExpanded ? (
          <div id={contentId} className="pl-5">
            {detailContent}
          </div>
        ) : null
      ) : (
        detailContent
      )}
    </div>
  )
})
