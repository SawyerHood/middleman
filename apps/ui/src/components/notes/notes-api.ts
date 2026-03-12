import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { NoteDocument, NoteSummary } from '@middleman/protocol'

function isNoteSummary(value: unknown): value is NoteSummary {
  if (!value || typeof value !== 'object') {
    return false
  }

  const note = value as Partial<NoteSummary>
  return (
    typeof note.filename === 'string' &&
    typeof note.title === 'string' &&
    typeof note.createdAt === 'string' &&
    typeof note.updatedAt === 'string' &&
    typeof note.sizeBytes === 'number'
  )
}

function isNoteDocument(value: unknown): value is NoteDocument {
  if (!isNoteSummary(value)) {
    return false
  }

  return typeof (value as Partial<NoteDocument>).content === 'string'
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {}

  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch {}

  return `Request failed (${response.status})`
}

export async function fetchNotes(wsUrl: string, signal?: AbortSignal): Promise<NoteSummary[]> {
  const response = await fetch(resolveApiEndpoint(wsUrl, '/api/notes'), { signal })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as { notes?: unknown }
  if (!payload || !Array.isArray(payload.notes)) {
    return []
  }

  return payload.notes.filter(isNoteSummary)
}

export async function fetchNote(wsUrl: string, filename: string, signal?: AbortSignal): Promise<NoteDocument> {
  const response = await fetch(resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(filename)}`), { signal })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as { note?: unknown }
  if (!isNoteDocument(payload.note)) {
    throw new Error('Invalid note payload.')
  }

  return payload.note
}

export async function saveNote(
  wsUrl: string,
  filename: string,
  content: string,
  signal?: AbortSignal,
): Promise<NoteDocument> {
  const response = await fetch(resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(filename)}`), {
    method: 'PUT',
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
    },
    body: content,
    signal,
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json()) as { note?: unknown }
  if (!isNoteDocument(payload.note)) {
    throw new Error('Invalid note payload.')
  }

  return payload.note
}

export async function deleteNote(wsUrl: string, filename: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(resolveApiEndpoint(wsUrl, `/api/notes/${encodeURIComponent(filename)}`), {
    method: 'DELETE',
    signal,
  })

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}
