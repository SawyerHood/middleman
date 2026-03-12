import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Loader2, PanelLeft, Plus, Trash2 } from 'lucide-react'
import { ViewHeader } from '@/components/ViewHeader'
import { deleteNote, fetchNote, fetchNotes, saveNote } from '@/components/notes/notes-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { NoteDocument, NoteSummary } from '@middleman/protocol'

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

const DEFAULT_NEW_NOTE_CONTENT = '# Untitled note\n'
const NOTES_HOME_LABEL = '~/.middleman/notes'
const NotesMarkdownEditor = lazy(async () => {
  const module = await import('@/components/notes/NotesMarkdownEditor')
  return { default: module.NotesMarkdownEditor }
})

interface NotesViewProps {
  wsUrl: string
  onBack: () => void
  statusBanner?: ReactNode
  onToggleMobileSidebar: () => void
}

export function NotesView({
  wsUrl,
  onBack,
  statusBanner,
  onToggleMobileSidebar,
}: NotesViewProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null)
  const [selectedNote, setSelectedNote] = useState<NoteDocument | null>(null)
  const [editorMarkdown, setEditorMarkdown] = useState('')
  const [notesError, setNotesError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [isLoadingNotes, setIsLoadingNotes] = useState(true)
  const [isLoadingNote, setIsLoadingNote] = useState(false)
  const [isCreatingNote, setIsCreatingNote] = useState(false)
  const [isDeletingNote, setIsDeletingNote] = useState(false)
  const [notePendingDelete, setNotePendingDelete] = useState<NoteSummary | null>(null)

  const lastSavedContentRef = useRef('')
  const autoSaveTimeoutRef = useRef<number | null>(null)
  const editorMarkdownRef = useRef(editorMarkdown)
  const saveSequenceRef = useRef(0)
  const inFlightSaveRef = useRef<Promise<NoteDocument> | null>(null)
  const selectedFilenameRef = useRef<string | null>(selectedFilename)
  const wsUrlRef = useRef(wsUrl)

  const selectedNoteSummary = useMemo(
    () => notes.find((note) => note.filename === selectedFilename) ?? null,
    [notes, selectedFilename],
  )

  editorMarkdownRef.current = editorMarkdown
  selectedFilenameRef.current = selectedFilename
  wsUrlRef.current = wsUrl

  const clearAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current !== null) {
      window.clearTimeout(autoSaveTimeoutRef.current)
      autoSaveTimeoutRef.current = null
    }
  }, [])

  const persistNoteSnapshot = useCallback((filename: string, content: string) => {
    const normalizedContent = normalizeNoteMarkdown(content)
    if (normalizedContent === lastSavedContentRef.current) {
      return
    }

    void saveNote(wsUrlRef.current, filename, normalizedContent).catch(() => undefined)
  }, [])

  const saveSelectedNote = useCallback(
    async (filename: string, content: string): Promise<NoteDocument> => {
      const normalizedContent = normalizeNoteMarkdown(content)
      const requestSequence = ++saveSequenceRef.current

      setSaveStatus('saving')
      setSaveError(null)

      const request = saveNote(wsUrl, filename, normalizedContent).then((note) => ({
        ...note,
        content: normalizeNoteMarkdown(note.content),
      }))

      inFlightSaveRef.current = request

      try {
        const savedNote = await request

        if (requestSequence === saveSequenceRef.current) {
          lastSavedContentRef.current = savedNote.content
          setSelectedNote((current) =>
            current?.filename === savedNote.filename ? savedNote : current,
          )
          setNotes((current) => upsertNote(current, savedNote))
          setSaveStatus(
            editorMarkdownRef.current === savedNote.content ? 'saved' : 'unsaved',
          )
        }

        return savedNote
      } catch (error) {
        if (requestSequence === saveSequenceRef.current) {
          setSaveStatus('error')
          setSaveError(toErrorMessage(error))
        }

        throw error
      } finally {
        if (inFlightSaveRef.current === request) {
          inFlightSaveRef.current = null
        }
      }
    },
    [wsUrl],
  )

  const flushPendingSave = useCallback(async (): Promise<boolean> => {
    clearAutoSave()

    if (!selectedFilename) {
      return true
    }

    if (editorMarkdownRef.current === lastSavedContentRef.current) {
      if (inFlightSaveRef.current) {
        await inFlightSaveRef.current.catch(() => undefined)
      }

      return true
    }

    try {
      await saveSelectedNote(selectedFilename, editorMarkdownRef.current)
      return true
    } catch {
      // Preserve the local error state and keep the current note selected.
      return false
    }
  }, [clearAutoSave, saveSelectedNote, selectedFilename])

  useEffect(() => {
    const abortController = new AbortController()

    setIsLoadingNotes(true)
    setNotesError(null)

    void fetchNotes(wsUrl, abortController.signal)
      .then((nextNotes) => {
        setNotes(nextNotes)
        setSelectedFilename((current) => findNextSelectedFilename(current, nextNotes))
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return
        }

        setNotesError(toErrorMessage(error))
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoadingNotes(false)
        }
      })

    return () => {
      abortController.abort()
      clearAutoSave()
    }
  }, [clearAutoSave, wsUrl])

  useEffect(() => {
    return () => {
      clearAutoSave()

      const filename = selectedFilenameRef.current
      if (!filename) {
        return
      }

      persistNoteSnapshot(filename, editorMarkdownRef.current)
    }
  }, [clearAutoSave, persistNoteSnapshot])

  useEffect(() => {
    if (!selectedFilename) {
      setSelectedNote(null)
      setEditorMarkdown('')
      editorMarkdownRef.current = ''
      lastSavedContentRef.current = ''
      setSaveStatus('saved')
      setSaveError(null)
      return
    }

    const abortController = new AbortController()

    setIsLoadingNote(true)
    setSelectedNote(null)
    setEditorMarkdown('')
    editorMarkdownRef.current = ''
    lastSavedContentRef.current = ''
    setSaveStatus('saved')
    setSaveError(null)

    void fetchNote(wsUrl, selectedFilename, abortController.signal)
      .then((note) => {
        const normalizedNote = {
          ...note,
          content: normalizeNoteMarkdown(note.content),
        }

        setNotesError(null)
        setSelectedNote(normalizedNote)
        setNotes((current) => upsertNote(current, normalizedNote))
        setEditorMarkdown(normalizedNote.content)
        editorMarkdownRef.current = normalizedNote.content
        lastSavedContentRef.current = normalizedNote.content
        setSaveStatus('saved')
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return
        }

        setSelectedNote(null)
        setNotesError(toErrorMessage(error))
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoadingNote(false)
        }
      })

    return () => {
      abortController.abort()
    }
  }, [selectedFilename, wsUrl])

  useEffect(() => {
    clearAutoSave()

    if (!selectedNote || isLoadingNote) {
      return
    }

    if (editorMarkdown === lastSavedContentRef.current) {
      if (saveStatus !== 'saving') {
        setSaveStatus('saved')
      }

      return
    }

    setSaveStatus((current) => (current === 'saving' ? current : 'unsaved'))

    autoSaveTimeoutRef.current = window.setTimeout(() => {
      autoSaveTimeoutRef.current = null
      void saveSelectedNote(selectedNote.filename, editorMarkdownRef.current)
    }, 1000)

    return clearAutoSave
  }, [clearAutoSave, editorMarkdown, isLoadingNote, saveSelectedNote, saveStatus, selectedNote])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!selectedFilenameRef.current) {
        return
      }

      if (editorMarkdownRef.current === lastSavedContentRef.current) {
        return
      }

      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  const handleEditorChange = useCallback((nextMarkdown: string) => {
    setEditorMarkdown(normalizeNoteMarkdown(nextMarkdown))
  }, [])

  const handleCreateNote = useCallback(async () => {
    setIsCreatingNote(true)
    setNotesError(null)

    try {
      const canCreate = await flushPendingSave()
      if (!canCreate) {
        return
      }

      const filename = createUntitledFilename(notes)
      const createdNote = await saveSelectedNote(filename, DEFAULT_NEW_NOTE_CONTENT)
      setSelectedFilename(createdNote.filename)
      setSelectedNote(createdNote)
      setEditorMarkdown(createdNote.content)
      editorMarkdownRef.current = createdNote.content
      lastSavedContentRef.current = createdNote.content
      setSaveStatus('saved')
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsCreatingNote(false)
    }
  }, [flushPendingSave, notes, saveSelectedNote])

  const handleSelectNote = useCallback(
    (filename: string) => {
      if (filename === selectedFilename) {
        return
      }

      void flushPendingSave().then((canSwitch) => {
        if (canSwitch) {
          setSelectedFilename(filename)
        }
      })
    },
    [flushPendingSave, selectedFilename],
  )

  const handleConfirmDelete = useCallback(async () => {
    if (!notePendingDelete) {
      return
    }

    setIsDeletingNote(true)
    setNotesError(null)

    try {
      await deleteNote(wsUrl, notePendingDelete.filename)
      const remainingNotes = notes.filter((note) => note.filename !== notePendingDelete.filename)

      setNotes(remainingNotes)
      setNotePendingDelete(null)

      if (selectedFilename === notePendingDelete.filename) {
        clearAutoSave()
        setSelectedFilename(remainingNotes[0]?.filename ?? null)
        setSelectedNote(null)
        setEditorMarkdown('')
        editorMarkdownRef.current = ''
        lastSavedContentRef.current = ''
        setSaveStatus('saved')
        setSaveError(null)
      }
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsDeletingNote(false)
    }
  }, [clearAutoSave, notePendingDelete, notes, selectedFilename, wsUrl])

  const headerSubtitle = selectedNoteSummary
    ? `${selectedNoteSummary.filename} · ${NOTES_HOME_LABEL}`
    : `Markdown files in ${NOTES_HOME_LABEL}`

  const localBannerMessage = notesError ?? (saveStatus === 'error' ? saveError : null)
  const selectedNoteUpdatedAt = selectedNoteSummary?.updatedAt ?? selectedNote?.updatedAt ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <ViewHeader
        title={
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-foreground">Notes</h1>
            <p className="truncate text-xs text-muted-foreground">{headerSubtitle}</p>
          </div>
        }
        leading={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
        }
        trailing={
          <>
            {selectedFilename ? <SaveStatusPill status={saveStatus} /> : null}
            <span className="text-xs tabular-nums text-muted-foreground/60">
              {notes.length} note{notes.length === 1 ? '' : 's'}
            </span>
          </>
        }
        onBack={onBack}
        backAriaLabel="Back to chat"
      />
      {statusBanner}
      {localBannerMessage ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {localBannerMessage}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 w-full shrink-0 flex-col border-b border-border/70 md:w-72 md:border-b-0 md:border-r">
          <div className="flex h-12 items-center justify-between border-b border-border/70 px-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                Your notes
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleCreateNote()}
              disabled={isCreatingNote}
              aria-label="Create note"
            >
              {isCreatingNote ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            </Button>
          </div>

          <ScrollArea className="h-56 md:h-auto md:flex-1">
            {isLoadingNotes ? (
              <div className="flex h-full items-center justify-center px-4 py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                Loading notes
              </div>
            ) : notes.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-muted/50">
                  <FileText className="size-5 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-foreground/75">No notes yet</p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground/60">
                  Create a markdown note and it will live in {NOTES_HOME_LABEL}.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => void handleCreateNote()}
                  disabled={isCreatingNote}
                >
                  <Plus className="size-3.5" />
                  New note
                </Button>
              </div>
            ) : (
              <div className="py-1">
                {notes.map((note) => {
                  const isSelected = note.filename === selectedFilename

                  return (
                    <div
                      key={note.filename}
                      className={cn(
                        'group flex items-start gap-2 border-b border-border/60 px-2 py-1.5',
                        isSelected ? 'bg-muted/45' : 'hover:bg-muted/25',
                      )}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        onClick={() => handleSelectNote(note.filename)}
                      >
                        <div className="truncate text-[13px] font-medium text-foreground/90">
                          {note.title}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                          <span className="truncate">{note.filename}</span>
                          <span className="text-muted-foreground/30">&middot;</span>
                          <span className="shrink-0">{formatRelativeTime(note.updatedAt)}</span>
                        </div>
                      </button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className={cn(
                          'mt-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
                          isSelected && 'opacity-100',
                        )}
                        onClick={() => setNotePendingDelete(note)}
                        aria-label={`Delete ${note.title}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedNoteSummary ? (
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{selectedNoteSummary.title}</p>
                <p className="truncate text-[11px] text-muted-foreground/65">
                  {selectedNoteSummary.filename}
                </p>
              </div>
              {selectedNoteUpdatedAt ? (
                <span className="shrink-0 text-[11px] text-muted-foreground/60">
                  {formatRelativeTime(selectedNoteUpdatedAt)}
                </span>
              ) : null}
            </div>
          ) : null}

          {selectedFilename === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium text-foreground/75">Choose a note to start writing</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground/65">
                  Notes autosave as markdown files and keep the editor in live preview mode.
                </p>
              </div>
            </div>
          ) : isLoadingNote || !selectedNote ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading note
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading editor
                </div>
              }
            >
              <NotesMarkdownEditor
                key={selectedNote.filename}
                editorId={selectedNote.filename}
                markdown={selectedNote.content}
                onChange={handleEditorChange}
              />
            </Suspense>
          )}
        </div>
      </div>

      <Dialog open={notePendingDelete !== null} onOpenChange={(open) => !open && setNotePendingDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete note?</DialogTitle>
            <DialogDescription>
              {notePendingDelete
                ? `This removes ${notePendingDelete.filename} from ${NOTES_HOME_LABEL}.`
                : 'This note will be removed.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="items-center sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNotePendingDelete(null)}
              disabled={isDeletingNote}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
              disabled={isDeletingNote}
            >
              {isDeletingNote ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SaveStatusPill({ status }: { status: SaveStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'saved' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        status === 'saving' && 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
        status === 'unsaved' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        status === 'error' && 'bg-destructive/10 text-destructive',
      )}
    >
      {status === 'saving' ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
      {status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving' : status === 'unsaved' ? 'Unsaved' : 'Save failed'}
    </span>
  )
}

function normalizeNoteMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (normalized.trim().length === 0) {
    return ''
  }

  return `${normalized.replace(/\n+$/, '')}\n`
}

function createUntitledFilename(notes: NoteSummary[]): string {
  const filenames = new Set(notes.map((note) => note.filename.toLowerCase()))

  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const filename = index === 1 ? 'untitled-note.md' : `untitled-note-${index}.md`
    if (!filenames.has(filename.toLowerCase())) {
      return filename
    }
  }

  return `untitled-note-${Date.now()}.md`
}

function upsertNote(notes: NoteSummary[], nextNote: NoteSummary): NoteSummary[] {
  return sortNotes([
    nextNote,
    ...notes.filter((note) => note.filename !== nextNote.filename),
  ])
}

function sortNotes(notes: NoteSummary[]): NoteSummary[] {
  return [...notes].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt)
    }

    return left.filename.localeCompare(right.filename)
  })
}

function findNextSelectedFilename(
  currentFilename: string | null,
  notes: NoteSummary[],
): string | null {
  if (currentFilename && notes.some((note) => note.filename === currentFilename)) {
    return currentFilename
  }

  return notes[0]?.filename ?? null
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatRelativeTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMinutes = Math.floor(diffMs / 60_000)

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return formatDateTime(value)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'An unexpected error occurred.'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
