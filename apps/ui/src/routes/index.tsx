import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Group as ResizablePanelGroup,
  Panel as ResizablePanel,
  Separator as ResizableSeparator,
  usePanelRef,
} from "react-resizable-panels";
import { AgentSidebar } from "@/components/chat/AgentSidebar";
import { ArtifactPanel, type ArtifactPanelSelection } from "@/components/chat/ArtifactPanel";
import { ArtifactsSidebar } from "@/components/chat/ArtifactsSidebar";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { CreateManagerDialog } from "@/components/chat/CreateManagerDialog";
import { DeleteManagerDialog } from "@/components/chat/DeleteManagerDialog";
import { MessageInput, type MessageInputHandle } from "@/components/chat/MessageInput";
import { MessageList, type MessageListHandle } from "@/components/chat/MessageList";
import { SettingsPanel } from "@/components/chat/SettingsDialog";
import { NotesView } from "@/components/notes/NotesView";
import { writeStoredLastOpenNotePath } from "@/components/notes/notes-storage";
import { chooseFallbackAgentId } from "@/lib/agent-hierarchy";
import type { ArtifactReference } from "@/lib/artifacts";
import { pruneMessageDraftsAtom } from "@/lib/message-drafts";
import {
  activeAgentAtom,
  activeAgentIdAtom,
  activeAgentStatusAtom,
  activeWorkerCountByManagerAtomFamily,
  activeManagerIdAtom,
  agentsAtom,
  artifactsAtom,
  hasReceivedAgentsSnapshotAtom,
  isActiveManagerAtom,
  isLoadingAtom,
  isWorkerDetailViewAtom,
  lastErrorAtom,
  managerOrderAtom,
  statusBannerTextAtom,
  subscribedAgentIdAtom,
  targetAgentIdAtom,
} from "@/lib/ws-state";
import { DEFAULT_MANAGER_AGENT_ID, useRouteState } from "@/hooks/index-page/use-route-state";
import { useWsConnection } from "@/hooks/index-page/use-ws-connection";
import { useManagerActions } from "@/hooks/index-page/use-manager-actions";
import { usePendingResponse } from "@/hooks/index-page/use-pending-response";
import { useFileDrop } from "@/hooks/index-page/use-file-drop";
import { useDynamicFavicon } from "@/hooks/index-page/use-dynamic-favicon";
import type { ConversationAttachment, CreateManagerModelPreset } from "@middleman/protocol";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

const DEFAULT_MANAGER_MODEL: CreateManagerModelPreset = "pi-codex";
const DEFAULT_DEV_WS_URL = "ws://127.0.0.1:47187";
const DESKTOP_SIDEBAR_MEDIA_QUERY = "(min-width: 768px)";
const SIDEBAR_WIDTH_STORAGE_KEY = "middleman:sidebar-width";
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
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
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
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function isPiModelProvider(provider: string | null | undefined): boolean {
  return provider === "openai-codex" || provider === "anthropic";
}

