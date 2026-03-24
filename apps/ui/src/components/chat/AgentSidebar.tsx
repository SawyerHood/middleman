import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useAtomValue } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileText,
  Settings,
  SquarePen,
  UserStar,
  X,
} from "lucide-react";
import { ViewHeader } from "@/components/ViewHeader";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { buildManagerTreeRows } from "@/lib/agent-hierarchy";
import { isWorkingAgentStatus } from "@/lib/agent-status";
import { moveVisibleManagersWithinOrder, normalizeManagerOrder } from "@/lib/manager-order";
import { inferModelPreset } from "@/lib/model-preset";
import {
  activeAgentIdAtom,
  activeWorkerCountByManagerAtomFamily,
  agentsAtom,
  connectedAtom,
  managerOrderAtom,
  managerTreeAtom,
  statusEntryAtomFamily,
} from "@/lib/ws-state";
import { cn } from "@/lib/utils";
import {
  getManagerModelPresetDefinition,
  type AgentDescriptor,
  type AgentStatus,
  type ManagerModelPreset,
} from "@middleman/protocol";

interface AgentSidebarProps {
  connected?: boolean;
  agents?: AgentDescriptor[];
  managerOrder?: string[];
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>;
  selectedAgentId?: string | null;
  isSettingsActive: boolean;
  isNotesActive: boolean;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  onAddManager: () => void;
  onSelectAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onDeleteManager: (managerId: string) => void;
  onReorderManagers: (managerIds: string[]) => void;
  onOpenNotes: () => void;
  onOpenSettings: () => void;
}

type AgentLiveStatus = {
  status: AgentStatus;
  pendingCount: number;
};

function ClaudeCodeIconPair({ className }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <img
        src="/agents/claude-logo.svg"
        alt=""
        className={cn("size-3 shrink-0 object-contain", className)}
      />
      <img
        src="/agents/claude-logo.svg"
        alt=""
        className={cn("size-3 shrink-0 object-contain opacity-70", className)}
      />
    </span>
  );
}

function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus; pendingCount: number }> | undefined,
): AgentLiveStatus {
  const live = statuses?.[agent.agentId];
  return {
    status: live?.status ?? agent.status,
    pendingCount: live?.pendingCount ?? 0,
  };
}

function useAgentLiveStatus(
  agent: AgentDescriptor,
  statusesOverride?: Record<string, { status: AgentStatus; pendingCount: number }>,
): AgentLiveStatus {
  const liveStatusFromAtom = useAtomValue(statusEntryAtomFamily(agent.agentId));

  return {
    status: statusesOverride?.[agent.agentId]?.status ?? liveStatusFromAtom?.status ?? agent.status,
    pendingCount:
      statusesOverride?.[agent.agentId]?.pendingCount ?? liveStatusFromAtom?.pendingCount ?? 0,
  };
}

function RuntimeIcon({ agent, className }: { agent: AgentDescriptor; className?: string }) {
  const provider = agent.model.provider.toLowerCase();
  const preset = inferModelPreset(agent);
  const iconFamily = preset ? getManagerModelPresetDefinition(preset).iconFamily : undefined;

  if (iconFamily === "pi-claude") {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img
          src="/pi-logo.svg"
          alt=""
          className={cn("size-3 shrink-0 object-contain dark:invert", className)}
        />
        <img
          src="/agents/claude-logo.svg"
          alt=""
          className={cn("size-3 shrink-0 object-contain", className)}
        />
      </span>
    );
  }

  if (iconFamily === "pi-codex") {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img
          src="/pi-logo.svg"
          alt=""
          className={cn("size-3 shrink-0 object-contain dark:invert", className)}
        />
        <img
          src="/agents/codex-logo.svg"
          alt=""
          className={cn("size-3 shrink-0 object-contain dark:invert", className)}
        />
      </span>
    );
  }

  if (iconFamily === "codex-app") {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img
          src="/agents/codex-app-logo.svg"
          alt=""
          className={cn("size-3 shrink-0 object-contain dark:invert", className)}
        />
        <img
          src="/agents/codex-logo.svg"
          alt=""
          className={cn("size-3 shrink-0 object-contain dark:invert", className)}
        />
      </span>
    );
  }

  if (iconFamily === "claude-code" || provider === "anthropic-claude-code") {
    return <ClaudeCodeIconPair className={className} />;
  }

  if (provider.includes("anthropic") || provider.includes("claude")) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className={className} />;
  }

  if (provider.includes("openai")) {
    return (
      <img
        src="/agents/codex-logo.svg"
        alt=""
        aria-hidden="true"
        className={cn("dark:invert", className)}
      />
    );
  }

  return (
    <span
      className={cn("inline-block size-1.5 rounded-full bg-current", className)}
      aria-hidden="true"
    />
  );
}

