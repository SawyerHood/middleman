import { ChevronDown, ChevronRight, CircleDashed, ListTodo, Settings, SquarePen, UserStar, X } from 'lucide-react'
import { ViewHeader } from '@/components/ViewHeader'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { buildManagerTreeRows } from '@/lib/agent-hierarchy'
import { inferModelPreset } from '@/lib/model-preset'
import { cn } from '@/lib/utils'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  ManagerModelPreset,
  UserEscalation,
} from '@middleman/protocol'

interface AgentSidebarProps {
  connected: boolean
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isEscalationsActive: boolean
  escalations: UserEscalation[]
  isMobileOpen?: boolean
  onMobileClose?: () => void
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenEscalations: () => void
  onOpenSettings: () => void
}

type AgentLiveStatus = {
  status: AgentStatus
  pendingCount: number
}

function ClaudeCodeIconPair({ className }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <img src="/agents/claude-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain', className)} />
      <img src="/agents/claude-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain opacity-70', className)} />
    </span>
  )
}

function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>,
): AgentLiveStatus {
  const live = statuses[agent.agentId]
  return {
    status: live?.status ?? agent.status,
    pendingCount: live?.pendingCount ?? 0,
  }
}

function RuntimeIcon({ agent, className }: { agent: AgentDescriptor; className?: string }) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-opus') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img src="/pi-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
        <img src="/agents/claude-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain', className)} />
      </span>
    )
  }

  if (preset === 'pi-codex') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img src="/pi-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
        <img
          src="/agents/codex-logo.svg"
          alt=""
          className={cn('size-3 shrink-0 object-contain dark:invert', className)}
        />
      </span>
    )
  }

  if (preset === 'codex-app') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img src="/agents/codex-app-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
        <img src="/agents/codex-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
      </span>
    )
  }

  if (preset === 'claude-code' || provider === 'anthropic-claude-code') {
    return <ClaudeCodeIconPair className={className} />
  }

  if (provider.includes('anthropic') || provider.includes('claude')) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className={className} />
  }

  if (provider.includes('openai')) {
    return <img src="/agents/codex-logo.svg" alt="" aria-hidden="true" className={cn('dark:invert', className)} />
  }

  return <span className={cn('inline-block size-1.5 rounded-full bg-current', className)} aria-hidden="true" />
}

function getModelLabel(agent: AgentDescriptor, preset: ManagerModelPreset | undefined): string {
  if (preset === 'pi-opus') {
    return 'opus'
  }

  if (preset === 'pi-codex' || preset === 'codex-app') {
    return 'codex'
  }

  if (preset === 'claude-code') {
    return 'claude-code'
  }

  const modelId = agent.model.modelId.trim().toLowerCase()

  if (modelId.startsWith('claude-opus')) {
    return 'opus'
  }

  if (modelId.includes('codex')) {
    return 'codex'
  }

  return agent.model.modelId
}


