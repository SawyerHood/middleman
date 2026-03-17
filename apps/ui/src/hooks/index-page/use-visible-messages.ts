import { useAtomValue } from "jotai";
import { allMessagesAtom, visibleMessagesAtom } from "@/lib/ws-state";
import type { ConversationEntry } from "@middleman/protocol";
export { deriveVisibleMessages } from "@/lib/visible-messages";

export function useVisibleMessages(): {
  allMessages: ConversationEntry[];
  visibleMessages: ConversationEntry[];
} {
  const allMessages = useAtomValue(allMessagesAtom);
  const visibleMessages = useAtomValue(visibleMessagesAtom);

  return {
    allMessages,
    visibleMessages,
  };
}
