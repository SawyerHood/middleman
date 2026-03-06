import { File, FileText } from 'lucide-react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'
import type { ConversationMessageAttachment } from '@middleman/protocol'

interface ImageAttachmentPreview {
  attachment: ConversationMessageAttachment
  src: string
}

function isMessageImageAttachment(
  attachment: ConversationMessageAttachment,
): boolean {
  const maybeType = attachment.type
  if (maybeType === 'text' || maybeType === 'binary') {
    return false
  }

  return attachment.mimeType.trim().toLowerCase().startsWith('image/')
}

function resolveImageAttachmentSrc(
  attachment: ConversationMessageAttachment,
  wsUrl?: string,
): string | null {
  if ('data' in attachment && typeof attachment.data === 'string' && attachment.data.length > 0) {
    return `data:${attachment.mimeType};base64,${attachment.data}`
  }

  const filePath = typeof attachment.filePath === 'string' ? attachment.filePath.trim() : ''
  if (!filePath) {
    return null
  }

  const endpoint = resolveApiEndpoint(wsUrl, '/api/read-file')
  const separator = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${separator}path=${encodeURIComponent(filePath)}`
}

function attachmentKey(attachment: ConversationMessageAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() ?? ''
  const filePath = attachment.filePath?.trim() ?? ''
  const dataPrefix =
    'data' in attachment && typeof attachment.data === 'string'
      ? attachment.data.slice(0, 32)
      : ''

  return `${attachment.type ?? 'image'}-${attachment.mimeType}-${fileName}-${filePath}-${dataPrefix}-${index}`
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
  attachments: ImageAttachmentPreview[]
  isUser: boolean
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {attachments.map(({ attachment, src }, index) => {
        return (
          <img
            key={attachmentKey(attachment, index)}
            src={src}
            alt={attachment.fileName || `Attached image ${index + 1}`}
            className={cn(
              'max-h-56 w-full rounded-lg object-cover',
              isUser ? 'user-message-bubble-border border' : 'border border-border',
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
                ? 'user-message-bubble-surface'
                : 'border-border bg-muted/35 text-foreground',
            )}
          >
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded',
                isUser
                  ? 'user-message-bubble-icon'
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
                    ? 'user-message-bubble-meta'
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
  wsUrl,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
  wsUrl?: string
}) {
  const imageAttachments: ImageAttachmentPreview[] = []
  const fileAttachments: ConversationMessageAttachment[] = []

  for (const attachment of attachments) {
    if (!isMessageImageAttachment(attachment)) {
      fileAttachments.push(attachment)
      continue
    }

    const src = resolveImageAttachmentSrc(attachment, wsUrl)
    if (!src) {
      fileAttachments.push(attachment)
      continue
    }

    imageAttachments.push({ attachment, src })
  }

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
