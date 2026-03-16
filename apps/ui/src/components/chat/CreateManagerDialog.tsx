import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  MANAGER_MODEL_PRESETS,
  type ManagerModelPreset,
} from '@middleman/protocol'

const CREATE_MANAGER_MODEL_PRESETS = MANAGER_MODEL_PRESETS.filter(
  (modelPreset) => modelPreset !== 'claude-code',
)

interface CreateManagerDialogProps {
  open: boolean
  isCreatingManager: boolean
  isValidatingDirectory: boolean
  isPickingDirectory: boolean
  newManagerName: string
  newManagerCwd: string
  newManagerModel: ManagerModelPreset
  createManagerError: string | null
  browseError: string | null
  onOpenChange: (open: boolean) => void
  onNameChange: (value: string) => void
  onCwdChange: (value: string) => void
  onModelChange: (value: ManagerModelPreset) => void
  onBrowseDirectory: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function CreateManagerDialog({
  open,
  isCreatingManager,
  isValidatingDirectory,
  isPickingDirectory,
  newManagerName,
  newManagerCwd,
  newManagerModel,
  createManagerError,
  browseError,
  onOpenChange,
  onNameChange,
  onCwdChange,
  onModelChange,
  onBrowseDirectory,
  onSubmit,
}: CreateManagerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create manager</DialogTitle>
          <DialogDescription>
            Create a new manager with a name and working directory.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="manager-name" className="text-xs font-medium text-muted-foreground">
              Name
            </Label>
            <Input
              id="manager-name"
              placeholder="release-manager"
              value={newManagerName}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="manager-cwd" className="text-xs font-medium text-muted-foreground">
              Working directory
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id="manager-cwd"
                placeholder="/path/to/project"
                value={newManagerCwd}
                onChange={(event) => onCwdChange(event.target.value)}
                className="min-w-0"
              />
              <Button
                type="button"
                variant="outline"
                onClick={onBrowseDirectory}
                disabled={isPickingDirectory || isCreatingManager}
                className="w-full sm:w-auto"
              >
                {isPickingDirectory ? 'Browsing…' : 'Browse'}
              </Button>
            </div>

            {browseError ? (
              <p className="text-xs text-destructive">{browseError}</p>
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              Use Browse to open the native folder picker, or enter a path manually.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="manager-model" className="text-xs font-medium text-muted-foreground">
              Model
            </Label>
            <Select
              value={newManagerModel}
              onValueChange={(value) => {
                if (value) {
                  onModelChange(value as ManagerModelPreset)
                }
              }}
              disabled={isCreatingManager || isPickingDirectory}
            >
              <SelectTrigger id="manager-model" className="w-full">
                <SelectValue placeholder="Select model preset" />
              </SelectTrigger>
              <SelectContent>
                {CREATE_MANAGER_MODEL_PRESETS.map((modelPreset) => (
                  <SelectItem key={modelPreset} value={modelPreset}>
                    {modelPreset}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {createManagerError ? (
            <p className="text-xs text-destructive">{createManagerError}</p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreatingManager}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isCreatingManager || isPickingDirectory}
              className="w-full sm:w-auto"
            >
              {isCreatingManager
                ? isValidatingDirectory
                  ? 'Validating…'
                  : 'Creating…'
                : 'Create manager'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
