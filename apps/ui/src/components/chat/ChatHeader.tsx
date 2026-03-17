import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  CircleDashed,
  Loader2,
  Menu,
  MoreHorizontal,
  PanelRight,
  Settings2,
  Square,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextWindowIndicator } from '@/components/chat/ContextWindowIndicator'
import { isWorkingAgentStatus } from '@/lib/agent-status'
import { showInternalChatterAtom } from '@/lib/chat-view-preferences'
import { inferModelPreset } from '@/lib/model-preset'
import { cn } from '@/lib/utils'
import {
  activeAgentArchetypeIdAtom,
  activeAgentAtom,
  activeAgentIdAtom,
  activeAgentLabelAtom,
  activeAgentStatusAtom,
  canStopAllAgentsAtom,
  connectedAtom,
  contextWindowAtom,
} from '@/lib/ws-state'
import {
  MANAGER_MODEL_PRESETS,
  type AgentStatus,
  type ManagerModelPreset,
  type ModelPreset,
} from '@middleman/protocol'

interface ChatHeaderProps {
  connected?: boolean
  activeAgentId?: string | null
  activeAgentLabel?: string
  activeAgentArchetypeId?: string | null
  activeAgentStatus?: AgentStatus | null
  contextWindowUsage?: { usedTokens: number; contextWindow: number } | null
  showStopAll?: boolean
  stopAllInProgress: boolean
  stopAllDisabled?: boolean
  onStopAll: () => void
  showNewChat?: boolean
  onNewChat: () => void
  showInternalChatter?: boolean
  onShowInternalChatterChange?: (nextValue: boolean) => void
  isArtifactsPanelOpen: boolean
  onToggleArtifactsPanel: () => void
  managerModelUpdateInProgress?: boolean
  onUpdateManagerModel?: (model: ManagerModelPreset) => Promise<void>
  onToggleMobileSidebar?: () => void
}

function formatAgentStatus(status: AgentStatus | null): string {
  if (!status) return 'Idle'

  switch (status) {
    case 'created':
      return 'Created'
    case 'starting':
      return 'Starting'
    case 'idle':
      return 'Idle'
    case 'busy':
      return 'Busy'
    case 'interrupting':
      return 'Interrupting'
    case 'stopping':
      return 'Stopping'
    case 'terminated':
      return 'Terminated'
    case 'stopped':
      return 'Stopped'
    case 'errored':
      return 'Error'
  }
}

function isManagerModelPreset(
  value: ModelPreset | null | undefined,
): value is ManagerModelPreset {
  return value === 'pi-codex' || value === 'pi-opus'
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'An unexpected error occurred.'
}

