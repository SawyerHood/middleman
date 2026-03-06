import { CircleDashed, Loader2, Menu, Minimize2, MoreHorizontal, PanelRight, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ContextWindowIndicator } from '@/components/chat/ContextWindowIndicator'
import { cn } from '@/lib/utils'
import type { AgentStatus } from '@middleman/protocol'

interface ChatHeaderProps {
  connected: boolean
  activeAgentId: string | null
  activeAgentLabel: string
  activeAgentArchetypeId?: string | null
  activeAgentStatus: AgentStatus | null
  contextWindowUsage: { usedTokens: number; contextWindow: number } | null
  showCompact: boolean
  compactInProgress: boolean
  onCompact: () => void
  showStopAll: boolean
  stopAllInProgress: boolean
  stopAllDisabled: boolean
  onStopAll: () => void
  showNewChat: boolean
  onNewChat: () => void
  isArtifactsPanelOpen: boolean
  onToggleArtifactsPanel: () => void
  onToggleMobileSidebar?: () => void
}

function formatAgentStatus(status: AgentStatus | null): string {
  if (!status) return 'Idle'

  switch (status) {
    case 'streaming':
      return 'Streaming'
    case 'idle':
      return 'Idle'
    case 'terminated':
      return 'Terminated'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Error'
  }
}

export function ChatHeader({
  connected,
  activeAgentId,
  activeAgentLabel,
  activeAgentArchetypeId,
  activeAgentStatus,
  contextWindowUsage,
  showCompact,
  compactInProgress,
  onCompact,
  showStopAll,
  stopAllInProgress,
  stopAllDisabled,
  onStopAll,
  showNewChat,
  onNewChat,
  isArtifactsPanelOpen,
  onToggleArtifactsPanel,
  onToggleMobileSidebar,
}: ChatHeaderProps) {
  const isStreaming = connected && activeAgentStatus === 'streaming'
  const statusLabel = connected ? formatAgentStatus(activeAgentStatus) : 'Reconnecting'
  const archetypeLabel = activeAgentArchetypeId?.trim()

  return (
    <header className="sticky top-0 z-10 flex h-[62px] w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border/80 bg-card/80 px-2 backdrop-blur md:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
        {/* Mobile hamburger */}
        {onToggleMobileSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground md:hidden"
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <Menu className="size-4" />
          </Button>
        ) : null}

        {isStreaming ? (
          <CircleDashed className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Active" />
        ) : (
          <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />
        )}

        <div className="flex min-w-0 items-center gap-1.5">
          <h1
            className="min-w-0 truncate text-sm font-bold text-foreground"
            title={activeAgentId ?? activeAgentLabel}
          >
            {activeAgentLabel}
          </h1>
          {archetypeLabel ? (
            <Badge
              variant="outline"
              className="h-5 max-w-32 shrink-0 border-border/60 bg-muted/40 px-1.5 text-[10px] font-medium text-muted-foreground"
              title={archetypeLabel}
            >
              <span className="truncate">{archetypeLabel}</span>
            </Badge>
          ) : null}
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            ·
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs font-mono text-muted-foreground">
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* ── Inline: context window ── */}
        <div className="hidden sm:inline-flex items-center">
          {contextWindowUsage ? (
            <ContextWindowIndicator
              usedTokens={contextWindowUsage.usedTokens}
              contextWindow={contextWindowUsage.contextWindow}
            />
          ) : null}
        </div>

        {/* ── Three-dots dropdown: secondary actions ── */}
        {(showCompact || showNewChat || showStopAll) ? (
          <>
            <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-4 bg-border/60" />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                    aria-label="More actions"
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
                {showCompact ? (
                  <DropdownMenuItem
                    onClick={onCompact}
                    disabled={compactInProgress}
                    className="gap-2 text-xs"
                  >
                    {compactInProgress ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Minimize2 className="size-3.5" />
                    )}
                    {compactInProgress ? 'Compacting…' : 'Compact context'}
                  </DropdownMenuItem>
                ) : null}

                {showNewChat ? (
                  <DropdownMenuItem
                    onClick={onNewChat}
                    className="gap-2 text-xs"
                  >
                    <Trash2 className="size-3.5" />
                    Clear conversation
                  </DropdownMenuItem>
                ) : null}

                {showStopAll ? (
                  <DropdownMenuItem
                    onClick={onStopAll}
                    disabled={stopAllDisabled || stopAllInProgress}
                    className="gap-2 text-xs text-destructive focus:text-destructive"
                  >
                    {stopAllInProgress ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {stopAllInProgress ? 'Stopping…' : 'Stop All'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}

        {/* ── Inline: artifacts toggle ── */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 shrink-0 transition-colors',
                  isArtifactsPanelOpen
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                )}
                onClick={onToggleArtifactsPanel}
                aria-label={isArtifactsPanelOpen ? 'Close artifacts panel' : 'Open artifacts panel'}
                aria-pressed={isArtifactsPanelOpen}
              />
            }
          >
            <PanelRight className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {isArtifactsPanelOpen ? 'Close artifacts' : 'Artifacts'}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
