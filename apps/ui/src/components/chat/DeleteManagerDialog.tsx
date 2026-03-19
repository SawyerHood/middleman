import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentDescriptor } from "@middleman/protocol";

interface DeleteManagerDialogProps {
  managerToDelete: AgentDescriptor | null;
  deleteManagerError: string | null;
  isDeletingManager: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteManagerDialog({
  managerToDelete,
  deleteManagerError,
  isDeletingManager,
  onClose,
  onConfirm,
}: DeleteManagerDialogProps) {
  return (
    <Dialog
      open={Boolean(managerToDelete)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-xl p-4">
        <DialogHeader className="mb-4">
          <DialogTitle>Delete manager</DialogTitle>
          {managerToDelete ? (
            <DialogDescription>
              {`Delete ${managerToDelete.agentId} and its nested workers? This cannot be undone.`}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-4">
          {deleteManagerError ? (
            <p className="text-xs text-destructive">{deleteManagerError}</p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isDeletingManager}>
              Cancel
            </Button>
            <Button type="button" onClick={onConfirm} disabled={isDeletingManager}>
              {isDeletingManager ? "Deleting..." : "Delete manager"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
