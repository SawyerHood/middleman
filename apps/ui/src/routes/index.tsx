import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { AgentSidebar } from '@/components/chat/AgentSidebar'
import { ArtifactPanel } from '@/components/chat/ArtifactPanel'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { CreateManagerDialog } from '@/components/chat/CreateManagerDialog'
import { DeleteManagerDialog } from '@/components/chat/DeleteManagerDialog'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { MessageList } from '@/components/chat/MessageList'
import { SettingsPanel } from '@/components/chat/SettingsDialog'
import { chooseFallbackAgentId } from '@/lib/agent-hierarchy'
import type { ArtifactReference } from '@/lib/artifacts'
import { collectArtifactsFromMessages } from '@/lib/collect-artifacts'
import {
  DEFAULT_MANAGER_AGENT_ID,
  useRouteState,
} from '@/hooks/index-page/use-route-state'
import { useWsConnection } from '@/hooks/index-page/use-ws-connection'
import { useManagerActions } from '@/hooks/index-page/use-manager-actions'
import { useVisibleMessages } from '@/hooks/index-page/use-visible-messages'
import { useContextWindow } from '@/hooks/index-page/use-context-window'
import { usePendingResponse } from '@/hooks/index-page/use-pending-response'
import { useFileDrop } from '@/hooks/index-page/use-file-drop'
import type {
  ConversationAttachment,
  ManagerModelPreset,
} from '@middleman/protocol'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

const DEFAULT_MANAGER_MODEL: ManagerModelPreset = 'pi-codex'
const DEFAULT_DEV_WS_URL = 'ws://127.0.0.1:47187'

function resolveDefaultWsUrl(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_DEV_WS_URL
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = window.location.hostname
  const uiPort =
    Number(window.location.port) ||
    (window.location.protocol === 'https:' ? 443 : 80)
  // Dev UI runs on 47188 -> backend 47187, prod UI runs on 47289 -> backend 47287.
  const wsPort = uiPort <= 47188 ? 47187 : 47287

  return `${protocol}//${hostname}:${wsPort}`
}