function AgentActivitySlot({
  isActive,
  isSelected,
  streamingWorkerCount,
}: {
  isActive: boolean
  isSelected: boolean
  streamingWorkerCount?: number
}) {
  // When collapsed with active workers, show CircleDashed spinner with count inside
  if (streamingWorkerCount && streamingWorkerCount > 0) {
    return (
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={<span className="relative inline-flex size-3.5 shrink-0 items-center justify-center" />}
            aria-label={`${streamingWorkerCount} active worker${streamingWorkerCount !== 1 ? 's' : ''}`}
          >
            <CircleDashed
              className={cn(
                'absolute inset-0 size-3.5 animate-spin',
                isSelected ? 'text-sidebar-accent-foreground/80' : 'text-muted-foreground',
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                'relative text-[7px] font-bold leading-none',
                isSelected ? 'text-sidebar-accent-foreground' : 'text-muted-foreground',
              )}
            >
              {streamingWorkerCount}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
            {streamingWorkerCount} worker{streamingWorkerCount !== 1 ? 's' : ''} active
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (!isActive) {
    return <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />
  }

  return (
    <CircleDashed
      className={cn(
        'size-3.5 shrink-0 animate-spin',
        isSelected ? 'text-sidebar-accent-foreground/80' : 'text-muted-foreground',
      )}
      aria-label="Active"
    />
  )
}

function AgentRow({
  agent,
  liveStatus,
  isSelected,
  onSelect,
  onDelete,
  className,
  nameClassName,
  streamingWorkerCount,
}: {
  agent: AgentDescriptor
  liveStatus: AgentLiveStatus
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
  className: string
  nameClassName?: string
  streamingWorkerCount?: number
}) {
  const title = agent.displayName || agent.agentId
  const isActive = liveStatus.status === 'streaming'
  const preset = inferModelPreset(agent)
  const modelLabel = getModelLabel(agent, preset)
  const modelDescription = `${agent.model.provider}/${agent.model.modelId}`

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn(
          'flex w-full items-center gap-1 rounded-md transition-colors',
          isSelected
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          className,
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          title={title}
        >
          <AgentActivitySlot isActive={isActive} isSelected={isSelected} streamingWorkerCount={streamingWorkerCount} />
          <span className={cn('min-w-0 flex-1 truncate text-sm leading-5', nameClassName)}>{title}</span>

          <TooltipProvider delay={200}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      'ml-1 inline-flex h-5 w-8 shrink-0 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar-accent/40 px-0.5',
                      isSelected ? 'border-sidebar-ring/60 bg-sidebar-accent-foreground/10' : '',
                    )}
                  />
                }
              >
                <RuntimeIcon agent={agent} className="size-3 shrink-0 object-contain opacity-90" />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                <p className="font-medium">{modelLabel}</p>
                <p className="opacity-80">{modelDescription}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function AgentSidebar({
  connected,
  agents,
  statuses,
  selectedAgentId,
  isSettingsActive,
  isEscalationsActive,
  escalations,
  isMobileOpen = false,
  onMobileClose,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
  onOpenEscalations,
  onOpenSettings,
}: AgentSidebarProps) {
  const { managerRows, orphanWorkers } = buildManagerTreeRows(agents)
  const [expandedManagerIds, setExpandedManagerIds] = useState<Set<string>>(() => new Set())
  const openEscalationCount = escalations.filter((escalation) => escalation.status === 'open').length

  const toggleManagerCollapsed = (managerId: string) => {
    setExpandedManagerIds((previous) => {
      const next = new Set(previous)

      if (next.has(managerId)) {
        next.delete(managerId)
      } else {
        next.add(managerId)
      }

      return next
    })
  }

  const handleSelectAgent = (agentId: string) => {
    onSelectAgent(agentId)
    onMobileClose?.()
  }

  const handleOpenSettings = () => {
    onOpenSettings()
    onMobileClose?.()
  }

  const handleOpenEscalations = () => {
    onOpenEscalations()
    onMobileClose?.()
  }

  const sidebarContent = (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        // Desktop: fixed width in flex layout
        'max-md:w-full md:w-[20rem] md:min-w-[20rem] md:shrink-0',
      )}
    >
      <ViewHeader
        className="border-sidebar-border bg-sidebar px-2 md:px-2 backdrop-blur-none"
        leading={
          <button
            type="button"
            onClick={onAddManager}
            className="flex min-h-[44px] flex-1 items-center gap-2 rounded-md p-2 text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            title="Create manager"
            aria-label="Add manager"
          >
            <SquarePen aria-hidden="true" className="h-4 w-4" />
            <span>New Manager</span>
          </button>
        }
        trailing={
          <div className="flex items-center gap-1.5">
            <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground">
              <span
                className={cn(
                  'inline-block size-1.5 rounded-full',
                  connected ? 'bg-emerald-500' : 'bg-amber-500',
                )}
                title={connected ? 'Connected' : 'Reconnecting'}
              />
              <span className="hidden xl:inline">{connected ? 'Live' : 'Retrying'}</span>
            </div>
            {onMobileClose ? (
              <button
                type="button"
                onClick={onMobileClose}
                className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground md:hidden"
                aria-label="Close sidebar"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        }
      />

      <div className="px-3 pb-1">
        <h2 className="text-xs font-semibold text-muted-foreground">Agents</h2>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--sidebar-border) transparent',
        }}
      >
        {managerRows.length === 0 ? (
          <p className="rounded-md bg-sidebar-accent/50 px-3 py-4 text-center text-xs text-muted-foreground">
            No active agents.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {managerRows.map(({ manager, workers }) => {
              const managerLiveStatus = getAgentLiveStatus(manager, statuses)
              const managerIsSelected =
                !isSettingsActive && !isEscalationsActive && selectedAgentId === manager.agentId
              const managerIsCollapsed = !expandedManagerIds.has(manager.agentId)
              const streamingWorkerCount = managerIsCollapsed
                ? workers.filter((w) => getAgentLiveStatus(w, statuses).status === 'streaming').length
                : 0

              return (
                <li key={manager.agentId}>
                  <div className="relative flex items-center">
                    <AgentRow
                      agent={manager}
                      liveStatus={managerLiveStatus}
                      isSelected={managerIsSelected}
                      onSelect={() => handleSelectAgent(manager.agentId)}
                      onDelete={() => onDeleteManager(manager.agentId)}
                      nameClassName="font-semibold"
                      className="min-w-0 flex-1 py-1.5 pl-7 pr-1.5"
                      streamingWorkerCount={managerIsCollapsed ? streamingWorkerCount : undefined}
                    />

                    <button
                      type="button"
                      onClick={() => toggleManagerCollapsed(manager.agentId)}
                      aria-label={`${managerIsCollapsed ? 'Expand' : 'Collapse'} manager ${manager.agentId}`}
                      aria-expanded={!managerIsCollapsed}
                      className={cn(
                        'group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                        'hover:text-sidebar-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                    >
                      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                        {managerIsCollapsed ? (
                          <>
                            <UserStar
                              aria-hidden="true"
                              className="size-3.5 opacity-70 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                            />
                            <ChevronRight
                              aria-hidden="true"
                              className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                            />
                          </>
                        ) : (
                          <>
                            <UserStar
                              aria-hidden="true"
                              className="size-3.5 opacity-70 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                            />
                            <ChevronDown
                              aria-hidden="true"
                              className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                            />
                          </>
                        )}
                      </span>
                    </button>
                  </div>

                  {workers.length > 0 && !managerIsCollapsed ? (
                    <div className="relative mt-0.5">
                      <div className="absolute bottom-1 left-3.5 top-0 w-px bg-sidebar-border/40" />
                      <ul className="space-y-0.5">
                        {workers.map((worker) => {
                          const workerLiveStatus = getAgentLiveStatus(worker, statuses)
                          const workerIsSelected =
                            !isSettingsActive && !isEscalationsActive && selectedAgentId === worker.agentId

                          return (
                            <li key={worker.agentId}>
                              <AgentRow
                                agent={worker}
                                liveStatus={workerLiveStatus}
                                isSelected={workerIsSelected}
                                onSelect={() => handleSelectAgent(worker.agentId)}
                                onDelete={() => onDeleteAgent(worker.agentId)}
                                nameClassName="font-normal"
                                className="py-1.5 pl-7 pr-1.5"
                              />
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ) : null}
                </li>
              )
            })}

            {orphanWorkers.length > 0 ? (
              <li className="mt-3">
                <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
                  Unassigned
                </p>
                <ul className="space-y-0.5">
                  {orphanWorkers.map((worker) => {
                    const workerLiveStatus = getAgentLiveStatus(worker, statuses)
                    const workerIsSelected =
                      !isSettingsActive && !isEscalationsActive && selectedAgentId === worker.agentId

                    return (
                      <li key={worker.agentId}>
                        <AgentRow
                          agent={worker}
                          liveStatus={workerLiveStatus}
                          isSelected={workerIsSelected}
                          onSelect={() => handleSelectAgent(worker.agentId)}
                          onDelete={() => onDeleteAgent(worker.agentId)}
                          nameClassName="font-normal"
                          className="py-1.5 pl-7 pr-1.5"
                        />
                      </li>
                    )
                  })}
                </ul>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <div className="space-y-1">
          <button
            type="button"
            onClick={handleOpenEscalations}
            className={cn(
              'flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
              isEscalationsActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
            aria-pressed={isEscalationsActive}
          >
            <ListTodo aria-hidden="true" className="size-4" />
            <span className="flex-1 text-left">Your Tasks</span>
            {openEscalationCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium tabular-nums text-amber-600 dark:text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                {openEscalationCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={handleOpenSettings}
            className={cn(
              'flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
              isSettingsActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
            aria-pressed={isSettingsActive}
          >
            <Settings aria-hidden="true" className="size-4" />
            <span>Settings</span>
          </button>


        </div>
      </div>
    </aside>
  )

  return (
    <>
      {/* Desktop: render inline */}
      <div className="hidden md:flex md:shrink-0">
        {sidebarContent}
      </div>

      {/* Mobile: render as overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 md:hidden',
          isMobileOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        {/* Backdrop */}
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-200',
            isMobileOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onMobileClose}
          aria-hidden="true"
        />
        {/* Sidebar panel */}
        <div
          className={cn(
            'relative z-10 h-full w-[80vw] max-w-[20rem] transition-transform duration-200 ease-out',
            isMobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {sidebarContent}
        </div>
      </div>
    </>
  )
}