function getModelTooltipLabel(
  agent: AgentDescriptor,
  preset: ManagerModelPreset | undefined,
): string {
  if (preset) {
    return preset;
  }

  return `${agent.model.provider}/${agent.model.modelId}`;
}

function AgentActivitySlot({
  isActive,
  isSelected,
  streamingWorkerCount,
}: {
  isActive: boolean;
  isSelected: boolean;
  streamingWorkerCount?: number;
}) {
  // When collapsed with active workers, show CircleDashed spinner with count inside
  if (streamingWorkerCount && streamingWorkerCount > 0) {
    return (
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center" />
            }
            aria-label={`${streamingWorkerCount} active worker${streamingWorkerCount !== 1 ? "s" : ""}`}
          >
            <CircleDashed
              className={cn(
                "absolute inset-0 size-3.5 animate-spin",
                isSelected ? "text-sidebar-accent-foreground/80" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "relative text-[7px] font-bold leading-none",
                isSelected ? "text-sidebar-accent-foreground" : "text-muted-foreground",
              )}
            >
              {streamingWorkerCount}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
            {streamingWorkerCount} worker{streamingWorkerCount !== 1 ? "s" : ""} active
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (!isActive) {
    return <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />;
  }

  return (
    <CircleDashed
      className={cn(
        "size-3.5 shrink-0 animate-spin",
        isSelected ? "text-sidebar-accent-foreground/80" : "text-muted-foreground",
      )}
      aria-label="Active"
    />
  );
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
  agent: AgentDescriptor;
  liveStatus: AgentLiveStatus;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  className: string;
  nameClassName?: string;
  streamingWorkerCount?: number;
}) {
  const title = agent.displayName || agent.agentId;
  const isActive = isWorkingAgentStatus(liveStatus.status);
  const preset = inferModelPreset(agent);
  const modelLabel = getModelTooltipLabel(agent, preset);
  const modelDescription = `${agent.model.provider}/${agent.model.modelId}`;
  const modelSummary = `${modelLabel} - thinking: ${agent.model.thinkingLevel}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn(
          "flex w-full items-center gap-1 rounded-md transition-colors",
          isSelected
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-accent/50",
          className,
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="grid w-full min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_2rem] items-center gap-x-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          title={title}
        >
          <AgentActivitySlot
            isActive={isActive}
            isSelected={isSelected}
            streamingWorkerCount={streamingWorkerCount}
          />
          <span className={cn("min-w-0 truncate text-sm leading-5", nameClassName)}>{title}</span>

          <TooltipProvider delay={200}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "inline-flex h-5 w-8 shrink-0 items-center justify-center justify-self-end rounded-sm border border-sidebar-border/80 bg-sidebar-accent/40 px-0.5",
                      isSelected ? "border-sidebar-ring/60 bg-sidebar-accent-foreground/10" : "",
                    )}
                  />
                }
              >
                <RuntimeIcon agent={agent} className="size-3 shrink-0 object-contain opacity-90" />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                <p className="font-medium">{modelSummary}</p>
                {modelDescription !== modelLabel ? (
                  <p className="opacity-80">{modelDescription}</p>
                ) : null}
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
  );
}

function WorkerAgentRow({
  agent,
  statuses,
  isSelected,
  onSelect,
  onDelete,
}: {
  agent: AgentDescriptor;
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const liveStatus = useAgentLiveStatus(agent, statuses);

  return (
    <AgentRow
      agent={agent}
      liveStatus={liveStatus}
      isSelected={isSelected}
      onSelect={onSelect}
      onDelete={onDelete}
      nameClassName="font-normal"
      className="py-1.5 pl-7 pr-1.5"
    />
  );
}

function toDragTransform(transform: { x: number; y: number } | null): string | undefined {
  if (!transform) {
    return undefined;
  }

  return `translate3d(${transform.x}px, ${transform.y}px, 0)`;
}

function SortableManagerRow({
  manager,
  workers,
  statuses,
  selectedAgentId,
  isSelectionSuppressed,
  isCollapsed,
  isDragDisabled,
  onToggleCollapsed,
  onSelectManager,
  onDeleteManager,
  onSelectWorker,
  onDeleteWorker,
}: {
  manager: AgentDescriptor;
  workers: AgentDescriptor[];
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>;
  selectedAgentId: string | null;
  isSelectionSuppressed: boolean;
  isCollapsed: boolean;
  isDragDisabled: boolean;
  onToggleCollapsed: () => void;
  onSelectManager: () => void;
  onDeleteManager: () => void;
  onSelectWorker: (agentId: string) => void;
  onDeleteWorker: (agentId: string) => void;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: manager.agentId,
    disabled: isDragDisabled,
  });
  const managerLiveStatus = useAgentLiveStatus(manager, statuses);
  const managerIsSelected = !isSelectionSuppressed && selectedAgentId === manager.agentId;
  const streamingWorkerCountFromAtom = useAtomValue(
    activeWorkerCountByManagerAtomFamily(manager.agentId),
  );
  const streamingWorkerCount = isCollapsed
    ? statuses
      ? workers.filter((worker) =>
          isWorkingAgentStatus(getAgentLiveStatus(worker, statuses).status),
        ).length
      : streamingWorkerCountFromAtom
    : 0;

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: toDragTransform(transform),
        transition,
      }}
      className={cn(isDragging ? "relative z-10" : undefined)}
    >
      <div
        className={cn(
          "relative",
          isDragging
            ? "rounded-md shadow-lg shadow-black/10 ring-1 ring-sidebar-ring/40"
            : undefined,
        )}
      >
        <div className="relative flex items-center" {...attributes} {...listeners}>
          <AgentRow
            agent={manager}
            liveStatus={managerLiveStatus}
            isSelected={managerIsSelected}
            onSelect={onSelectManager}
            onDelete={onDeleteManager}
            nameClassName="font-semibold"
            className="min-w-0 flex-1 py-1.5 pl-7 pr-1.5"
            streamingWorkerCount={isCollapsed ? streamingWorkerCount : undefined}
          />

          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} manager ${manager.agentId}`}
            aria-expanded={!isCollapsed}
            className={cn(
              "group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition",
              "hover:text-sidebar-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60",
            )}
          >
            <span className="relative flex h-3.5 w-3.5 items-center justify-center">
              {isCollapsed ? (
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

        {workers.length > 0 && !isCollapsed ? (
          <div className="relative mt-0.5">
            <div className="absolute bottom-1 left-3.5 top-0 w-px bg-sidebar-border/40" />
            <ul className="space-y-0.5">
              {workers.map((worker) => {
                const workerIsSelected =
                  !isSelectionSuppressed && selectedAgentId === worker.agentId;

                return (
                  <li key={worker.agentId}>
                    <WorkerAgentRow
                      agent={worker}
                      statuses={statuses}
                      isSelected={workerIsSelected}
                      onSelect={() => onSelectWorker(worker.agentId)}
                      onDelete={() => onDeleteWorker(worker.agentId)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function AgentSidebar({
  connected: _connected,
  agents,
  managerOrder,
  statuses,
  selectedAgentId,
  isSettingsActive,
  isNotesActive,
  isMobileOpen = false,
  onMobileClose,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
  onReorderManagers,
  onOpenNotes,
  onOpenSettings,
}: AgentSidebarProps) {
  useAtomValue(connectedAtom);
  const agentsFromAtom = useAtomValue(agentsAtom);
  const managerOrderFromAtom = useAtomValue(managerOrderAtom);
  const selectedAgentIdFromAtom = useAtomValue(activeAgentIdAtom);
  const managerTreeFromAtom = useAtomValue(managerTreeAtom);
  const resolvedAgents = agents ?? agentsFromAtom;
  const resolvedManagerOrder = managerOrder ?? managerOrderFromAtom;
  const resolvedSelectedAgentId = selectedAgentId ?? selectedAgentIdFromAtom;
  const normalizedManagerOrder = normalizeManagerOrder(resolvedManagerOrder, resolvedAgents);
  const { managerRows, orphanWorkers } =
    agents !== undefined || managerOrder !== undefined
      ? buildManagerTreeRows(resolvedAgents, normalizedManagerOrder)
      : managerTreeFromAtom;
  const [expandedManagerIds, setExpandedManagerIds] = useState<Set<string>>(() => new Set());
  const visibleManagerIds = managerRows.map(({ manager }) => manager.agentId);
  const canDragManagers = visibleManagerIds.length > 1;
  const isSelectionSuppressed = isSettingsActive || isNotesActive;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const toggleManagerCollapsed = (managerId: string) => {
    setExpandedManagerIds((previous) => {
      const next = new Set(previous);

      if (next.has(managerId)) {
        next.delete(managerId);
      } else {
        next.add(managerId);
      }

      return next;
    });
  };

  const handleSelectAgent = (agentId: string) => {
    onSelectAgent(agentId);
    onMobileClose?.();
  };

  const handleOpenSettings = () => {
    onOpenSettings();
    onMobileClose?.();
  };

  const handleOpenNotes = () => {
    onOpenNotes();
    onMobileClose?.();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (!canDragManagers || !event.over) {
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId === overId) {
      return;
    }

    const nextManagerOrder = moveVisibleManagersWithinOrder({
      agents: resolvedAgents,
      managerOrder: normalizedManagerOrder,
      visibleManagerIds,
      activeId,
      overId,
    });

    if (nextManagerOrder.every((managerId, index) => managerId === normalizedManagerOrder[index])) {
      return;
    }

    onReorderManagers(nextManagerOrder);
  };

  const sidebarContent = (
    <aside
      className={cn(
        "flex h-full w-full min-w-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
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
          scrollbarWidth: "thin",
          scrollbarColor: "var(--sidebar-border) transparent",
        }}
      >
        {managerRows.length === 0 ? (
          <p className="rounded-md bg-sidebar-accent/50 px-3 py-4 text-center text-xs text-muted-foreground">
            No agents yet.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={visibleManagerIds} strategy={verticalListSortingStrategy}>
              <ul className="space-y-0.5">
                {managerRows.map(({ manager, workers }) => (
                  <SortableManagerRow
                    key={manager.agentId}
                    manager={manager}
                    workers={workers}
                    statuses={statuses}
                    selectedAgentId={resolvedSelectedAgentId}
                    isSelectionSuppressed={isSelectionSuppressed}
                    isCollapsed={!expandedManagerIds.has(manager.agentId)}
                    isDragDisabled={!canDragManagers}
                    onToggleCollapsed={() => toggleManagerCollapsed(manager.agentId)}
                    onSelectManager={() => handleSelectAgent(manager.agentId)}
                    onDeleteManager={() => onDeleteManager(manager.agentId)}
                    onSelectWorker={handleSelectAgent}
                    onDeleteWorker={onDeleteAgent}
                  />
                ))}

                {orphanWorkers.length > 0 ? (
                  <li className="mt-3">
                    <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
                      Unassigned
                    </p>
                    <ul className="space-y-0.5">
                      {orphanWorkers.map((worker) => {
                        const workerIsSelected =
                          !isSelectionSuppressed && resolvedSelectedAgentId === worker.agentId;

                        return (
                          <li key={worker.agentId}>
                            <WorkerAgentRow
                              agent={worker}
                              statuses={statuses}
                              isSelected={workerIsSelected}
                              onSelect={() => handleSelectAgent(worker.agentId)}
                              onDelete={() => onDeleteAgent(worker.agentId)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ) : null}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <div className="space-y-1">
          <button
            type="button"
            onClick={handleOpenNotes}
            className={cn(
              "flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60",
              isNotesActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            )}
            aria-pressed={isNotesActive}
          >
            <FileText aria-hidden="true" className="size-4" />
            <span className="flex-1 text-left">Notes</span>
          </button>

          <button
            type="button"
            onClick={handleOpenSettings}
            className={cn(
              "flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60",
              isSettingsActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            )}
            aria-pressed={isSettingsActive}
          >
            <Settings aria-hidden="true" className="size-4" />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop: render inline */}
      <div className="hidden h-full min-w-0 md:flex md:w-full">{sidebarContent}</div>

      {/* Mobile: render as overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          isMobileOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        {/* Backdrop */}
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity duration-200",
            isMobileOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={onMobileClose}
          aria-hidden="true"
        />
        {/* Sidebar panel */}
        <div
          className={cn(
            "relative z-10 h-full w-[80vw] max-w-[20rem] transition-transform duration-200 ease-out",
            isMobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {sidebarContent}
        </div>
      </div>
    </>
  );
}
