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

  return sourceContext.channel === 'web' ? 'Web' : null
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
          : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
    >
      [{label}]
    </span>
  )
}
