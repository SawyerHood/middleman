import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSetAtom } from "jotai";
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Group as ResizablePanelGroup,
  Panel as ResizablePanel,
  Separator as ResizableSeparator,
  usePanelRef,
} from "react-resizable-panels";
import { AgentSidebar } from "@/components/chat/AgentSidebar";
import {
  ArtifactPanel,
  type ArtifactPanelSelection,
} from "@/components/chat/ArtifactPanel";
import { ArtifactsSidebar } from "@/components/chat/ArtifactsSidebar";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { CreateManagerDialog } from "@/components/chat/CreateManagerDialog";
import { DeleteManagerDialog } from "@/components/chat/DeleteManagerDialog";
import {
  MessageInput,
  type MessageInputHandle,
} from "@/components/chat/MessageInput";
import {
  MessageList,
  type MessageListHandle,
} from "@/components/chat/MessageList";
import { SettingsPanel } from "@/components/chat/SettingsDialog";
import { NotesView } from "@/components/notes/NotesView";
import { chooseFallbackAgentId } from "@/lib/agent-hierarchy";
import { isActiveAgentStatus, isWorkingAgentStatus } from "@/lib/agent-status";
import type { ArtifactReference } from "@/lib/artifacts";
import {
  readStoredShowInternalChatter,
  writeStoredShowInternalChatter,
} from "@/lib/chat-view-preferences";
import { collectArtifactsFromMessages } from "@/lib/collect-artifacts";
import { pruneMessageDraftsAtom } from "@/lib/message-drafts";
import {
  DEFAULT_MANAGER_AGENT_ID,
  useRouteState,
} from "@/hooks/index-page/use-route-state";
import { useWsConnection } from "@/hooks/index-page/use-ws-connection";
import { useManagerActions } from "@/hooks/index-page/use-manager-actions";
import { useVisibleMessages } from "@/hooks/index-page/use-visible-messages";
import { useContextWindow } from "@/hooks/index-page/use-context-window";
import { usePendingResponse } from "@/hooks/index-page/use-pending-response";
import { useFileDrop } from "@/hooks/index-page/use-file-drop";
import { useDynamicFavicon } from "@/hooks/index-page/use-dynamic-favicon";
import type {
  ConversationAttachment,
  ManagerModelPreset,
} from "@middleman/protocol";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

const DEFAULT_MANAGER_MODEL: ManagerModelPreset = "codex-app";
const DEFAULT_DEV_WS_URL = "ws://127.0.0.1:47187";
const DESKTOP_SIDEBAR_MEDIA_QUERY = "(min-width: 768px)";
const SIDEBAR_WIDTH_STORAGE_KEY = "middleman:sidebar-width";
const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = "middleman:index:sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 256;
const SIDEBAR_MAX_WIDTH = 480;

function resolveDefaultWsUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_DEV_WS_URL;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;

  if (import.meta.env.DEV && window.location.port === "47188") {
    return `${protocol}//${window.location.hostname}:47187`;
  }

  return `${protocol}//${host}`;
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

function parseStoredSidebarWidth(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return clampSidebarWidth(parsed);
}

function readStoredSidebarWidth(): number {
  if (typeof window === "undefined") {
    return SIDEBAR_DEFAULT_WIDTH;
  }

  try {
    const storedWidth = parseStoredSidebarWidth(
      window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY),
    );
    if (storedWidth !== null) {
      return storedWidth;
    }

    const legacyStoredWidth = parseStoredSidebarWidth(
      window.localStorage.getItem(LEGACY_SIDEBAR_WIDTH_STORAGE_KEY),
    );
    if (legacyStoredWidth !== null) {
      return legacyStoredWidth;
    }

    return SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeStoredSidebarWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampSidebarWidth(width)),
    );
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function useDesktopSidebarLayout(): boolean {
  const [matches, setMatches] = useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return true;
    }

    return window.matchMedia(DESKTOP_SIDEBAR_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia(DESKTOP_SIDEBAR_MEDIA_QUERY);
    const updateMatches = () => {
      setMatches(mediaQuery.matches);
    };

    updateMatches();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateMatches);
      return () => mediaQuery.removeEventListener("change", updateMatches);
    }

    mediaQuery.addListener(updateMatches);
    return () => mediaQuery.removeListener(updateMatches);
  }, []);

  return matches;
}

