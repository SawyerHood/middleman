import { File, FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  isPendingImageAttachment,
  isPendingTextAttachment,
  type PendingAttachment,
} from '@/lib/file-attachments'

interface AttachedFilesProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
}

export function AttachedFiles({ attachments, onRemove }: AttachedFilesProps) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
      {attachments.map((attachment) => {
        const isImage = isPendingImageAttachment(attachment)

        return (
          <div key={attachment.id} className="group relative">
            {isImage ? (
              <img
                src={attachment.dataUrl}
                alt={attachment.fileName || 'Attached image'}
                className="size-16 rounded border border-border object-cover"
              />
            ) : (
              <div className="flex h-16 w-full max-w-full items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5 sm:w-52">
                <div className="rounded bg-muted p-1.5 text-muted-foreground">
                  {isPendingTextAttachment(attachment) ? <FileText className="size-3.5" /> : <File className="size-3.5" />}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{attachment.fileName}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {isPendingTextAttachment(attachment) ? 'Text file' : 'Binary file'} • {formatBytes(attachment.sizeBytes)}
                  </p>
                </div>
              </div>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRemove(attachment.id)}
              className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-muted p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-red-600 hover:text-white focus:opacity-100 focus-visible:ring-red-300 group-hover:opacity-100"
              aria-label={`Remove ${attachment.fileName || 'attachment'}`}
            >
              <X className="size-3" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  }

  const mb = kb / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}
