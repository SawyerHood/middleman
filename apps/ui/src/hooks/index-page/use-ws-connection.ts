import { useEffect, useRef, type MutableRefObject } from "react";
import { useStore } from "jotai";
import { ManagerWsClient } from "@/lib/ws-client";

export function useWsConnection(wsUrl: string): {
  clientRef: MutableRefObject<ManagerWsClient | null>;
} {
  const store = useStore();
  const clientRef = useRef<ManagerWsClient | null>(null);

  useEffect(() => {
    const client = new ManagerWsClient(wsUrl, null, store);
    clientRef.current = client;
    client.start();

    return () => {
      if (clientRef.current === client) {
        clientRef.current = null;
      }

      client.destroy();
    };
  }, [store, wsUrl]);

  return {
    clientRef,
  };
}
