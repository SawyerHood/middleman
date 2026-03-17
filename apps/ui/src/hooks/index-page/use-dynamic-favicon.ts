import { useEffect, useMemo } from "react";
import { useAtomValue } from "jotai";
import { resolveManagerFaviconEmoji, setDocumentFavicon } from "@/lib/favicon";
import { activeManagerIdAtom, agentsAtom, statusesAtom } from "@/lib/ws-state";

export function useDynamicFavicon(): void {
  const managerId = useAtomValue(activeManagerIdAtom);
  const agents = useAtomValue(agentsAtom);
  const statuses = useAtomValue(statusesAtom);
  const faviconEmoji = useMemo(
    () => resolveManagerFaviconEmoji(managerId, agents, statuses),
    [agents, managerId, statuses],
  );

  useEffect(() => {
    setDocumentFavicon(faviconEmoji);
  }, [faviconEmoji]);
}
