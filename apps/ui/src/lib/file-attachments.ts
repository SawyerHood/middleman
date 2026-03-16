import type {
  ConversationAttachment,
  ConversationBinaryAttachment,
  ConversationImageAttachment,
  ConversationTextAttachment,
} from '@middleman/protocol'

export interface PendingImageAttachment extends ConversationImageAttachment {
  id: string
  fileName: string
  dataUrl: string
  sizeBytes: number
}

export interface PendingTextAttachment extends ConversationTextAttachment {
  id: string
  fileName: string
  sizeBytes: number
}

export interface PendingBinaryAttachment extends ConversationBinaryAttachment {
  id: string
  fileName: string
  sizeBytes: number
}

export type PendingAttachment = PendingImageAttachment | PendingTextAttachment | PendingBinaryAttachment

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/sql',
  'application/toml',
  'application/x-sh',
  'application/x-httpd-php',
  'application/x-python-code',
  'application/x-empty',
])

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.zsh',
  '.bash',
  '.sql',
  '.ini',
  '.conf',
  '.log',
])

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export function isPendingImageAttachment(attachment: PendingAttachment): attachment is PendingImageAttachment {
  return (attachment as { type?: string }).type !== 'text' && (attachment as { type?: string }).type !== 'binary'
}

export function isPendingTextAttachment(attachment: PendingAttachment): attachment is PendingTextAttachment {
  return (attachment as { type?: string }).type === 'text'
}

export function isPendingBinaryAttachment(attachment: PendingAttachment): attachment is PendingBinaryAttachment {
  return (attachment as { type?: string }).type === 'binary'
}

export function isImageAttachment(attachment: ConversationAttachment): attachment is ConversationImageAttachment {
  const maybeType = (attachment as { type?: string }).type
  return maybeType !== 'text' && maybeType !== 'binary'
}

export async function fileToPendingAttachment(file: File): Promise<PendingAttachment | null> {
  if (isImageFile(file)) {
    return fileToPendingImageAttachment(file)
  }

  if (isLikelyTextFile(file)) {
    return fileToPendingTextAttachment(file)
  }

  return fileToPendingBinaryAttachment(file)
}

async function fileToPendingImageAttachment(file: File): Promise<PendingImageAttachment | null> {
  const dataUrl = await readFileAsDataUrl(file)
  const base64Data = extractBase64FromDataUrl(dataUrl)
  if (!base64Data) {
    return null
  }

  return {
    id: createAttachmentId(),
    type: 'image',
    mimeType: normalizeMimeType(file.type, 'image/png'),
    fileName: normalizeFileName(file.name, 'image'),
    data: base64Data,
    dataUrl,
    sizeBytes: file.size,
  }
}

async function fileToPendingTextAttachment(file: File): Promise<PendingTextAttachment | null> {
  try {
    const text = await file.text()
    if (text.trim().length === 0) {
      return null
    }

    return {
      id: createAttachmentId(),
      type: 'text',
      mimeType: normalizeMimeType(file.type, 'text/plain'),
      fileName: normalizeFileName(file.name, 'attachment.txt'),
      text,
      sizeBytes: file.size,
    }
  } catch {
    return null
  }
}

async function fileToPendingBinaryAttachment(file: File): Promise<PendingBinaryAttachment | null> {
  try {
    const buffer = await file.arrayBuffer()
    const data = arrayBufferToBase64(buffer)
    if (!data) {
      return null
    }

    return {
      id: createAttachmentId(),
      type: 'binary',
      mimeType: normalizeMimeType(file.type, 'application/octet-stream'),
      fileName: normalizeFileName(file.name, 'attachment.bin'),
      data,
      sizeBytes: file.size,
    }
  } catch {
    return null
  }
}

function normalizeMimeType(raw: string, fallback: string): string {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeFileName(raw: string, fallback: string): string {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function isLikelyTextFile(file: File): boolean {
  const mimeType = file.type.toLowerCase().trim()

  if (mimeType.startsWith('text/')) {
    return true
  }

  if (TEXT_MIME_TYPES.has(mimeType)) {
    return true
  }

  const loweredName = file.name.toLowerCase().trim()
  const extensionIndex = loweredName.lastIndexOf('.')
  if (extensionIndex <= 0) {
    return false
  }

  const extension = loweredName.slice(extensionIndex)
  return TEXT_EXTENSIONS.has(extension)
}

function createAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Failed to read image attachment.'))
    reader.readAsDataURL(file)
  })
}

function extractBase64FromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/)
  if (!match) {
    return null
  }

  return match[1] ?? null
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length === 0) {
    return ''
  }

  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  if (typeof btoa !== 'function') {
    throw new Error('Base64 encoding is not available in this environment.')
  }

  return btoa(binary)
}
