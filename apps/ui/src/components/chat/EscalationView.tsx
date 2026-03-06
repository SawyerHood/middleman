import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, Check, CircleDot, ListTodo, PanelLeft, UserRound, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, UserEscalation } from '@middleman/protocol'

interface EscalationViewProps {
  escalations: UserEscalation[]
  managers: AgentDescriptor[]
  onBack: () => void
  onResolveEscalation: (input: {
    escalationId: string
    choice: string
    isCustom: boolean
  }) => Promise<void>
  onToggleMobileSidebar: () => void
}

export function EscalationView({
  escalations,
  managers,
  onBack,
  onResolveEscalation,
  onToggleMobileSidebar,
}: EscalationViewProps) {
  const [selectedEscalationId, setSelectedEscalationId] = useState<string | null>(null)
  const [submittingEscalationId, setSubmittingEscalationId] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [selectedOptionByEscalationId, setSelectedOptionByEscalationId] = useState<Record<string, string>>({})
  const [customResponseByEscalationId, setCustomResponseByEscalationId] = useState<Record<string, string>>({})
  const detailPanelDismissedRef = useRef(false)

  const managerNameById = useMemo(
    () => new Map(managers.map((manager) => [manager.agentId, manager.displayName || manager.agentId])),
    [managers],
  )

  const sortedEscalations = useMemo(
    () => [...escalations].sort(compareEscalations),
    [escalations],
  )
  const selectedEscalation = useMemo(
    () => sortedEscalations.find((escalation) => escalation.id === selectedEscalationId) ?? null,
    [selectedEscalationId, sortedEscalations],
  )
  const openEscalationCount = sortedEscalations.filter((escalation) => escalation.status === 'open').length

  useEffect(() => {
    if (sortedEscalations.length === 0) {
      detailPanelDismissedRef.current = false
      setSelectedEscalationId(null)
      return
    }

    const hasSelectedEscalation = Boolean(
      selectedEscalationId && sortedEscalations.some((escalation) => escalation.id === selectedEscalationId),
    )

    if (hasSelectedEscalation) {
      return
    }

    if (selectedEscalationId) {
      detailPanelDismissedRef.current = false
      setSelectedEscalationId(sortedEscalations[0]?.id ?? null)
      return
    }

    if (!detailPanelDismissedRef.current) {
      setSelectedEscalationId(sortedEscalations[0]?.id ?? null)
    }
  }, [selectedEscalationId, sortedEscalations])

  useEffect(() => {
    setSubmitError(null)
  }, [selectedEscalationId])

  const selectedOption = selectedEscalation ? selectedOptionByEscalationId[selectedEscalation.id] ?? '' : ''
  const customResponse = selectedEscalation ? customResponseByEscalationId[selectedEscalation.id] ?? '' : ''
  const trimmedCustomResponse = customResponse.trim()
  const isResolved = selectedEscalation?.status === 'resolved'
  const isSubmitting = selectedEscalation ? submittingEscalationId === selectedEscalation.id : false
  const canSubmit = Boolean(selectedEscalation && !isResolved && !isSubmitting && (trimmedCustomResponse || selectedOption))

  const handleSubmit = async () => {
    if (!selectedEscalation || !canSubmit) {
      return
    }

    const isCustom = trimmedCustomResponse.length > 0
    const choice = isCustom ? trimmedCustomResponse : selectedOption

    setSubmittingEscalationId(selectedEscalation.id)
    setSubmitError(null)

    try {
      await onResolveEscalation({
        escalationId: selectedEscalation.id,
        choice,
        isCustom,
      })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to resolve escalation.')
    } finally {
      setSubmittingEscalationId((current) => (current === selectedEscalation.id ? null : current))
    }
  }

  const handleSelectEscalation = (escalationId: string) => {
    detailPanelDismissedRef.current = false
    setSelectedEscalationId(escalationId)
    setSubmitError(null)
  }

  const handleCloseDetails = () => {
    detailPanelDismissedRef.current = true
    setSelectedEscalationId(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border/40 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
          <div className="flex items-center gap-2.5">
            <h1 className="text-sm font-semibold text-foreground">Escalations</h1>
            {openEscalationCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-600 dark:text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                {openEscalationCount} open
              </span>
            ) : (
              <span className="text-xs tabular-nums text-muted-foreground/60">
                {sortedEscalations.length} total
              </span>
            )}
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Back
        </Button>
      </div>

      {/* Content */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Escalation list */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            {sortedEscalations.length === 0 ? (
              <div className="px-6 py-20 text-center">
                <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-muted/50">
                  <ListTodo className="size-5 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-foreground/70">No escalations yet</p>
                <p className="mx-auto mt-1.5 max-w-[240px] text-xs leading-relaxed text-muted-foreground/50">
                  When agents need a decision or hit a blocker, it will appear here.
                </p>
              </div>
            ) : (
              <div className="py-1">
                {sortedEscalations.map((escalation) => {
                  const managerName = managerNameById.get(escalation.managerId) ?? escalation.managerId
                  const isSelected = selectedEscalationId === escalation.id

                  return (
                    <button
                      key={escalation.id}
                      type="button"
                      onClick={() => handleSelectEscalation(escalation.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-75',
                        isSelected
                          ? 'bg-muted/60'
                          : 'hover:bg-muted/30',
                      )}
                    >
                      <StatusDot status={escalation.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-foreground/90">{escalation.title}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                          <span className="truncate">{managerName}</span>
                          <span className="shrink-0 text-muted-foreground/30">&middot;</span>
                          <span className="shrink-0">{formatRelativeTime(escalation.createdAt)}</span>
                        </div>
                      </div>
                      {escalation.status === 'open' ? (
                        <StatusPill status="open" />
                      ) : (
                        <StatusPill status="resolved" />
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Mobile backdrop */}
        {selectedEscalation ? (
          <button
            type="button"
            className="fixed inset-0 z-20 bg-black/20 backdrop-blur-[1px] md:hidden"
            aria-label="Close escalation details"
            onClick={handleCloseDetails}
          />
        ) : null}

        {/* Detail panel */}
        <aside
          className={cn(
            'fixed inset-y-0 right-0 z-30 w-full max-w-[34rem] border-l border-border/30 bg-background transition-transform duration-150 ease-out md:static md:z-0 md:max-w-none md:overflow-hidden md:transition-[width,transform]',
            selectedEscalation ? 'translate-x-0 md:w-[28rem]' : 'translate-x-full md:w-0',
          )}
        >
          {selectedEscalation ? (
            <div className="flex h-full min-h-0 flex-col">
              {/* Detail header */}
              <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={selectedEscalation.status} />
                    <span className="text-[11px] text-muted-foreground/50">&middot;</span>
                    <span className="truncate text-[11px] text-muted-foreground/60">
                      {managerNameById.get(selectedEscalation.managerId) ?? selectedEscalation.managerId}
                    </span>
                  </div>
                  <h2 className="mt-2.5 text-[15px] font-semibold leading-snug text-foreground">
                    {selectedEscalation.title}
                  </h2>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCloseDetails}
                  aria-label="Close escalation details"
                  className="mt-0.5 shrink-0 text-muted-foreground/50 hover:text-foreground"
                >
                  <X className="size-4" />
                </Button>
              </div>

              {/* Detail metadata */}
              <div className="flex items-center gap-3.5 px-5 pb-3 text-[11px] text-muted-foreground/50">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="size-3 opacity-60" />
                  {formatDateTime(selectedEscalation.createdAt)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <UserRound className="size-3 opacity-60" />
                  {managerNameById.get(selectedEscalation.managerId) ?? selectedEscalation.managerId}
                </span>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                {/* Description */}
                <section className="border-t border-border/20 px-5 py-4">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                    Description
                  </p>
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80">
                    {selectedEscalation.description}
                  </p>
                </section>

                {/* Response */}
                <section className="border-t border-border/20 px-5 py-4">
                  <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                    Response
                  </p>

                  {isResolved ? (
                    <ResolvedEscalationResponse escalation={selectedEscalation} />
                  ) : (
                    <div className="space-y-4">
                      {/* Option buttons */}
                      {selectedEscalation.options.length > 0 ? (
                        <div className="space-y-1.5">
                          {selectedEscalation.options.map((option) => {
                            const isOptionSelected = selectedOption === option

                            return (
                              <button
                                key={option}
                                type="button"
                                className={cn(
                                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] transition-all duration-100',
                                  isOptionSelected
                                    ? 'bg-primary/10 text-foreground ring-1 ring-primary/30'
                                    : 'text-foreground/80 hover:bg-muted/50 ring-1 ring-border/40 hover:ring-border/60',
                                  isSubmitting && 'opacity-50 pointer-events-none',
                                )}
                                onClick={() =>
                                  setSelectedOptionByEscalationId((current) => ({
                                    ...current,
                                    [selectedEscalation.id]: option,
                                  }))
                                }
                                disabled={isSubmitting}
                              >
                                <span
                                  className={cn(
                                    'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                                    isOptionSelected
                                      ? 'border-primary bg-primary text-primary-foreground'
                                      : 'border-muted-foreground/30',
                                  )}
                                >
                                  {isOptionSelected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span className="flex-1">{option}</span>
                              </button>
                            )
                          })}
                        </div>
                      ) : null}

                      {/* Divider */}
                      {selectedEscalation.options.length > 0 ? (
                        <div className="flex items-center gap-3 px-1">
                          <div className="h-px flex-1 bg-border/30" />
                          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/35">or</span>
                          <div className="h-px flex-1 bg-border/30" />
                        </div>
                      ) : null}

                      {/* Custom response */}
                      <div>
                        <Textarea
                          value={customResponse}
                          onChange={(event) =>
                            setCustomResponseByEscalationId((current) => ({
                              ...current,
                              [selectedEscalation.id]: event.target.value,
                            }))
                          }
                          placeholder="Write a custom response…"
                          rows={3}
                          className="resize-none border-none bg-muted/25 text-[13px] shadow-none placeholder:text-muted-foreground/35 focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-border/50"
                          disabled={isSubmitting}
                        />
                      </div>

                      {/* Submit */}
                      <div className="flex items-center justify-between gap-3 pt-1">
                        <p className="text-[11px] text-muted-foreground/50">
                          {trimmedCustomResponse
                            ? 'Custom response will be sent.'
                            : selectedOption
                              ? 'Selected option will be sent.'
                              : 'Choose an option or write a response.'}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 px-3.5"
                          onClick={() => {
                            void handleSubmit()
                          }}
                          disabled={!canSubmit}
                        >
                          {isSubmitting ? 'Sending…' : 'Send'}
                        </Button>
                      </div>

                      {submitError ? (
                        <p className="rounded-md bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{submitError}</p>
                      ) : null}
                    </div>
                  )}
                </section>
              </ScrollArea>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function ResolvedEscalationResponse({ escalation }: { escalation: UserEscalation }) {
  const responseText = escalation.response?.choice ?? 'Resolved by agent'
  const responseBadgeLabel = escalation.response?.isCustom ? 'Custom response' : 'Selected option'

  return (
    <div className="rounded-lg bg-emerald-500/5 p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15">
          <Check className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
        </span>
        {escalation.response ? (
          <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-600/70 dark:text-emerald-400/70">
            {responseBadgeLabel}
          </span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80">{responseText}</p>
      {escalation.resolvedAt ? (
        <p className="mt-3 text-[11px] text-muted-foreground/50">
          Resolved {formatDateTime(escalation.resolvedAt)}
        </p>
      ) : null}
    </div>
  )
}

function StatusDot({ status }: { status: UserEscalation['status'] }) {
  return (
    <span
      className={cn(
        'mt-0.5 size-2 shrink-0 rounded-full',
        status === 'open'
          ? 'bg-amber-500 dark:bg-amber-400'
          : 'bg-emerald-500/50 dark:bg-emerald-400/50',
      )}
    />
  )
}

function StatusPill({ status }: { status: UserEscalation['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        status === 'open'
          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      )}
    >
      {status}
    </span>
  )
}

function StatusBadge({ status }: { status: UserEscalation['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium',
        status === 'open'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-emerald-600 dark:text-emerald-400',
      )}
    >
      <CircleDot className="size-3" />
      {status === 'open' ? 'Open' : 'Resolved'}
    </span>
  )
}

function compareEscalations(left: UserEscalation, right: UserEscalation): number {
  if (left.status !== right.status) {
    return left.status === 'open' ? -1 : 1
  }

  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt)
  }

  return right.id.localeCompare(left.id)
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

function formatRelativeTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMinutes = Math.floor(diffMs / 60_000)

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return formatDateTime(value)
}
