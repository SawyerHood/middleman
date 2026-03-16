import { useEffect, useMemo, useState } from 'react'
import {
  Clock3,
  Code2,
  Database,
  FileCode2,
  FileText,
  Image,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ArtifactReference } from '@/lib/artifacts'
import {
  categorizeArtifact,
  type ArtifactCategory,
} from '@/lib/collect-artifacts'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'

interface ArtifactsSidebarProps {
  wsUrl: string
  managerId: string
  artifacts: ArtifactReference[]
  isOpen: boolean
  onClose: () => void
  onArtifactClick: (artifact: ArtifactReference) => void
}

interface ScheduleRecord {
  id: string
  name: string
  cron: string
  message: string
  oneShot: boolean
  timezone: string
  createdAt: string
  nextFireAt: string
  lastFiredAt?: string
}

type SidebarTab = 'artifacts' | 'schedules'

function getCategoryIcon(category: ArtifactCategory) {
  switch (category) {
    case 'document':
      return FileText
    case 'code':
      return Code2
    case 'data':
      return Database
    case 'image':
      return Image
    case 'other':
      return FileCode2
  }
}

function getFileIcon(fileName: string) {
  const category = categorizeArtifact(fileName)
  return getCategoryIcon(category)
}

function truncatePath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path
  const segments = path.split('/')
  if (segments.length <= 3) return path

  const fileName = segments[segments.length - 1]
  const remaining = maxLength - fileName.length - 4 // account for .../
  if (remaining <= 0) return `…/${fileName}`

  let prefix = ''
  for (const seg of segments.slice(0, -1)) {
    if ((prefix + seg + '/').length > remaining) break
    prefix += `${seg}/`
  }

  return prefix ? `${prefix}…/${fileName}` : `…/${fileName}`
}

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeSchedule(value: unknown): ScheduleRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const entry = value as Partial<ScheduleRecord>
  const id = normalizeRequiredString(entry.id)
  const name = normalizeRequiredString(entry.name)
  const cron = normalizeRequiredString(entry.cron)
  const message = normalizeRequiredString(entry.message)
  const timezone = normalizeRequiredString(entry.timezone)
  const createdAt = normalizeRequiredString(entry.createdAt)
  const nextFireAt = normalizeRequiredString(entry.nextFireAt)

  if (!id || !name || !cron || !message || !timezone || !createdAt || !nextFireAt) {
    return null
  }

  const lastFiredAt = normalizeRequiredString(entry.lastFiredAt) ?? undefined

  return {
    id,
    name,
    cron,
    message,
    oneShot: typeof entry.oneShot === 'boolean' ? entry.oneShot : false,
    timezone,
    createdAt,
    nextFireAt,
    lastFiredAt,
  }
}

function resolveManagerSchedulesEndpoint(wsUrl: string, managerId: string): string {
  const normalizedManagerId = managerId.trim()
  if (!normalizedManagerId) {
    throw new Error('managerId is required.')
  }
  return resolveApiEndpoint(wsUrl, `/api/managers/${encodeURIComponent(normalizedManagerId)}/schedules`)
}

async function fetchSchedules(wsUrl: string, managerId: string, signal: AbortSignal): Promise<ScheduleRecord[]> {
  const response = await fetch(resolveManagerSchedulesEndpoint(wsUrl, managerId), { signal })
  if (!response.ok) {
    throw new Error(`Unable to load schedules (${response.status})`)
  }

  const payload = (await response.json()) as { schedules?: unknown }
  if (!payload || !Array.isArray(payload.schedules)) {
    return []
  }

  return payload.schedules
    .map((entry) => normalizeSchedule(entry))
    .filter((entry): entry is ScheduleRecord => entry !== null)
}

function sortSchedules(left: ScheduleRecord, right: ScheduleRecord): number {
  const leftTs = Date.parse(left.nextFireAt)
  const rightTs = Date.parse(right.nextFireAt)

  if (!Number.isNaN(leftTs) && !Number.isNaN(rightTs)) {
    return leftTs - rightTs
  }

  if (!Number.isNaN(leftTs)) return -1
  if (!Number.isNaN(rightTs)) return 1

  return left.name.localeCompare(right.name)
}

function formatDateTime(value: string, timeZone?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown'
  }

  try {
    return date.toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    })
  } catch {
    return date.toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }
}

function format24HourTime(hour: string, minute: string): string | null {
  const numericHour = Number.parseInt(hour, 10)
  const numericMinute = Number.parseInt(minute, 10)

  if (
    Number.isNaN(numericHour) ||
    Number.isNaN(numericMinute) ||
    numericHour < 0 ||
    numericHour > 23 ||
    numericMinute < 0 ||
    numericMinute > 59
  ) {
    return null
  }

  return `${numericHour.toString().padStart(2, '0')}:${numericMinute.toString().padStart(2, '0')}`
}

function isWildcard(value: string): boolean {
  return value === '*'
}

function isStep(value: string): boolean {
  return /^\*\/\d+$/.test(value)
}

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value)
}