export function IndexPage() {
  const wsUrl = import.meta.env.VITE_MIDDLEMAN_WS_URL ?? resolveDefaultWsUrl()
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const navigate = useOptionalNavigate()
  const location = useOptionalLocation()

  const { clientRef, state, setState } = useWsConnection(wsUrl)
  const { routeState, activeView, navigateToRoute } = useRouteState({
    pathname: location.pathname,
    search: location.search,
    navigate,
  })

  const [activeArtifact, setActiveArtifact] = useState<ArtifactReference | null>(null)
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  const activeAgentId = useMemo(() => {
    return state.targetAgentId ?? state.subscribedAgentId ?? chooseFallbackAgentId(state.agents)
  }, [state.agents, state.subscribedAgentId, state.targetAgentId])

  const activeAgent = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
  }, [activeAgentId, state.agents])

  const activeAgentLabel = activeAgent?.displayName ?? activeAgentId ?? 'No active agent'
  const isActiveManager = activeAgent?.role === 'manager'

  const activeManagerId = useMemo(() => {
    if (activeAgent?.role === 'manager') {
      return activeAgent.agentId
    }

    if (activeAgent?.managerId) {
      return activeAgent.managerId
    }

    return (
      state.agents.find((agent) => agent.role === 'manager')?.agentId ??
      DEFAULT_MANAGER_AGENT_ID
    )
  }, [activeAgent, state.agents])

  const activeAgentStatus = useMemo(() => {
    if (!activeAgentId) {
      return null
    }

    const fromStatuses = state.statuses[activeAgentId]?.status
    if (fromStatuses) {
      return fromStatuses
    }

    return state.agents.find((agent) => agent.agentId === activeAgentId)?.status ?? null
  }, [activeAgentId, state.agents, state.statuses])

  const { contextWindowUsage } = useContextWindow({
    activeAgent,
    activeAgentId,
    messages: state.messages,
    statuses: state.statuses,
  })

  const {
    markPendingResponse,
    clearPendingResponseForAgent,
    isAwaitingResponseStart,
  } = usePendingResponse({
    activeAgentId,
    activeAgentStatus,
    messages: state.messages,
  })

  const isLoading = activeAgentStatus === 'streaming' || isAwaitingResponseStart
  const canStopAllAgents =
    isActiveManager &&
    (activeAgentStatus === 'idle' || activeAgentStatus === 'streaming')

  const { allMessages, visibleMessages } = useVisibleMessages({
    messages: state.messages,
    activityMessages: state.activityMessages,
    agents: state.agents,
    activeAgent,
  })

  const collectedArtifacts = useMemo(
    () => collectArtifactsFromMessages(allMessages),
    [allMessages],
  )

  const {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerModel,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelChange,
    handleOpenCreateManagerDialog,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    managerToDelete,
    deleteManagerError,
    isDeletingManager,
    handleRequestDeleteManager,
    handleConfirmDeleteManager,
    handleCloseDeleteManagerDialog,
    isCompactingManager,
    handleCompactManager,
    isStoppingAllAgents,
    handleStopAllAgents,
  } = useManagerActions({
    wsUrl,
    clientRef,
    agents: state.agents,
    activeAgent,
    activeAgentId,
    isActiveManager,
    defaultManagerModel: DEFAULT_MANAGER_MODEL,
    navigateToRoute,
    setState,
    clearPendingResponseForAgent,
  })

  const {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useFileDrop({
    activeView,
    messageInputRef,
  })

  useEffect(() => {
    setActiveArtifact(null)
    setIsArtifactsPanelOpen(false)
    setIsMobileSidebarOpen(false)
  }, [activeAgentId])

  useEffect(() => {
    if (routeState.view !== 'chat') {
      return
    }

    const currentAgentId = state.targetAgentId ?? state.subscribedAgentId
    if (currentAgentId === routeState.agentId) {
      return
    }

    if (state.agents.some((agent) => agent.agentId === routeState.agentId)) {
      clientRef.current?.subscribeToAgent(routeState.agentId)
      return
    }

    if (state.agents.length === 0) {
      return
    }

    const fallbackAgentId = chooseFallbackAgentId(state.agents)
    if (!fallbackAgentId || fallbackAgentId === currentAgentId) {
      return
    }

    clientRef.current?.subscribeToAgent(fallbackAgentId)
    navigateToRoute({ view: 'chat', agentId: fallbackAgentId }, true)
  }, [
    clientRef,
    navigateToRoute,
    routeState,
    state.agents,
    state.subscribedAgentId,
    state.targetAgentId,
  ])

  useEffect(() => {
    const client = clientRef.current
    if (!client) {
      return
    }

    if (activeView !== 'chat' || activeAgent?.role !== 'worker') {
      client.unsubscribeFromAgentDetail()
      return
    }

    client.subscribeToAgentDetail(activeAgent.agentId)
  }, [activeAgent?.agentId, activeAgent?.role, activeView, clientRef])

  const handleSend = (text: string, attachments?: ConversationAttachment[]) => {
    if (!activeAgentId) {
      return
    }

    const compactCommand =
      isActiveManager && (!attachments || attachments.length === 0)
        ? parseCompactSlashCommand(text)
        : null

    if (compactCommand) {
      void handleCompactManager(compactCommand.customInstructions)
      return
    }

    markPendingResponse(activeAgentId, state.messages.length)

    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? 'steer' : isLoading ? 'steer' : 'auto',
      attachments,
    })
  }

  const handleNewChat = () => {
    if (!isActiveManager || !activeAgentId) {
      return
    }

    clientRef.current?.sendUserMessage('/new', {
      agentId: activeAgentId,
      delivery: 'steer',
    })
  }

  const handleSelectAgent = (agentId: string) => {
    navigateToRoute({ view: 'chat', agentId })
    clientRef.current?.subscribeToAgent(agentId)
  }

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId)
    if (!agent || agent.role !== 'worker') {
      return
    }

    if (activeAgentId === agentId) {
      const remainingAgents = state.agents.filter((entry) => entry.agentId !== agentId)
      const fallbackAgentId = chooseFallbackAgentId(remainingAgents)
      if (fallbackAgentId) {
        navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
        clientRef.current?.subscribeToAgent(fallbackAgentId)
      }
    }

    clientRef.current?.deleteAgent(agentId)
  }

  const handleOpenSettingsPanel = () => {
    navigateToRoute({ view: 'settings' })
  }

  const handleSuggestionClick = (prompt: string) => {
    messageInputRef.current?.setInput(prompt)
  }

  const handleToggleArtifactsPanel = useCallback(() => {
    setIsArtifactsPanelOpen((previous) => !previous)
  }, [])

  const handleOpenArtifact = useCallback((artifact: ArtifactReference) => {
    setActiveArtifact(artifact)
  }, [])

  const handleCloseArtifact = useCallback(() => {
    setActiveArtifact(null)
  }, [])

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="flex h-screen w-full min-w-0 overflow-hidden bg-background">
        <AgentSidebar
          connected={state.connected}
          agents={state.agents}
          statuses={state.statuses}
          selectedAgentId={activeAgentId}
          isSettingsActive={activeView === 'settings'}
          isMobileOpen={isMobileSidebarOpen}
          onMobileClose={() => setIsMobileSidebarOpen(false)}
          onAddManager={handleOpenCreateManagerDialog}
          onSelectAgent={handleSelectAgent}
          onDeleteAgent={handleDeleteAgent}
          onDeleteManager={handleRequestDeleteManager}
          onOpenSettings={handleOpenSettingsPanel}
        />

        <div
          className="relative flex min-w-0 flex-1"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {activeView === 'chat' && isDraggingFiles ? (
            <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary bg-primary/10" />
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col">
            {activeView === 'settings' ? (
              <SettingsPanel
                wsUrl={wsUrl}
                managers={state.agents.filter((agent) => agent.role === 'manager')}
                slackStatus={state.slackStatus}
                telegramStatus={state.telegramStatus}
                onBack={() =>
                  navigateToRoute({
                    view: 'chat',
                    agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
                  })
                }
              />
            ) : (
              <>
                <ChatHeader
                  connected={state.connected}
                  activeAgentId={activeAgentId}
                  activeAgentLabel={activeAgentLabel}
                  activeAgentArchetypeId={activeAgent?.archetypeId}
                  activeAgentStatus={activeAgentStatus}
                  contextWindowUsage={contextWindowUsage}
                  showCompact={isActiveManager}
                  compactInProgress={isCompactingManager}
                  onCompact={() => void handleCompactManager()}
                  showStopAll={isActiveManager}
                  stopAllInProgress={isStoppingAllAgents}
                  stopAllDisabled={!state.connected || !canStopAllAgents}
                  onStopAll={() => void handleStopAllAgents()}
                  showNewChat={isActiveManager}
                  onNewChat={handleNewChat}
                  isArtifactsPanelOpen={isArtifactsPanelOpen}
                  onToggleArtifactsPanel={handleToggleArtifactsPanel}
                  onToggleMobileSidebar={() =>
                    setIsMobileSidebarOpen((previous) => !previous)
                  }
                />

                {state.lastError ? (
                  <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {state.lastError}
                  </div>
                ) : null}

                <MessageList
                  messages={visibleMessages}
                  isLoading={isLoading}
                  activeAgentId={activeAgentId}
                  onSuggestionClick={handleSuggestionClick}
                  onArtifactClick={handleOpenArtifact}
                  wsUrl={wsUrl}
                />

                <MessageInput
                  ref={messageInputRef}
                  onSend={handleSend}
                  isLoading={isLoading}
                  disabled={!state.connected || !activeAgentId}
                  allowWhileLoading
                  agentLabel={activeAgentLabel}
                  wsUrl={wsUrl}
                />
              </>
            )}
          </div>

          {activeView === 'chat' ? (
            <ArtifactsSidebar
              wsUrl={wsUrl}
              managerId={activeManagerId}
              artifacts={collectedArtifacts}
              isOpen={isArtifactsPanelOpen}
              onClose={() => setIsArtifactsPanelOpen(false)}
              onArtifactClick={handleOpenArtifact}
            />
          ) : null}
        </div>
      </div>

      <ArtifactPanel
        artifact={activeArtifact}
        wsUrl={wsUrl}
        onClose={handleCloseArtifact}
        onArtifactClick={handleOpenArtifact}
      />

      <CreateManagerDialog
        open={isCreateManagerDialogOpen}
        isCreatingManager={isCreatingManager}
        isValidatingDirectory={isValidatingDirectory}
        isPickingDirectory={isPickingDirectory}
        newManagerName={newManagerName}
        newManagerCwd={newManagerCwd}
        newManagerModel={newManagerModel}
        createManagerError={createManagerError}
        browseError={browseError}
        onOpenChange={handleCreateManagerDialogOpenChange}
        onNameChange={handleNewManagerNameChange}
        onCwdChange={handleNewManagerCwdChange}
        onModelChange={handleNewManagerModelChange}
        onBrowseDirectory={() => {
          void handleBrowseDirectory()
        }}
        onSubmit={(event) => {
          void handleCreateManager(event)
        }}
      />

      <DeleteManagerDialog
        managerToDelete={managerToDelete}
        deleteManagerError={deleteManagerError}
        isDeletingManager={isDeletingManager}
        onClose={handleCloseDeleteManagerDialog}
        onConfirm={() => {
          void handleConfirmDeleteManager()
        }}
      />
    </main>
  )
}

