import { useAtomValue } from "jotai";
import { contextWindowAtom } from "@/lib/ws-state";

export function useContextWindow(): {
  contextWindowUsage: { usedTokens: number; contextWindow: number } | null;
} {
  return {
    contextWindowUsage: useAtomValue(contextWindowAtom),
  };
}
