import type { MouseEvent, ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ContentZoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  contentClassName?: string;
}

export function ContentZoomDialog({
  open,
  onOpenChange,
  title,
  children,
  contentClassName,
}: ContentZoomDialogProps) {
  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            "fixed inset-0 z-[120] bg-black/90 backdrop-blur-sm",
            "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        />

        <DialogPopup
          data-content-zoom-dialog="true"
          className={cn(
            "fixed inset-0 z-[121] flex items-center justify-center overflow-auto outline-none",
            "px-4 py-4 pt-[calc(var(--app-safe-top)+1rem)] pb-[calc(var(--app-safe-bottom)+1rem)] sm:px-6 sm:py-6",
            "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
          onClick={handleBackdropClick}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>

          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "fixed right-4 top-[calc(var(--app-safe-top)+0.75rem)] z-10 size-8 rounded-md sm:right-6",
                  "bg-black/55 text-white/85 backdrop-blur-sm transition-colors",
                  "hover:bg-black/70 hover:text-white",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                )}
                aria-label="Close expanded preview"
              />
            }
          >
            <X className="size-4" aria-hidden="true" />
          </DialogClose>

          <div
            className={cn(
              "relative flex max-h-[calc(var(--app-viewport-height)-var(--app-safe-top)-var(--app-safe-bottom)-2rem)] max-w-[calc(100vw-2rem)] items-center justify-center",
              "sm:max-h-[calc(var(--app-viewport-height)-var(--app-safe-top)-var(--app-safe-bottom)-3rem)] sm:max-w-[calc(100vw-3rem)]",
              contentClassName,
            )}
            onClick={(event) => event.stopPropagation()}
          >
            {children}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
