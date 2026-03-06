import { cn } from '@/lib/utils'
import type { MessageSourceContext } from '@middleman/protocol'

export function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function formatSourceBadge(sourceContext?: MessageSourceContext): string | null {
  if (!sourceContext) {
    return null
  }

  if (sourceContext.channel === 'web') {
    return 'Web'
  }

  const isSlack = sourceContext.channel === 'slack'
  const isTelegram = sourceContext.channel === 'telegram'
  const isDm =
    sourceContext.channelType === 'dm' ||
    (isSlack && sourceContext.channelId?.startsWith('D'))

  let label = isTelegram ? 'Telegram' : 'Slack'

  if (isDm) {
    if (isTelegram) {
      label = sourceContext.userId
        ? `Telegram DM ${sourceContext.userId}`
        : 'Telegram DM'
    } else {
      label = sourceContext.userId ? `Slack DM ${sourceContext.userId}` : 'Slack DM'
    }
  } else if (sourceContext.channelId) {
    label = isTelegram
      ? `Telegram ${sourceContext.channelId}`
      : `Slack #${sourceContext.channelId}`
  }

  if (sourceContext.threadTs) {
    return `${label} → thread`
  }

  return label
}

export function SourceBadge({
  sourceContext,
  isUser = false,
}: {
  sourceContext?: MessageSourceContext
  isUser?: boolean
}) {
  const label = formatSourceBadge(sourceContext)
  if (!label || !sourceContext) {
    return null
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        isUser
          ? 'user-message-bubble-pill'
          : sourceContext.channel === 'slack'
            ? 'border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300'
            : sourceContext.channel === 'telegram'
              ? 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300'
              : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
    >
      [{label}]
    </span>
  )
}
