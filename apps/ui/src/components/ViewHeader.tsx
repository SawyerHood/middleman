import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ViewHeaderProps {
  title?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  onBack?: () => void
  backAriaLabel?: string
  className?: string
  titleClassName?: string
  backButtonClassName?: string
}

export function ViewHeader({
  title,
  leading,
  trailing,
  onBack,
  backAriaLabel = 'Back',
  className,
  titleClassName,
  backButtonClassName,
}: ViewHeaderProps) {
  const titleNode =
    title === undefined || title === null ? null
    : typeof title === 'string' || typeof title === 'number' ? (
      <h1
        className={cn(
          'min-w-0 flex-1 truncate text-sm font-semibold text-foreground',
          titleClassName,
        )}
      >
        {title}
      </h1>
    ) : (
      <div className={cn('min-w-0 flex-1', titleClassName)}>{title}</div>
    )

  return (
    <header
      className={cn(
        'app-top-bar mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-card/80 px-2 backdrop-blur md:px-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-9 w-9 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground',
              backButtonClassName,
            )}
            onClick={onBack}
            aria-label={backAriaLabel}
          >
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        {leading}
        {titleNode}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-2">{trailing}</div>
      ) : null}
    </header>
  )
}