function parseDayOfWeek(value: string): string | null {
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (!isNumeric(value)) {
    return null
  }

  const dayIndex = Number.parseInt(value, 10)
  if (dayIndex < 0 || dayIndex > 7) {
    return null
  }

  return weekdays[dayIndex % 7] ?? null
}

function describeCronExpression(cron: string): string {
  const segments = cron.trim().split(/\s+/)
  if (segments.length < 5 || segments.length > 6) {
    return 'Custom cron schedule'
  }

  const startIndex = segments.length === 6 ? 1 : 0
  const minute = segments[startIndex] ?? '*'
  const hour = segments[startIndex + 1] ?? '*'
  const dayOfMonth = segments[startIndex + 2] ?? '*'
  const month = segments[startIndex + 3] ?? '*'
  const dayOfWeek = segments[startIndex + 4] ?? '*'

  if ([minute, hour, dayOfMonth, month, dayOfWeek].every(isWildcard)) {
    return 'Every minute'
  }

  if (isStep(minute) && isWildcard(hour) && isWildcard(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    return `Every ${minute.slice(2)} minutes`
  }

  if (isNumeric(minute) && isWildcard(hour) && isWildcard(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    return `At minute ${minute} past every hour`
  }

  if (isNumeric(minute) && isNumeric(hour) && isWildcard(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    const time = format24HourTime(hour, minute)
    return time ? `Every day at ${time}` : 'Custom cron schedule'
  }

  if (isNumeric(minute) && isNumeric(hour) && isWildcard(dayOfMonth) && isWildcard(month)) {
    const time = format24HourTime(hour, minute)
    const weekday = parseDayOfWeek(dayOfWeek)
    if (time && weekday) {
      return `Every ${weekday} at ${time}`
    }
  }

  if (isNumeric(minute) && isNumeric(hour) && isNumeric(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    const time = format24HourTime(hour, minute)
    return time ? `Day ${dayOfMonth} of each month at ${time}` : 'Custom cron schedule'
  }

  return 'Custom cron schedule'
}

function isSidebarTab(value: string): value is SidebarTab {
  return value === 'artifacts' || value === 'schedules'
}

export function ArtifactsSidebar({
  wsUrl,
  managerId,
  artifacts,
  isOpen,
  onClose,
  onArtifactClick,
}: ArtifactsSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('artifacts')
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [isLoadingSchedules, setIsLoadingSchedules] = useState(false)
  const [schedulesError, setSchedulesError] = useState<string | null>(null)
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null)

  const sortedSchedules = useMemo(
    () => [...schedules].sort(sortSchedules),
    [schedules],
  )

  const selectedSchedule = useMemo(() => {
    if (sortedSchedules.length === 0) return null
    if (!selectedScheduleId) return sortedSchedules[0]
    return sortedSchedules.find((schedule) => schedule.id === selectedScheduleId) ?? sortedSchedules[0]
  }, [selectedScheduleId, sortedSchedules])

  useEffect(() => {
    if (!isOpen || activeTab !== 'schedules') {
      return
    }

    if (!managerId.trim()) {
      setSchedules([])
      setSelectedScheduleId(null)
      setSchedulesError('Select a manager to load schedules.')
      setIsLoadingSchedules(false)
      return
    }

    const abortController = new AbortController()
    setIsLoadingSchedules(true)
    setSchedulesError(null)

    void fetchSchedules(wsUrl, managerId, abortController.signal)
      .then((nextSchedules) => {
        if (abortController.signal.aborted) return
        setSchedules(nextSchedules)
        setSelectedScheduleId((current) => {
          if (current && nextSchedules.some((schedule) => schedule.id === current)) {
            return current
          }
          return nextSchedules[0]?.id ?? null
        })
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return
        const message = error instanceof Error ? error.message : 'Unable to load schedules'
        setSchedules([])
        setSchedulesError(message)
        setSelectedScheduleId(null)
      })
      .finally(() => {
        if (abortController.signal.aborted) return
        setIsLoadingSchedules(false)
      })

    return () => {
      abortController.abort()
    }
  }, [activeTab, isOpen, managerId, wsUrl])

  return (
    <div
      className={cn(
        'app-shell-height flex shrink-0 flex-col border-l border-border/80 bg-card/50',
        'transition-[width,opacity] duration-200 ease-out',
        // Mobile: full screen overlay when open
        isOpen
          ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:w-[300px] md:opacity-100'
          : 'w-0 opacity-0 overflow-hidden max-md:hidden',
        isOpen && 'opacity-100',
      )}
      aria-label="Artifacts panel"
      aria-hidden={!isOpen}
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isSidebarTab(value)) {
            setActiveTab(value)
          }
        }}
        className="h-full gap-0"
      >
        <div className="app-top-bar flex shrink-0 items-center gap-2 px-3">
          <TabsList className="h-7 w-full bg-muted/60 p-0.5">
            <TabsTrigger
              value="artifacts"
              className="h-6 rounded-sm px-2.5 text-[11px] font-medium data-active:bg-background data-active:text-foreground data-active:shadow-sm"
            >
              Artifacts
            </TabsTrigger>
            <TabsTrigger
              value="schedules"
              className="h-6 rounded-sm px-2.5 text-[11px] font-medium data-active:bg-background data-active:text-foreground data-active:shadow-sm"
            >
              Schedules
            </TabsTrigger>
          </TabsList>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={onClose}
            aria-label="Close artifacts panel"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <TabsContent value="artifacts" className="mt-0 min-h-0 flex-1">
          <ScrollArea
            className={cn(
              'min-h-0 flex-1',
              '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
              '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
              'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
            )}
          >
            {artifacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <FileText className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  No artifacts yet
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  Files and links from the conversation will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-0.5 p-2">
                {artifacts.map((artifact) => (
                  <ArtifactRow
                    key={artifact.path}
                    artifact={artifact}
                    onClick={onArtifactClick}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="schedules" className="mt-0 min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col">
            {isLoadingSchedules ? (
              <div className="flex h-full items-center justify-center px-4 py-12 text-center">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  Loading schedules...
                </div>
              </div>
            ) : null}

            {!isLoadingSchedules && schedulesError ? (
              <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
                <Clock3 className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  Unable to load schedules
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  {schedulesError}
                </p>
              </div>
            ) : null}

            {!isLoadingSchedules && !schedulesError && sortedSchedules.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
                <Clock3 className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  No schedules yet
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  Cron jobs will appear here once scheduled.
                </p>
              </div>
            ) : null}

            {!isLoadingSchedules && !schedulesError && sortedSchedules.length > 0 ? (
              <>
                <ScrollArea
                  className={cn(
                    'min-h-0 flex-1',
                    '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
                    '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
                    'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
                  )}
                >
                  <div className="space-y-0.5 p-2">
                    {sortedSchedules.map((schedule) => (
                      <button
                        key={schedule.id}
                        type="button"
                        className={cn(
                          'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                          'transition-colors duration-100',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
                          selectedSchedule?.id === schedule.id
                            ? 'bg-accent/50 text-foreground'
                            : 'text-foreground hover:bg-accent/70',
                        )}
                        onClick={() => setSelectedScheduleId(schedule.id)}
                        title={schedule.name}
                      >
                        <span
                          className={cn(
                            'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                            selectedSchedule?.id === schedule.id
                              ? 'bg-primary/15 text-primary'
                              : 'bg-muted/60 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary',
                          )}
                        >
                          <Clock3 className="size-3.5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {schedule.name}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground/70">
                            {describeCronExpression(schedule.cron)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>

                {selectedSchedule ? (
                  <div className="shrink-0 border-t border-border/80 p-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Clock3 className="size-3" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-xs font-semibold leading-snug text-foreground">
                          {selectedSchedule.name}
                        </h3>
                        <span className="mt-0.5 inline-block rounded-full bg-muted/80 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          {selectedSchedule.oneShot ? 'One-time' : 'Recurring'}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2 text-[11px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="shrink-0 text-muted-foreground">Schedule</span>
                        <span className="truncate text-right font-medium text-foreground">
                          {describeCronExpression(selectedSchedule.cron)}
                        </span>
                      </div>

                      <div className="flex items-baseline justify-between gap-2">
                        <span className="shrink-0 text-muted-foreground">Expression</span>
                        <code className="truncate rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px] text-foreground">
                          {selectedSchedule.cron}
                        </code>
                      </div>

                      <div className="flex items-baseline justify-between gap-2">
                        <span className="shrink-0 text-muted-foreground">Next fire</span>
                        <span className="truncate text-right text-foreground">
                          {formatDateTime(selectedSchedule.nextFireAt, selectedSchedule.timezone)}
                        </span>
                      </div>

                      {selectedSchedule.lastFiredAt ? (
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="shrink-0 text-muted-foreground">Last fired</span>
                          <span className="truncate text-right text-foreground">
                            {formatDateTime(selectedSchedule.lastFiredAt)}
                          </span>
                        </div>
                      ) : null}

                      <div className="flex items-baseline justify-between gap-2">
                        <span className="shrink-0 text-muted-foreground">Timezone</span>
                        <span className="truncate text-right text-foreground">
                          {selectedSchedule.timezone}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3">
                      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                        Message
                      </p>
                      <div className="rounded-lg bg-muted/30 p-2.5 ring-1 ring-border/40">
                        <ScrollArea className="max-h-24">
                          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                            {selectedSchedule.message}
                          </p>
                        </ScrollArea>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ArtifactRow({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  const FileIcon = getFileIcon(artifact.fileName)
  const truncatedPath = truncatePath(artifact.path)

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-100',
        'hover:bg-accent/70',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
      )}
      onClick={() => onClick(artifact)}
      title={artifact.path}
    >
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        <FileIcon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {artifact.fileName}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
          {truncatedPath}
        </span>
      </span>
    </button>
  )
}
