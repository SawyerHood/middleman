import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { resolveWorkspaceFaviconEmoji, setDocumentFavicon } from "@/lib/favicon";
import { agentsAtom, statusesAtom } from "@/lib/ws-state";

export function useDynamicFavicon(): void {
  const agents = useAtomValue(agentsAtom);
  const statuses = useAtomValue(statusesAtom);
  const faviconEmoji = resolveWorkspaceFaviconEmoji(agents, statuses);

  useEffect(() => {
    setDocumentFavicon(faviconEmoji);
  }, [faviconEmoji]);
}
