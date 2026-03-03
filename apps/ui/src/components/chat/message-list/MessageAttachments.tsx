import { File, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  ConversationImageAttachment,
  ConversationMessageAttachment,
} from '@middleman/protocol'

function isMessageImageAttachment(
  attachment: ConversationMessageAttachment,
): attachment is ConversationImageAttachment {
  const maybeType = attachment.type
  if (maybeType === 'text' || maybeType === 'binary') {
    return false
  }

  return 'data' in attachment && typeof attachment.data === 'string' && attachment.data.length > 0
}

function fileAttachmentSubtitle(attachment: ConversationMessageAttachment): string {
  if (attachment.type === 'text') {
    return 'Text file'
  }

  if (attachment.type === 'binary') {
    return 'Binary file'
  }

  return 'Image file'
}

function MessageImageAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationImageAttachment[]
  isUser: boolean
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {attachments.map((attachment, index) => {
        const src = `data:${attachment.mimeType};base64,${attachment.data}`

        return (
          <img
            key={`${attachment.mimeType}-${attachment.data.slice(0, 32)}-${index}`}
            src={src}
            alt={attachment.fileName || `Attached image ${index + 1}`}
            className={cn(
              'max-h-56 w-full rounded-lg object-cover',
              isUser
                ? 'border border-primary-foreground/25'
                : 'border border-border',
            )}
            loading="lazy"
          />
        )
      })}
    </div>
  )
}

function MessageFileAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {attachments.map((attachment, index) => {
        const isTextFile = attachment.type === 'text'
        const fileName = attachment.fileName || `Attachment ${index + 1}`
        const subtitle = fileAttachmentSubtitle(attachment)

        return (
          <div
            key={`${attachment.mimeType}-${fileName}-${index}`}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2 py-1.5',
              isUser
                ? 'border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground'
                : 'border-border bg-muted/35 text-foreground',
            )}
          >
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded',
                isUser
                  ? 'bg-primary-foreground/15 text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {isTextFile ? <FileText className="size-3.5" /> : <File className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <p className="truncate text-xs font-medium">{fileName}</p>
              <p
                className={cn(
                  'truncate text-[11px]',
                  isUser
                    ? 'text-primary-foreground/80'
                    : 'text-muted-foreground',
                )}
              >
                {subtitle} • {attachment.mimeType}
              </p>
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function MessageAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
}) {
  const imageAttachments = attachments.filter(isMessageImageAttachment)
  const fileAttachments = attachments.filter((attachment) => !isMessageImageAttachment(attachment))

  if (imageAttachments.length === 0 && fileAttachments.length === 0) {
    return null
  }

  return (
    <>
      <MessageImageAttachments attachments={imageAttachments} isUser={isUser} />
      <MessageFileAttachments attachments={fileAttachments} isUser={isUser} />
    </>
  )
}
