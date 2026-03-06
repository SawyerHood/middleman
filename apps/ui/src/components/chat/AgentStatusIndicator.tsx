import { cn } from '@/lib/utils'
import type { AgentStatus } from '@middleman/protocol'

type DisplayAgentStatus = AgentStatus | 'reconnecting' | null
type AgentStatusIndicatorSize = 'sm' | 'md'

interface AgentStatusIndicatorProps {
  status: DisplayAgentStatus
  size?: AgentStatusIndicatorSize
  pulsing?: boolean
  className?: string
  ariaLabel?: string
}

const SIZE_CLASS_NAMES: Record<
  AgentStatusIndicatorSize,
  { container: string; pulse: string; dot: string }
> = {
  sm: {
    container: 'size-3.5',
    pulse: 'size-3',
    dot: 'size-2',
  },
  md: {
    container: 'size-5',
    pulse: 'size-4',
    dot: 'size-2.5',
  },
}

function getResolvedStatus(status: DisplayAgentStatus): Exclude<DisplayAgentStatus, null> {
  return status ?? 'idle'
}

function getStatusColorClassName(status: Exclude<DisplayAgentStatus, null>): string {
  switch (status) {
    case 'streaming':
      return 'bg-emerald-500'
    case 'idle':
      return 'bg-amber-400'
    case 'error':
      return 'bg-red-500'
    case 'terminated':
      return 'bg-zinc-400'
    case 'stopped':
      return 'bg-zinc-500'
    case 'reconnecting':
      return 'bg-amber-500'
  }
}

export function AgentStatusIndicator({
  status,
  size = 'sm',
  pulsing = false,
  className,
  ariaLabel,
}: AgentStatusIndicatorProps) {
  const resolvedStatus = getResolvedStatus(status)
  const sizeClassNames = SIZE_CLASS_NAMES[size]
  const colorClassName = getStatusColorClassName(resolvedStatus)

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center',
        sizeClassNames.container,
        className,
      )}
      aria-hidden={ariaLabel ? undefined : 'true'}
      aria-label={ariaLabel}
    >
      {pulsing && resolvedStatus === 'streaming' ? (
        <span
          className={cn('absolute inline-flex animate-ping rounded-full bg-emerald-500/35', sizeClassNames.pulse)}
          aria-hidden="true"
        />
      ) : null}
      <span
        className={cn('relative inline-flex rounded-full', sizeClassNames.dot, colorClassName)}
        aria-hidden="true"
      />
    </span>
  )
}