function parseCompactSlashCommand(
  text: string,
): { customInstructions?: string } | null {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i)
  if (!match) {
    return null
  }

  const customInstructions = match[1]?.trim()
  if (!customInstructions) {
    return {}
  }

  return { customInstructions }
}

function useOptionalLocation(): { pathname: string; search: unknown } {
  try {
    const location = useLocation()
    return {
      pathname: location.pathname,
      search: location.search,
    }
  } catch {
    if (typeof window === 'undefined') {
      return { pathname: '/', search: {} }
    }

    return {
      pathname: window.location.pathname || '/',
      search: parseWindowRouteSearch(window.location.search),
    }
  }
}

type NavigateFn = (options: {
  to: string
  search?: { view?: string; agent?: string }
  replace?: boolean
  resetScroll?: boolean
}) => void | Promise<void>

function useOptionalNavigate(): NavigateFn {
  try {
    return useNavigate() as unknown as NavigateFn
  } catch {
    return ({ to, search, replace }) => {
      if (typeof window === 'undefined') {
        return
      }

      const params = new URLSearchParams()
      if (search?.view) {
        params.set('view', search.view)
      }
      if (search?.agent) {
        params.set('agent', search.agent)
      }

      const query = params.toString()
      const nextUrl = query ? `${to}?${query}` : to

      if (replace) {
        window.history.replaceState(null, '', nextUrl)
      } else {
        window.history.pushState(null, '', nextUrl)
      }
    }
  }
}

function parseWindowRouteSearch(search: string): { view?: string; agent?: string } {
  if (!search) {
    return {}
  }

  const params = new URLSearchParams(search)
  const view = params.get('view')
  const agent = params.get('agent')

  return {
    view: view ?? undefined,
    agent: agent ?? undefined,
  }
}
