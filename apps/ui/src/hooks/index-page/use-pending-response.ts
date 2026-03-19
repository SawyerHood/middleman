import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  clearPendingResponseForAgentAtom,
  isAwaitingResponseStartAtom,
  markPendingResponseAtom,
  pendingResponseAtom,
  pendingResponseStartAtom,
  resetPendingResponseAtom,
} from "@/lib/ws-state";

export function usePendingResponse(): {
  pendingResponseStart: { agentId: string; messageCount: number } | null;
  markPendingResponse: (agentId?: string) => void;
  clearPendingResponseForAgent: (agentId: string) => void;
  isAwaitingResponseStart: boolean;
} {
  const pendingResponseStart = useAtomValue(pendingResponseStartAtom);
  const pendingResponse = useAtomValue(pendingResponseAtom);
  const isAwaitingResponseStart = useAtomValue(isAwaitingResponseStartAtom);
  const markPendingResponse = useSetAtom(markPendingResponseAtom);
  const clearPendingResponseForAgent = useSetAtom(clearPendingResponseForAgentAtom);
  const resetPendingResponse = useSetAtom(resetPendingResponseAtom);

  useEffect(() => {
    if (!pendingResponseStart || pendingResponse) {
      return;
    }

    resetPendingResponse();
  }, [pendingResponse, pendingResponseStart, resetPendingResponse]);

  return {
    pendingResponseStart: pendingResponse,
    markPendingResponse,
    clearPendingResponseForAgent,
    isAwaitingResponseStart,
  };
}