function useDesktopSidebarLayout(): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }

    return window.matchMedia(DESKTOP_SIDEBAR_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
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
  const navigate = useNavigate({ from: "/" });
  const location = useLocation();
  const pruneMessageDrafts = useSetAtom(pruneMessageDraftsAtom);
  const isDesktopSidebarLayout = useDesktopSidebarLayout();
  const agents = useAtomValue(agentsAtom);
  const managerOrder = useAtomValue(managerOrderAtom);
  const hasReceivedAgentsSnapshot = useAtomValue(hasReceivedAgentsSnapshotAtom);
  const targetAgentId = useAtomValue(targetAgentIdAtom);
  const subscribedAgentId = useAtomValue(subscribedAgentIdAtom);
  const activeAgent = useAtomValue(activeAgentAtom);
  const activeAgentId = useAtomValue(activeAgentIdAtom);
  const activeAgentStatus = useAtomValue(activeAgentStatusAtom);
  const isActiveManager = useAtomValue(isActiveManagerAtom);
  const isWorkerDetailView = useAtomValue(isWorkerDetailViewAtom);
  const activeManagerId = useAtomValue(activeManagerIdAtom);
  const isLoading = useAtomValue(isLoadingAtom);
  const activeWorkerCount = useAtomValue(
    activeWorkerCountByManagerAtomFamily(activeManagerId ?? DEFAULT_MANAGER_AGENT_ID),
  );
  const collectedArtifacts = useAtomValue(artifactsAtom);
  const statusBannerText = useAtomValue(statusBannerTextAtom);
  const setLastError = useSetAtom(lastErrorAtom);

  const { clientRef } = useWsConnection(wsUrl);
  const { routeState, activeView, hasExplicitAgentSelection, navigateToRoute } = useRouteState({
    pathname: location.pathname,
    search: location.search,
    navigate,
  });

  const [panelSelection, setPanelSelection] = useState<ArtifactPanelSelection | null>(null);
  const [isArtifactsPanelOpen, setIsArtifactsPanelOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isStoppingCurrentSelection, setIsStoppingCurrentSelection] = useState(false);
  const [compactingAgentId, setCompactingAgentId] = useState<string | null>(null);
  useDynamicFavicon();

  const { clearPendingResponseForAgent, markPendingResponse } = usePendingResponse();

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
  } = useManagerActions({
    clientRef,
    defaultManagerModel: DEFAULT_MANAGER_MODEL,
    navigateToRoute,
  });

  const { isDraggingFiles, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } =
    useFileDrop({
      activeView,
      messageInputRef,
    });

  useEffect(() => {
    setPanelSelection(null);
    setIsArtifactsPanelOpen(false);
    setIsMobileSidebarOpen(false);
  }, [activeAgentId]);

  useEffect(() => {
    if (!hasReceivedAgentsSnapshot) {
      return;
    }

    pruneMessageDrafts(agents.map((agent) => agent.agentId));
  }, [agents, hasReceivedAgentsSnapshot, pruneMessageDrafts]);

  useEffect(() => {
    if (routeState.view !== "chat") {
      return;
    }

    const currentAgentId = targetAgentId ?? subscribedAgentId;
    const currentAgentExists =
      currentAgentId !== null && agents.some((agent) => agent.agentId === currentAgentId);
    const routeAgentExists = agents.some((agent) => agent.agentId === routeState.agentId);

    if (hasExplicitAgentSelection) {
      if (!routeAgentExists) {
        if (!hasReceivedAgentsSnapshot) {
          return;
        }

        navigateToRoute({ view: "chat", agentId: DEFAULT_MANAGER_AGENT_ID }, true);
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

    const fallbackAgentId = chooseFallbackAgentId(agents, managerOrder);
    if (!fallbackAgentId || fallbackAgentId === currentAgentId) {
      return;
    }

    clientRef.current?.subscribeToAgent(fallbackAgentId);
  }, [
    clientRef,
    agents,
    hasReceivedAgentsSnapshot,
    hasExplicitAgentSelection,
    managerOrder,
    navigateToRoute,
    routeState,
    subscribedAgentId,
    targetAgentId,
  ]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    if (activeView !== "chat" || !isWorkerDetailView || !activeAgentId) {
      client.unsubscribeFromAgentDetail();
      return;
    }

    client.subscribeToAgentDetail(activeAgentId);
  }, [activeAgentId, activeView, clientRef, isWorkerDetailView]);

  useEffect(() => {
    if (isDesktopSidebarLayout) {
      setIsMobileSidebarOpen(false);
    }
  }, [isDesktopSidebarLayout]);

  const cancelSidebarRestoreFrame = useCallback(() => {
    if (typeof window === "undefined" || sidebarRestoreFrameRef.current === null) {
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
        sidebarRestoreFrameRef.current = window.requestAnimationFrame(restoreSidebarWidth);
        return;
      }

      try {
        const currentWidth = Math.round(sidebarPanel.getSize().inPixels);
        if (currentWidth !== Math.round(targetWidth)) {
          sidebarPanel.resize(targetWidth);
          sidebarRestoreFrameRef.current = window.requestAnimationFrame(restoreSidebarWidth);
          return;
        }

        sidebarRestoreFrameRef.current = null;
        if (isDesktopSidebarLayout) {
          storedSidebarWidthRef.current = targetWidth;
          writeStoredSidebarWidth(targetWidth);
        }
        isRestoringSidebarWidthRef.current = false;
      } catch {
        sidebarRestoreFrameRef.current = window.requestAnimationFrame(restoreSidebarWidth);
      }
    };

    restoreSidebarWidth();

    return cancelSidebarRestoreFrame;
  }, [cancelSidebarRestoreFrame, isDesktopSidebarLayout, sidebarPanelRef]);

  const handleSend = (text: string, attachments?: ConversationAttachment[]) => {
    if (!activeAgentId) {
      return;
    }

    markPendingResponse(activeAgentId);

    clientRef.current?.sendUserMessage(text, {
      agentId: activeAgentId,
      delivery: isActiveManager ? "steer" : isLoading ? "steer" : "auto",
      attachments,
    });
  };

  const canStopCurrentSelection = isActiveManager ? isLoading || activeWorkerCount > 0 : isLoading;
  const isCompactingCurrentSelection =
    activeAgentId !== null && compactingAgentId === activeAgentId;
  const showCompactCurrentSelection =
    activeAgent !== null && isPiModelProvider(activeAgent.model.provider);
  const canCompactCurrentSelection =
    showCompactCurrentSelection &&
    activeAgentStatus === "idle" &&
    !isStoppingCurrentSelection &&
    !isCompactingCurrentSelection;
  const stopLabel = isActiveManager ? "Stop manager and workers" : "Stop agent";

  const handleStopCurrentSelection = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !activeAgentId || isStoppingCurrentSelection) {
      return;
    }

    setIsStoppingCurrentSelection(true);

    try {
      if (isActiveManager) {
        await client.stopAllAgents(activeAgentId);
      } else {
        await client.interruptAgent(activeAgentId);
      }

      clearPendingResponseForAgent(activeAgentId);
      setLastError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      setLastError(
        isActiveManager
          ? `Failed to stop manager and workers: ${message}`
          : `Failed to stop agent: ${message}`,
      );
    } finally {
      setIsStoppingCurrentSelection(false);
    }
  }, [
    activeAgentId,
    clearPendingResponseForAgent,
    clientRef,
    isActiveManager,
    isStoppingCurrentSelection,
    setLastError,
  ]);

  const handleCompactCurrentSelection = useCallback(async () => {
    const client = clientRef.current;
    if (
      !client ||
      !activeAgentId ||
      !activeAgent ||
      isCompactingCurrentSelection ||
      !isPiModelProvider(activeAgent.model.provider)
    ) {
      return;
    }

    setCompactingAgentId(activeAgentId);

    try {
      await client.compactAgent(activeAgentId);
      setLastError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      setLastError(`Failed to compact context: ${message}`);
    } finally {
      setCompactingAgentId((current) => (current === activeAgentId ? null : current));
    }
  }, [activeAgent, activeAgentId, clientRef, isCompactingCurrentSelection, setLastError]);

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
    const agent = agents.find((entry) => entry.agentId === agentId);
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

  const handleOpenArtifactInNotes = useCallback(
    (notePath: string) => {
      writeStoredLastOpenNotePath(notePath);
      setPanelSelection(null);
      setIsArtifactsPanelOpen(false);
      navigateToRoute({ view: "notes" });
    },
    [navigateToRoute],
  );

  const handleSuggestionClick = useCallback((prompt: string) => {
    messageInputRef.current?.setInput(prompt);
  }, []);

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

  const statusBanner = statusBannerText ? (
    <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {statusBannerText}
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
            onToggleMobileSidebar={() => setIsMobileSidebarOpen((previous) => !previous)}
          />
        ) : (
          <>
            <ChatHeader
              showCompactContext={showCompactCurrentSelection}
              compactContextInProgress={isCompactingCurrentSelection}
              compactContextDisabled={!canCompactCurrentSelection}
              onCompactContext={() => void handleCompactCurrentSelection()}
              stopAllInProgress={isStoppingCurrentSelection}
              onStopAll={() => void handleStopCurrentSelection()}
              onNewChat={handleNewChat}
              isArtifactsPanelOpen={isArtifactsPanelOpen}
              onToggleArtifactsPanel={handleToggleArtifactsPanel}
              onToggleMobileSidebar={() => setIsMobileSidebarOpen((previous) => !previous)}
            />
            {statusBanner}

            <MessageList
              ref={messageListRef}
              onLoadOlderHistory={handleLoadOlderHistory}
              onSuggestionClick={handleSuggestionClick}
              onArtifactClick={handleOpenArtifact}
              wsUrl={wsUrl}
            />

            <MessageInput
              ref={messageInputRef}
              onSend={handleSend}
              onSubmitted={handleMessageInputSubmitted}
              allowWhileLoading
              canStop={canStopCurrentSelection}
              stopInProgress={isStoppingCurrentSelection}
              onStop={() => void handleStopCurrentSelection()}
              stopLabel={stopLabel}
            />
          </>
        )}
      </div>

      {activeView === "chat" && isDesktopSidebarLayout ? (
        <ArtifactsSidebar
          wsUrl={wsUrl}
          managerId={activeManagerId ?? DEFAULT_MANAGER_AGENT_ID}
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
          managerId={activeManagerId ?? DEFAULT_MANAGER_AGENT_ID}
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
        onOpenInNotes={handleOpenArtifactInNotes}
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
