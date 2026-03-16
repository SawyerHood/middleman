import { memo, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  isManagerToManagerAgentMessage,
  resolveAgentLabel,
  type AgentLookup,
} from '@/lib/agent-message-utils'
import { cn } from '@/lib/utils'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { AgentMessageEntry } from './types'

export const AgentMessageRow = memo(function AgentMessageRow({
  message,
  agentLookup,
}: {
  message: AgentMessageEntry
  agentLookup: AgentLookup
}) {
  const isManagerToManager = isManagerToManagerAgentMessage(message, agentLookup)
  const [isExpanded, setIsExpanded] = useState(!isManagerToManager)

  useEffect(() => {
    setIsExpanded(!isManagerToManager)
  }, [isManagerToManager, message.fromAgentId, message.timestamp, message.toAgentId])

  const fromLabel =
    message.source === 'user_to_agent'
      ? 'User'
      : resolveAgentLabel(message.fromAgentId, agentLookup, 'Agent')
  const toLabel = resolveAgentLabel(message.toAgentId, agentLookup, 'Unknown')
  const normalizedText = message.text.trim()
  const attachmentCount = message.attachmentCount ?? 0
  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext
  const summaryText =
    normalizedText ||
    (attachmentCount > 0
      ? `Sent ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
      : 'Empty message')

  const deliveryLabel =
    message.requestedDelivery || message.acceptedMode
      ? [
          message.requestedDelivery ? `requested ${message.requestedDelivery}` : null,
          message.acceptedMode ? `accepted ${message.acceptedMode}` : null,
        ]
          .filter(Boolean)
          .join(' • ')
      : null

  return (
    <div className="border-l border-[var(--chat-exec-border)] pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
        <span>{fromLabel}</span>
        <span aria-hidden="true">→</span>
        <span>{toLabel}</span>
        {deliveryLabel ? <span className="normal-case tracking-normal">{deliveryLabel}</span> : null}
      </div>

      {isManagerToManager ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          className="mt-1 flex h-auto w-full items-start justify-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
        >
          {isExpanded ? (
            <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-[var(--chat-exec-muted)]" />
          ) : (
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-[var(--chat-exec-muted)]" />
          )}
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block text-size-chat text-[var(--chat-exec-muted-strong)]',
                isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate',
              )}
            >
              {summaryText}
            </span>
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
            {isExpanded ? 'Collapse' : 'Expand'}
          </span>
        </Button>
      ) : normalizedText ? (
        <p className="mt-1 text-size-chat whitespace-pre-wrap break-words text-[var(--chat-exec-muted-strong)]">
          {normalizedText}
        </p>
      ) : attachmentCount > 0 ? null : (
        <p className="mt-1 text-size-chat-sm italic text-[var(--chat-exec-muted)]">
          Empty message
        </p>
      )}

      {attachmentCount > 0 && (!isManagerToManager || normalizedText) ? (
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
    </div>
  )
})
