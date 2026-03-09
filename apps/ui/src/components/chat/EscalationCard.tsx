import { useEffect, useState } from 'react'
import { Check, CircleDot, ListTodo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { UserEscalation } from '@middleman/protocol'

interface EscalationCardProps {
  escalation: UserEscalation
  variant?: 'chat' | 'panel'
  onResolveEscalation?: (input: {
    escalationId: string
    choice: string
    isCustom: boolean
  }) => Promise<void>
  onOpenEscalationsView?: () => void
}

export function EscalationCard({
  escalation,
  variant = 'chat',
  onResolveEscalation,
  onOpenEscalationsView,
}: EscalationCardProps) {
  const [selectedOption, setSelectedOption] = useState('')
  const [customResponse, setCustomResponse] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const trimmedCustomResponse = customResponse.trim()
  const isResolved = escalation.status === 'resolved'
  const canSubmit = Boolean(
    onResolveEscalation &&
      !isResolved &&
      !isSubmitting &&
      (trimmedCustomResponse.length > 0 || selectedOption),
  )

  useEffect(() => {
    setSelectedOption('')
    setCustomResponse('')
    setIsSubmitting(false)
    setSubmitError(null)
  }, [escalation.id])

  useEffect(() => {
    if (isResolved) {
      setIsSubmitting(false)
      setSubmitError(null)
    }
  }, [isResolved])

  const handleSubmit = async () => {
    if (!onResolveEscalation || !canSubmit) {
      return
    }

    const isCustom = trimmedCustomResponse.length > 0
    const choice = isCustom ? trimmedCustomResponse : selectedOption

    setIsSubmitting(true)
    setSubmitError(null)

    try {
      await onResolveEscalation({
        escalationId: escalation.id,
        choice,
        isCustom,
      })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to send task response.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const statusLabel = escalation.status === 'open' ? 'Open' : 'Resolved'

  return (
    <section
      className={cn(
        'rounded-xl border border-border/70 bg-card/80 text-card-foreground shadow-sm',
        variant === 'chat' ? 'overflow-hidden' : '',
      )}
    >
      <div className={cn('space-y-4', variant === 'chat' ? 'px-4 py-3' : 'px-5 py-5')}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ListTodo className="size-4" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  escalation.status === 'open'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                )}
              >
                <CircleDot className="size-3" aria-hidden="true" />
                {statusLabel}
              </span>
              <span className="text-[11px] text-muted-foreground">{formatDateTime(escalation.createdAt)}</span>
            </div>

            <h3 className="mt-2 text-sm font-semibold leading-snug text-foreground">
              {escalation.title}
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {escalation.description}
            </p>
          </div>
        </div>

        {isResolved ? (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
              <Check className="size-3.5" aria-hidden="true" />
              {escalation.response
                ? escalation.response.isCustom
                  ? 'Custom response'
                  : 'Suggested response'
                : 'Resolved'}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {escalation.response?.choice ?? 'Resolved by agent'}
            </p>
            {escalation.resolvedAt ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Resolved {formatDateTime(escalation.resolvedAt)}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {escalation.options.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Suggested responses
                </p>
                <div className="flex flex-col gap-2">
                  {escalation.options.map((option) => {
                    const isSelected = selectedOption === option

                    return (
                      <button
                        key={option}
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                          isSelected
                            ? 'border-primary/40 bg-primary/10 text-foreground'
                            : 'border-border/60 bg-background text-foreground hover:bg-muted/50',
                          isSubmitting && 'pointer-events-none opacity-60',
                        )}
                        onClick={() => setSelectedOption(option)}
                        disabled={isSubmitting}
                      >
                        <span
                          className={cn(
                            'inline-flex size-4 shrink-0 items-center justify-center rounded-full border',
                            isSelected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/30',
                          )}
                        >
                          {isSelected ? <Check className="size-2.5" aria-hidden="true" strokeWidth={3} /> : null}
                        </span>
                        <span>{option}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Write your own
              </p>
              <Textarea
                value={customResponse}
                onChange={(event) => setCustomResponse(event.target.value)}
                placeholder="Write a custom response..."
                rows={variant === 'panel' ? 5 : 3}
                className="resize-none"
                disabled={isSubmitting}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">
                {trimmedCustomResponse
                  ? 'Your custom response will be sent.'
                  : selectedOption
                    ? 'Suggested response will be sent.'
                    : 'Pick a suggested response or write your own.'}
              </p>

              <div className="flex items-center gap-2">
                {onOpenEscalationsView ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onOpenEscalationsView}
                  >
                    Open tasks
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    void handleSubmit()
                  }}
                  disabled={!canSubmit}
                >
                  {isSubmitting ? 'Sending...' : 'Send response'}
                </Button>
              </div>
            </div>

            {submitError ? (
              <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
