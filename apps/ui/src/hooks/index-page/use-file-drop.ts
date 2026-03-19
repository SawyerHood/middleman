import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import type { MessageInputHandle } from "@/components/chat/MessageInput";
import type { ActiveView } from "./use-route-state";

interface UseFileDropOptions {
  activeView: ActiveView;
  messageInputRef: RefObject<MessageInputHandle | null>;
}

export function useFileDrop({ activeView, messageInputRef }: UseFileDropOptions): {
  isDraggingFiles: boolean;
  handleDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  handleDragOver: (event: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  handleDrop: (event: DragEvent<HTMLDivElement>) => void;
} {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (activeView === "chat") {
      return;
    }

    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
  }, [activeView]);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (activeView !== "chat") {
        return;
      }

      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    },
    [activeView],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (activeView !== "chat") {
        return;
      }

      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [activeView],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (activeView !== "chat") {
        return;
      }

      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

      if (dragDepthRef.current === 0) {
        setIsDraggingFiles(false);
      }
    },
    [activeView],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (activeView !== "chat") {
        return;
      }

      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);

      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) {
        return;
      }

      void messageInputRef.current?.addFiles(files);
    },
    [activeView, messageInputRef],
  );

  return {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