export function ChatHeader({
  connected,
  activeAgentId,
  activeAgentLabel,
  activeAgentArchetypeId,
  activeAgentStatus,
  contextWindowUsage,
  showStopAll,
  stopAllInProgress,
  stopAllDisabled,
  onStopAll,
  showNewChat,
  onNewChat,
  showInternalChatter,
  onShowInternalChatterChange,
  isArtifactsPanelOpen,
  onToggleArtifactsPanel,
  managerModelUpdateInProgress = false,
  onUpdateManagerModel,
  onToggleMobileSidebar,
}: ChatHeaderProps) {
  const connectedFromAtom = useAtomValue(connectedAtom)
  const activeAgentIdFromAtom = useAtomValue(activeAgentIdAtom)
  const activeAgentLabelFromAtom = useAtomValue(activeAgentLabelAtom)
  const activeAgentArchetypeIdFromAtom = useAtomValue(activeAgentArchetypeIdAtom)
  const activeAgentStatusFromAtom = useAtomValue(activeAgentStatusAtom)
  const contextWindowUsageFromAtom = useAtomValue(contextWindowAtom)
  const activeAgent = useAtomValue(activeAgentAtom)
  const canStopAllAgents = useAtomValue(canStopAllAgentsAtom)
  const [showInternalChatterFromAtom, setShowInternalChatter] = useAtom(
    showInternalChatterAtom,
  )
  const [isManagerModelDialogOpen, setIsManagerModelDialogOpen] = useState(false)
  const [pendingManagerModel, setPendingManagerModel] = useState<ManagerModelPreset>(
    MANAGER_MODEL_PRESETS[0],
  )
  const [managerModelError, setManagerModelError] = useState<string | null>(null)

  const resolvedConnected = connected ?? connectedFromAtom
  const resolvedActiveAgentId = activeAgentId ?? activeAgentIdFromAtom
  const resolvedActiveAgentLabel = activeAgentLabel ?? activeAgentLabelFromAtom
  const resolvedActiveAgentArchetypeId =
    activeAgentArchetypeId ?? activeAgentArchetypeIdFromAtom
  const resolvedActiveAgentStatus = activeAgentStatus ?? activeAgentStatusFromAtom
  const resolvedContextWindowUsage =
    contextWindowUsage ?? contextWindowUsageFromAtom
  const resolvedShowStopAll = showStopAll ?? activeAgent?.role === 'manager'
  const resolvedShowNewChat = showNewChat ?? activeAgent?.role === 'manager'
  const resolvedStopAllDisabled =
    stopAllDisabled ?? (!resolvedConnected || !canStopAllAgents)
  const resolvedShowInternalChatter =
    showInternalChatter ?? showInternalChatterFromAtom
  const handleShowInternalChatterChange =
    onShowInternalChatterChange ?? setShowInternalChatter
  const currentModelPreset = activeAgent ? inferModelPreset(activeAgent) : undefined
  const currentManagerModelPreset = isManagerModelPreset(currentModelPreset)
    ? currentModelPreset
    : null
  const defaultManagerModelSelection =
    currentManagerModelPreset ?? MANAGER_MODEL_PRESETS[0]
  const canUpdateManagerModel =
    activeAgent?.role === 'manager' && onUpdateManagerModel !== undefined

  const isStreaming =
    resolvedConnected &&
    !!resolvedActiveAgentStatus &&
    isWorkingAgentStatus(resolvedActiveAgentStatus)
  const statusLabel = resolvedConnected
    ? formatAgentStatus(resolvedActiveAgentStatus)
    : 'Reconnecting'
  const archetypeLabel = resolvedActiveAgentArchetypeId?.trim()
  const hasMenu =
    canUpdateManagerModel ||
    resolvedShowNewChat ||
    resolvedShowStopAll ||
    handleShowInternalChatterChange !== undefined
  const hasPendingManagerModelChange =
    currentManagerModelPreset === null ||
    pendingManagerModel !== currentManagerModelPreset

  useEffect(() => {
    if (!isManagerModelDialogOpen) {
      return
    }

    setPendingManagerModel(defaultManagerModelSelection)
    setManagerModelError(null)
  }, [defaultManagerModelSelection, isManagerModelDialogOpen, resolvedActiveAgentId])

  useEffect(() => {
    if (activeAgent?.role === 'manager') {
      return
    }

    setIsManagerModelDialogOpen(false)
    setManagerModelError(null)
  }, [activeAgent?.role])

  const handleManagerModelDialogOpenChange = (open: boolean) => {
    if (!open && managerModelUpdateInProgress) {
      return
    }

    setIsManagerModelDialogOpen(open)
  }

  const handleOpenManagerModelDialog = () => {
    setPendingManagerModel(defaultManagerModelSelection)
    setManagerModelError(null)
    setIsManagerModelDialogOpen(true)
  }

  const handleSaveManagerModel = async () => {
    if (!onUpdateManagerModel) {
      return
    }

    setManagerModelError(null)

    try {
      await onUpdateManagerModel(pendingManagerModel)
      setIsManagerModelDialogOpen(false)
    } catch (error) {
      setManagerModelError(toErrorMessage(error))
    }
  }

  return (
    <>
      <header className="app-top-bar sticky top-0 z-20 flex w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border/80 bg-card/80 px-2 backdrop-blur md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
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
              title={resolvedActiveAgentId ?? resolvedActiveAgentLabel}
            >
              {resolvedActiveAgentLabel}
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
          <div className="hidden sm:inline-flex items-center">
            {resolvedContextWindowUsage ? (
              <ContextWindowIndicator
                usedTokens={resolvedContextWindowUsage.usedTokens}
                contextWindow={resolvedContextWindowUsage.contextWindow}
              />
            ) : null}
          </div>

          {hasMenu ? (
            <>
              <Separator orientation="vertical" className="mx-0.5 hidden h-4 bg-border/60 sm:block" />
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
                  {canUpdateManagerModel ? (
                    <>
                      <DropdownMenuItem
                        onClick={handleOpenManagerModelDialog}
                        className="gap-2 text-xs"
                      >
                        <Settings2 className="size-3.5" />
                        Change model
                      </DropdownMenuItem>
                      {(handleShowInternalChatterChange !== undefined ||
                        resolvedShowNewChat ||
                        resolvedShowStopAll) ? (
                        <DropdownMenuSeparator />
                      ) : null}
                    </>
                  ) : null}

                  {handleShowInternalChatterChange !== undefined ? (
                    <>
                      <DropdownMenuCheckboxItem
                        checked={resolvedShowInternalChatter}
                        onCheckedChange={(checked) =>
                          handleShowInternalChatterChange(checked === true)
                        }
                        className="gap-2 text-xs"
                      >
                        Show internal chatter
                      </DropdownMenuCheckboxItem>
                      {(resolvedShowNewChat || resolvedShowStopAll) ? (
                        <DropdownMenuSeparator />
                      ) : null}
                    </>
                  ) : null}

                  {resolvedShowNewChat ? (
                    <DropdownMenuItem onClick={onNewChat} className="gap-2 text-xs">
                      <Trash2 className="size-3.5" />
                      Clear conversation
                    </DropdownMenuItem>
                  ) : null}

                  {resolvedShowStopAll ? (
                    <DropdownMenuItem
                      onClick={onStopAll}
                      disabled={resolvedStopAllDisabled || stopAllInProgress}
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

      <Dialog open={isManagerModelDialogOpen} onOpenChange={handleManagerModelDialogOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change manager model</DialogTitle>
            <DialogDescription>
              Apply a Pi runtime to this manager. The change takes effect on the next message.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="manager-model-select" className="text-xs font-medium text-muted-foreground">
                Model
              </Label>
              <Select
                value={pendingManagerModel}
                onValueChange={(value) => {
                  if (value) {
                    setPendingManagerModel(value as ManagerModelPreset)
                  }
                }}
                disabled={managerModelUpdateInProgress}
              >
                <SelectTrigger id="manager-model-select" className="w-full">
                  <SelectValue placeholder="Select model preset" />
                </SelectTrigger>
                <SelectContent>
                  {MANAGER_MODEL_PRESETS.map((modelPreset) => (
                    <SelectItem key={modelPreset} value={modelPreset}>
                      {modelPreset}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {activeAgent ? (
              <p className="text-[11px] text-muted-foreground">
                Current runtime: {activeAgent.model.provider}/{activeAgent.model.modelId}
              </p>
            ) : null}

            {managerModelError ? (
              <p className="text-xs text-destructive">{managerModelError}</p>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleManagerModelDialogOpenChange(false)}
                disabled={managerModelUpdateInProgress}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleSaveManagerModel()}
                disabled={managerModelUpdateInProgress || !hasPendingManagerModelChange}
                className="w-full sm:w-auto"
              >
                {managerModelUpdateInProgress ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