function SidebarResizeHandle() {
  return (
    <ResizableSeparator
      aria-label="Resize sidebar"
      className="group relative hidden w-0 shrink-0 cursor-col-resize items-stretch justify-center bg-transparent outline-none md:flex"
    >
      {/* Invisible hit area for easier grabbing */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
    </ResizableSeparator>
  );
}

export function IndexPage() {
  const wsUrl = import.meta.env.VITE_MIDDLEMAN_WS_URL ?? resolveDefaultWsUrl();
  const messageInputRef = useRef<MessageInputHandle | null>(null);
  const messageListRef = useRef<MessageListHandle | null>(null);
  const sidebarPanelRef = usePanelRef();
  // Capture the stored width once for use as the Panel's defaultSize.
  // This value must be stable across renders — if it changes, the library
  // re-registers the panel and recalculates layout, which causes a visible
  // snap/jump.  The mutable ref below tracks the *live* width for syncing
  // back to localStorage and for the desktop-layout restore effect.
  const [initialSidebarWidth] = useState(readStoredSidebarWidth);
  const storedSidebarWidthRef = useRef(initialSidebarWidth);
  const sidebarRestoreFrameRef = useRef<number | null>(null);
  const isRestoringSidebarWidthRef = useRef(true);
  const navigate = useOptionalNavigate();
  const location = useOptionalLocation();
  const pruneMessageDrafts = useSetAtom(pruneMessageDraftsAtom);
  const isDesktopSidebarLayout = useDesktopSidebarLayout();

  const { clientRef, state, setState } = useWsConnection(wsUrl);
  const { routeState, activeView, hasExplicitAgentSelection, navigateToRoute } =
    useRouteState({
      pathname: location.pathname,
      search: location.search,
      navigate,
    });

  const [panelSelection, setPanelSelection] =
    useState<ArtifactPanelSelection | null>(null);
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [showInternalChatter, setShowInternalChatter] = useState(
    readStoredShowInternalChatter,
  );

  const activeAgentId = useMemo(() => {
    return (
      state.targetAgentId ??
      state.subscribedAgentId ??
      chooseFallbackAgentId(state.agents, state.managerOrder)
    );
  }, [
    state.agents,
    state.managerOrder,
    state.subscribedAgentId,
    state.targetAgentId,
  ]);

  const activeAgent = useMemo(() => {
    if (!activeAgentId) {
      return null;
    }

    return (
      state.agents.find((agent) => agent.agentId === activeAgentId) ?? null
    );
  }, [activeAgentId, state.agents]);

  const activeAgentLabel =
    activeAgent?.displayName ?? activeAgentId ?? "No active agent";
  const isActiveManager = activeAgent?.role === "manager";

  const activeManagerId = useMemo(() => {
    if (activeAgent?.role === "manager") {
      return activeAgent.agentId;
    }

    if (activeAgent?.managerId) {
      return activeAgent.managerId;
    }

    return (
      state.agents.find((agent) => agent.role === "manager")?.agentId ??
      DEFAULT_MANAGER_AGENT_ID
    );
  }, [activeAgent, state.agents]);

  const activeAgentStatus = useMemo(() => {
    if (!activeAgentId) {
      return null;
    }

    const fromStatuses = state.statuses[activeAgentId]?.status;
    if (fromStatuses) {
      return fromStatuses;
    }

    return (
      state.agents.find((agent) => agent.agentId === activeAgentId)?.status ??
      null
    );
  }, [activeAgentId, state.agents, state.statuses]);

  useDynamicFavicon({
    managerId: activeManagerId,
    agents: state.agents,
    statuses: state.statuses,
  });
  const { contextWindowUsage } = useContextWindow({
    activeAgent,
    activeAgentId,
    messages: state.messages,
    statuses: state.statuses,
  });

  const {
    markPendingResponse,
    clearPendingResponseForAgent,
    isAwaitingResponseStart,
  } = usePendingResponse({
    activeAgentId,
    activeAgentStatus,
    messages: state.messages,
  });

  const isLoading =
    (activeAgentStatus ? isWorkingAgentStatus(activeAgentStatus) : false) ||
    isAwaitingResponseStart;
  const canStopAllAgents =
    isActiveManager &&
    (activeAgentStatus ? isActiveAgentStatus(activeAgentStatus) : false);

  const { allMessages, visibleMessages } = useVisibleMessages({
    messages: state.messages,
    activityMessages: state.activityMessages,
    agents: state.agents,
    activeAgent,
    showInternalChatter,
  });

  const collectedArtifacts = useMemo(
    () => collectArtifactsFromMessages(allMessages),
    [allMessages],
  );

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
    isStoppingAllAgents,
    handleStopAllAgents,
  } = useManagerActions({
    clientRef,
    agents: state.agents,
    activeAgent,
    defaultManagerModel: DEFAULT_MANAGER_MODEL,
    navigateToRoute,
    setState,
    clearPendingResponseForAgent,
  });

  const {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useFileDrop({
    activeView,
    messageInputRef,
  });

  useEffect(() => {
    setPanelSelection(null);
    setIsArtifactsPanelOpen(false);
    setIsMobileSidebarOpen(false);
  }, [activeAgentId]);

  useEffect(() => {
    writeStoredShowInternalChatter(showInternalChatter);
  }, [showInternalChatter]);

  useEffect(() => {
    if (!state.hasReceivedAgentsSnapshot) {
      return;
    }

    pruneMessageDrafts(state.agents.map((agent) => agent.agentId));
  }, [pruneMessageDrafts, state.agents, state.hasReceivedAgentsSnapshot]);

  useEffect(() => {
    if (routeState.view !== "chat") {
      return;
    }

    const currentAgentId = state.targetAgentId ?? state.subscribedAgentId;
    const currentAgentExists =
      currentAgentId !== null &&
      state.agents.some((agent) => agent.agentId === currentAgentId);
    const routeAgentExists = state.agents.some(
      (agent) => agent.agentId === routeState.agentId,
    );

    if (hasExplicitAgentSelection) {
      if (!routeAgentExists) {
        if (!state.hasReceivedAgentsSnapshot) {
          return;
        }

        navigateToRoute(
          { view: "chat", agentId: DEFAULT_MANAGER_AGENT_ID },
          true,
        );
        return;
      }

      if (currentAgentId !== routeState.agentId) {
        clientRef.current?.subscribeToAgent(routeState.agentId);
      }

      return;
    }

    if (currentAgentExists) {
      return;
    }

    const fallbackAgentId = chooseFallbackAgentId(
      state.agents,
      state.managerOrder,
    );
    if (!fallbackAgentId || fallbackAgentId === currentAgentId) {
      return;
    }

    clientRef.current?.subscribeToAgent(fallbackAgentId);
  }, [
    clientRef,
    hasExplicitAgentSelection,
    navigateToRoute,
    routeState,
    state.agents,
    state.managerOrder,
    state.hasReceivedAgentsSnapshot,
    state.subscribedAgentId,
    state.targetAgentId,
  ]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    if (activeView !== "chat" || activeAgent?.role !== "worker") {
      client.unsubscribeFromAgentDetail();
      return;
    }

    client.subscribeToAgentDetail(activeAgent.agentId);
  }, [activeAgent?.agentId, activeAgent?.role, activeView, clientRef]);

  useEffect(() => {
    if (isDesktopSidebarLayout) {
      setIsMobileSidebarOpen(false);
    }
  }, [isDesktopSidebarLayout]);

  const cancelSidebarRestoreFrame = useCallback(() => {
    if (
      typeof window === "undefined" ||
      sidebarRestoreFrameRef.current === null
    ) {
      return;
    }

    window.cancelAnimationFrame(sidebarRestoreFrameRef.current);
    sidebarRestoreFrameRef.current = null;
  }, []);

  useEffect(() => {
    return cancelSidebarRestoreFrame;
  }, [cancelSidebarRestoreFrame]);

  // Restore the stored width once the panel API is actually ready.
  // On a hard reload, the route shell can mount before the resizable panel
  // finishes hydrating, so a one-shot resize attempt gets skipped and the
  // library falls back to its constrained default layout instead.
  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    cancelSidebarRestoreFrame();
    isRestoringSidebarWidthRef.current = true;

    const targetWidth = isDesktopSidebarLayout
      ? clampSidebarWidth(storedSidebarWidthRef.current)
      : 0;

    const restoreSidebarWidth = () => {
      const sidebarPanel = sidebarPanelRef.current;
      if (!sidebarPanel) {
        sidebarRestoreFrameRef.current =
          window.requestAnimationFrame(restoreSidebarWidth);
        return;
      }

      try {
        const currentWidth = Math.round(sidebarPanel.getSize().inPixels);
        if (currentWidth !== Math.round(targetWidth)) {
          sidebarPanel.resize(targetWidth);
          sidebarRestoreFrameRef.current =
            window.requestAnimationFrame(restoreSidebarWidth);
          return;
        }

        sidebarRestoreFrameRef.current = null;
        if (isDesktopSidebarLayout) {
          storedSidebarWidthRef.current = targetWidth;
          writeStoredSidebarWidth(targetWidth);
        }
        isRestoringSidebarWidthRef.current = false;
      } catch {
        sidebarRestoreFrameRef.current =
          window.requestAnimationFrame(restoreSidebarWidth);
      }
    };

    restoreSidebarWidth();

    return cancelSidebarRestoreFrame;
  }, [cancelSidebarRestoreFrame, isDesktopSidebarLayout, sidebarPanelRef]);

  const handleSend = (text: string, attachments?: ConversationAttachment[]) => {
    if (!activeAgentId) {
      return;
    }

    markPendingResponse(activeAgentId, state.messages.length);

    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? "steer" : isLoading ? "steer" : "auto",
      attachments,
    });
  };

  const handleMessageInputSubmitted = useCallback(() => {
    messageListRef.current?.scrollToBottom("smooth");
  }, []);

  const handleLoadOlderHistory = useCallback(() => {
    clientRef.current?.loadOlderHistory(activeAgentId ?? undefined);
  }, [activeAgentId, clientRef]);

  const handleNewChat = () => {
    if (!isActiveManager || !activeAgentId) {
      return;
    }

    clientRef.current?.sendUserMessage("/new", {
      agentId: activeAgentId,
      delivery: "steer",
    });
  };

  const handleSelectAgent = (agentId: string) => {
    navigateToRoute({ view: "chat", agentId });
    clientRef.current?.subscribeToAgent(agentId);
  };

  const handleDeleteAgent = (agentId: string) => {
    const agent = state.agents.find((entry) => entry.agentId === agentId);
    if (!agent || agent.role !== "worker") {
      return;
    }

    clientRef.current?.deleteAgent(agentId);
  };

  const handleOpenSettingsPanel = () => {
    navigateToRoute({ view: "settings" });
  };

  const handleOpenNotesPanel = () => {
    navigateToRoute({ view: "notes" });
  };

  const handleSuggestionClick = (prompt: string) => {
    messageInputRef.current?.setInput(prompt);
  };

  const handleToggleArtifactsPanel = useCallback(() => {
    setIsArtifactsPanelOpen((previous) => !previous);
  }, []);

  const handleOpenArtifact = useCallback((artifact: ArtifactReference) => {
    setPanelSelection({
      type: "artifact",
      artifact,
    });
  }, []);

  const handleCloseArtifact = useCallback(() => {
    setPanelSelection(null);
  }, []);

  const statusBanner = state.lastError ? (
    <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {state.lastError}
    </div>
  ) : null;

  const handleSidebarLayoutChanged = useCallback(() => {
    if (!isDesktopSidebarLayout || isRestoringSidebarWidthRef.current) {
      return;
    }

    let nextWidth: number | undefined;
    try {
      nextWidth = sidebarPanelRef.current?.getSize().inPixels;
    } catch {
      return;
    }

    if (!nextWidth || !Number.isFinite(nextWidth)) {
      return;
    }

    const clampedWidth = clampSidebarWidth(nextWidth);
    storedSidebarWidthRef.current = clampedWidth;
    writeStoredSidebarWidth(clampedWidth);
  }, [isDesktopSidebarLayout, sidebarPanelRef]);

  const mainContent = (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {activeView === "chat" && isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary bg-primary/10" />
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {activeView === "settings" ? (
          <SettingsPanel
            wsUrl={wsUrl}
            statusBanner={statusBanner}
            onBack={() =>
              navigateToRoute({
                view: "chat",
                agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
              })
            }
          />
        ) : activeView === "notes" ? (
          <NotesView
            wsUrl={wsUrl}
            statusBanner={statusBanner}
            onBack={() =>
              navigateToRoute({
                view: "chat",
                agentId: activeAgentId ?? DEFAULT_MANAGER_AGENT_ID,
              })
            }
            onToggleMobileSidebar={() =>
              setIsMobileSidebarOpen((previous) => !previous)
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
              showStopAll={isActiveManager}
              stopAllInProgress={isStoppingAllAgents}
              stopAllDisabled={!state.connected || !canStopAllAgents}
              onStopAll={() => void handleStopAllAgents()}
              showNewChat={isActiveManager}
              onNewChat={handleNewChat}
              showInternalChatter={showInternalChatter}
              onShowInternalChatterChange={setShowInternalChatter}
              isArtifactsPanelOpen={isArtifactsPanelOpen}
              onToggleArtifactsPanel={handleToggleArtifactsPanel}
              onToggleMobileSidebar={() =>
                setIsMobileSidebarOpen((previous) => !previous)
              }
            />
            {statusBanner}

            <MessageList
              ref={messageListRef}
              messages={visibleMessages}
              agents={state.agents}
              isLoading={isLoading}
              isLoadingHistory={state.isLoadingHistory}
              canLoadOlderHistory={state.hasOlderHistory}
              isLoadingOlderHistory={state.isLoadingOlderHistory}
              activeAgentId={activeAgentId}
              isWorkerDetailView={activeAgent?.role === "worker"}
              onLoadOlderHistory={handleLoadOlderHistory}
              onSuggestionClick={handleSuggestionClick}
              onArtifactClick={handleOpenArtifact}
              wsUrl={wsUrl}
            />

            <MessageInput
              ref={messageInputRef}
              agentId={activeAgentId}
              onSend={handleSend}
              onSubmitted={handleMessageInputSubmitted}
              isLoading={isLoading}
              disabled={!state.connected || !activeAgentId}
              allowWhileLoading
              agentLabel={activeAgentLabel}
            />
          </>
        )}
      </div>

      {activeView === "chat" && isDesktopSidebarLayout ? (
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
  );

  return (
    <main className="app-shell-height overflow-hidden bg-background text-foreground">
      <div className="flex h-full w-full min-w-0 overflow-hidden bg-background">
        <ResizablePanelGroup
          id="main-layout"
          orientation="horizontal"
          className="h-full min-h-0 min-w-0"
          onLayoutChanged={handleSidebarLayoutChanged}
        >
          <ResizablePanel
            id="agent-sidebar"
            panelRef={sidebarPanelRef}
            defaultSize={isDesktopSidebarLayout ? initialSidebarWidth : 0}
            minSize={isDesktopSidebarLayout ? SIDEBAR_MIN_WIDTH : 0}
            maxSize={isDesktopSidebarLayout ? SIDEBAR_MAX_WIDTH : 0}
            disabled={!isDesktopSidebarLayout}
            groupResizeBehavior="preserve-pixel-size"
            style={{ overflow: "visible" }}
          >
            <AgentSidebar
              connected={state.connected}
              agents={state.agents}
              managerOrder={state.managerOrder}
              statuses={state.statuses}
              selectedAgentId={activeAgentId}
              isSettingsActive={activeView === "settings"}
              isNotesActive={activeView === "notes"}
              isMobileOpen={isMobileSidebarOpen}
              onMobileClose={() => setIsMobileSidebarOpen(false)}
              onAddManager={handleOpenCreateManagerDialog}
              onSelectAgent={handleSelectAgent}
              onDeleteAgent={handleDeleteAgent}
              onDeleteManager={handleRequestDeleteManager}
              onReorderManagers={(managerIds) => {
                const client = clientRef.current;
                if (!client) {
                  return;
                }

                void client.reorderManagers(managerIds).catch(() => undefined);
              }}
              onOpenNotes={handleOpenNotesPanel}
              onOpenSettings={handleOpenSettingsPanel}
            />
          </ResizablePanel>

          <SidebarResizeHandle />

          <ResizablePanel
            id="chat-content"
            className="flex min-h-0 min-w-0 overflow-hidden"
            style={{ overflow: "hidden" }}
          >
            {mainContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {activeView === "chat" && !isDesktopSidebarLayout ? (
        <ArtifactsSidebar
          wsUrl={wsUrl}
          managerId={activeManagerId}
          artifacts={collectedArtifacts}
          isOpen={isArtifactsPanelOpen}
          onClose={() => setIsArtifactsPanelOpen(false)}
          onArtifactClick={handleOpenArtifact}
        />
      ) : null}

      <ArtifactPanel
        selection={panelSelection}
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
          void handleBrowseDirectory();
        }}
        onSubmit={(event) => {
          void handleCreateManager(event);
        }}
      />

      <DeleteManagerDialog
        managerToDelete={managerToDelete}
        deleteManagerError={deleteManagerError}
        isDeletingManager={isDeletingManager}
        onClose={handleCloseDeleteManagerDialog}
        onConfirm={() => {
          void handleConfirmDeleteManager();
        }}
      />
    </main>
  );
}

function useOptionalLocation(): { pathname: string; search: unknown } {
  try {
    const location = useLocation();
    return {
      pathname: location.pathname,
      search: location.search,
    };
  } catch {
    if (typeof window === "undefined") {
      return { pathname: "/", search: {} };
    }

    return {
      pathname: window.location.pathname || "/",
      search: parseWindowRouteSearch(window.location.search),
    };
  }
}

type NavigateFn = (options: {
  to: string;
  search?: { view?: string; agent?: string };
  replace?: boolean;
  resetScroll?: boolean;
}) => void | Promise<void>;

function useOptionalNavigate(): NavigateFn {
  let navigate: NavigateFn | null = null;

  try {
    navigate = useNavigate() as unknown as NavigateFn;
  } catch {}

  return (options) => {
    if (navigate) {
      try {
        return navigate(options);
      } catch {
        // Fall through to the window.history fallback when no router context is mounted.
      }
    }

    applyWindowNavigation(options);
  };
}

function parseWindowRouteSearch(search: string): {
  view?: string;
  agent?: string;
} {
  if (!search) {
    return {};
  }

  const params = new URLSearchParams(search);
  const view = params.get("view");
  const agent = params.get("agent");

  return {
    view: view ?? undefined,
    agent: agent ?? undefined,
  };
}

function applyWindowNavigation({
  to,
  search,
  replace,
}: {
  to: string;
  search?: { view?: string; agent?: string };
  replace?: boolean;
}): void {
  if (typeof window === "undefined") {
    return;
  }

  const params = new URLSearchParams();
  if (search?.view) {
    params.set("view", search.view);
  }
  if (search?.agent) {
    params.set("agent", search.agent);
  }

  const query = params.toString();
  const nextUrl = query ? `${to}?${query}` : to;

  if (replace) {
    window.history.replaceState(null, "", nextUrl);
  } else {
    window.history.pushState(null, "", nextUrl);
  }
}
