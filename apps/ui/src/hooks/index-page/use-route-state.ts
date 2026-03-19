import { useCallback, useMemo } from "react";

export const DEFAULT_MANAGER_AGENT_ID = "opus-manager";

export type ActiveView = "chat" | "notes" | "settings";
export type AppRouteState =
  | { view: "chat"; agentId: string }
  | { view: "notes" }
  | { view: "settings" };

type AppRouteSearch = {
  view?: string;
  agent?: string;
};

interface ParsedRouteState {
  routeState: AppRouteState;
  hasExplicitAgentSelection: boolean;
}

function normalizeAgentId(agentId?: string): string {
  const trimmedAgentId = agentId?.trim();
  return trimmedAgentId && trimmedAgentId.length > 0 ? trimmedAgentId : DEFAULT_MANAGER_AGENT_ID;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseRouteStateFromPathname(pathname: string): ParsedRouteState {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (normalizedPath === "/settings") {
    return {
      routeState: { view: "settings" },
      hasExplicitAgentSelection: false,
    };
  }

  if (normalizedPath === "/notes") {
    return {
      routeState: { view: "notes" },
      hasExplicitAgentSelection: false,
    };
  }

  const agentMatch = normalizedPath.match(/^\/agent\/([^/]+)$/);
  if (agentMatch) {
    return {
      routeState: {
        view: "chat",
        agentId: normalizeAgentId(decodePathSegment(agentMatch[1])),
      },
      hasExplicitAgentSelection: true,
    };
  }

  return {
    routeState: {
      view: "chat",
      agentId: DEFAULT_MANAGER_AGENT_ID,
    },
    hasExplicitAgentSelection: false,
  };
}

function parseRouteStateFromLocation(pathname: string, search: unknown): ParsedRouteState {
  const routeSearch = search && typeof search === "object" ? (search as AppRouteSearch) : {};
  const view = typeof routeSearch.view === "string" ? routeSearch.view : undefined;
  const agentId = typeof routeSearch.agent === "string" ? routeSearch.agent : undefined;

  if (view === "settings") {
    return {
      routeState: { view: "settings" },
      hasExplicitAgentSelection: false,
    };
  }

  if (view === "notes") {
    return {
      routeState: { view: "notes" },
      hasExplicitAgentSelection: false,
    };
  }

  if (view === "chat" || agentId !== undefined) {
    return {
      routeState: {
        view: "chat",
        agentId: normalizeAgentId(agentId),
      },
      hasExplicitAgentSelection: agentId !== undefined,
    };
  }

  return parseRouteStateFromPathname(pathname);
}

function normalizeRouteState(routeState: AppRouteState): AppRouteState {
  if (routeState.view === "settings") {
    return { view: "settings" };
  }

  if (routeState.view === "notes") {
    return { view: "notes" };
  }

  return {
    view: "chat",
    agentId: normalizeAgentId(routeState.agentId),
  };
}

function toRouteSearch(routeState: AppRouteState): AppRouteSearch {
  if (routeState.view === "settings") {
    return { view: "settings" };
  }

  if (routeState.view === "notes") {
    return { view: "notes" };
  }

  const agentId = normalizeAgentId(routeState.agentId);
  if (agentId === DEFAULT_MANAGER_AGENT_ID) {
    return {};
  }

  return { agent: agentId };
}

function routeStatesEqual(left: AppRouteState, right: AppRouteState): boolean {
  if (left.view === "settings" && right.view === "settings") {
    return true;
  }

  if (left.view === "notes" && right.view === "notes") {
    return true;
  }

  if (left.view === "chat" && right.view === "chat") {
    return left.agentId === right.agentId;
  }

  return false;
}

interface UseRouteStateOptions {
  pathname: string;
  search: unknown;
  navigate: (options: {
    to: string;
    search?: AppRouteSearch;
    replace?: boolean;
    resetScroll?: boolean;
  }) => void | Promise<void>;
}

export function useRouteState({ pathname, search, navigate }: UseRouteStateOptions): {
  routeState: AppRouteState;
  activeView: ActiveView;
  hasExplicitAgentSelection: boolean;
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void;
} {
  const { routeState, hasExplicitAgentSelection } = useMemo(
    () => parseRouteStateFromLocation(pathname, search),
    [pathname, search],
  );

  const activeView: ActiveView = routeState.view;

  const navigateToRoute = useCallback(
    (nextRouteState: AppRouteState, replace = false) => {
      const normalizedRouteState = normalizeRouteState(nextRouteState);
      if (routeStatesEqual(routeState, normalizedRouteState)) {
        return;
      }

      void navigate({
        to: "/",
        search: toRouteSearch(normalizedRouteState),
        replace,
        resetScroll: false,
      });
    },
    [navigate, routeState],
  );

  return {
    routeState,
    activeView,
    hasExplicitAgentSelection,
    navigateToRoute,
  };
}
