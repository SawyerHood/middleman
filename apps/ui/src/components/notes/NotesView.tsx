import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { FileText, FolderPlus, Loader2, PanelLeft, Plus, Trash2 } from 'lucide-react'
import { ViewHeader } from '@/components/ViewHeader'
import { NotesTree } from '@/components/notes/NotesTree'
import {
  createFolder as createFolderRequest,
  deleteFolder as deleteFolderRequest,
  deleteNote as deleteNoteRequest,
  fetchNote,
  fetchNoteTree,
  renameNote as renameNoteRequest,
  saveNote,
} from '@/components/notes/notes-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { NoteDocument, NoteFolder, NoteSummary, NoteTreeNode } from '@middleman/protocol'

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error'

const DEFAULT_NEW_NOTE_CONTENT = '# Untitled note\n'
const NOTES_HOME_LABEL = '~/.middleman/notes'
const ROOT_FOLDER_VALUE = '__root__'
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
  const [tree, setTree] = useState<NoteTreeNode[]>([])
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null)
  const [selectedNote, setSelectedNote] = useState<NoteDocument | null>(null)
  const [editorMarkdown, setEditorMarkdown] = useState('')
  const [notesError, setNotesError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [isLoadingTree, setIsLoadingTree] = useState(true)
  const [isLoadingNote, setIsLoadingNote] = useState(false)
  const [expandedFolderPaths, setExpandedFolderPaths] = useState<string[]>([])
  const [renamingNotePath, setRenamingNotePath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [isRenamingNote, setIsRenamingNote] = useState(false)
  const [createNoteDialogOpen, setCreateNoteDialogOpen] = useState(false)
  const [createNoteParentPath, setCreateNoteParentPath] = useState<string | null>(null)
  const [createNoteNameDraft, setCreateNoteNameDraft] = useState('')
  const [isCreatingNote, setIsCreatingNote] = useState(false)
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false)
  const [createFolderParentPath, setCreateFolderParentPath] = useState<string | null>(null)
  const [createFolderNameDraft, setCreateFolderNameDraft] = useState('new-folder')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [notePendingMove, setNotePendingMove] = useState<NoteSummary | null>(null)
  const [moveDestinationFolder, setMoveDestinationFolder] = useState(ROOT_FOLDER_VALUE)
  const [isMovingNote, setIsMovingNote] = useState(false)
  const [notePendingDelete, setNotePendingDelete] = useState<NoteSummary | null>(null)
  const [folderPendingDelete, setFolderPendingDelete] = useState<NoteFolder | null>(null)
  const [isDeletingNote, setIsDeletingNote] = useState(false)
  const [isDeletingFolder, setIsDeletingFolder] = useState(false)

  const lastSavedContentRef = useRef('')
  const autoSaveTimeoutRef = useRef<number | null>(null)
  const editorMarkdownRef = useRef(editorMarkdown)
  const saveSequenceRef = useRef(0)
  const inFlightSaveRef = useRef<Promise<NoteDocument> | null>(null)
  const selectedNotePathRef = useRef<string | null>(selectedNotePath)
  const selectedNoteRef = useRef<NoteDocument | null>(selectedNote)
  const expandedFolderPathsRef = useRef<string[]>(expandedFolderPaths)
  const wsUrlRef = useRef(wsUrl)
  const loadedNotePathRef = useRef<string | null>(null)
  const renameSubmittingRef = useRef(false)
  const hasInitializedExpansionRef = useRef(false)

  const noteList = useMemo(() => flattenNoteTree(tree), [tree])
  const folderList = useMemo(() => flattenFolderTree(tree), [tree])
  const noteIndex = useMemo(() => new Map(noteList.map((note) => [note.path, note])), [noteList])

  editorMarkdownRef.current = editorMarkdown
  selectedNotePathRef.current = selectedNotePath
  selectedNoteRef.current = selectedNote
  expandedFolderPathsRef.current = expandedFolderPaths
  wsUrlRef.current = wsUrl

  const selectedNoteSummary = selectedNotePath ? noteIndex.get(selectedNotePath) ?? null : null
  const selectedNoteUpdatedAt = selectedNoteSummary?.updatedAt ?? selectedNote?.updatedAt ?? null
  const folderOptions = useMemo(
    () => [{ path: null, label: NOTES_HOME_LABEL }, ...folderList.map((folder) => ({ path: folder.path, label: folder.path }))],
    [folderList],
  )

  const clearAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current !== null) {
      window.clearTimeout(autoSaveTimeoutRef.current)
      autoSaveTimeoutRef.current = null
    }
  }, [])

  const applyLoadedNote = useCallback((note: NoteDocument | null) => {
    if (!note) {
      loadedNotePathRef.current = null
      selectedNoteRef.current = null
      setSelectedNote(null)
      setEditorMarkdown('')
      editorMarkdownRef.current = ''
      lastSavedContentRef.current = ''
      setSaveStatus('saved')
      setSaveError(null)
      return
    }

    const normalizedNote = normalizeNoteDocument(note)
    loadedNotePathRef.current = normalizedNote.path
    selectedNoteRef.current = normalizedNote
    setSelectedNote(normalizedNote)
    setEditorMarkdown(normalizedNote.content)
    editorMarkdownRef.current = normalizedNote.content
    lastSavedContentRef.current = normalizedNote.content
    setSaveStatus('saved')
    setSaveError(null)
  }, [])

  const selectLoadedNote = useCallback((note: NoteDocument) => {
    const normalizedNote = normalizeNoteDocument(note)
    selectedNotePathRef.current = normalizedNote.path
    loadedNotePathRef.current = normalizedNote.path
    selectedNoteRef.current = normalizedNote
    setSelectedNotePath(normalizedNote.path)
    setSelectedNote(normalizedNote)
    setEditorMarkdown(normalizedNote.content)
    editorMarkdownRef.current = normalizedNote.content
    lastSavedContentRef.current = normalizedNote.content
    setSaveStatus('saved')
    setSaveError(null)
  }, [])

  const loadTree = useCallback(
    async (
      signal?: AbortSignal,
      options?: {
        preferredSelectedPath?: string | null
        revealPaths?: string[]
      },
    ) => {
      const nextTree = await fetchNoteTree(wsUrl, signal)
      const nextNotes = flattenNoteTree(nextTree)
      const nextSelectedPath = findNextSelectedNotePath(
        options?.preferredSelectedPath ?? selectedNotePathRef.current,
        nextNotes,
      )
      const nextExpandedFolders = mergeExpandedFolderPaths(
        expandedFolderPathsRef.current,
        nextTree,
        nextSelectedPath,
        options?.revealPaths ?? [],
        !hasInitializedExpansionRef.current,
      )

      hasInitializedExpansionRef.current = true
      startTransition(() => {
        setTree(nextTree)
        setSelectedNotePath(nextSelectedPath)
        setExpandedFolderPaths(nextExpandedFolders)
      })
    },
    [wsUrl],
  )

  const persistNoteSnapshot = useCallback((path: string, content: string) => {
    const normalizedContent = normalizeNoteMarkdown(content)
    if (normalizedContent === lastSavedContentRef.current) {
      return
    }

    void saveNote(wsUrlRef.current, path, normalizedContent).catch(() => undefined)
  }, [])

  const saveSelectedNote = useCallback(
    async (path: string, content: string): Promise<NoteDocument> => {
      const normalizedContent = normalizeNoteMarkdown(content)
      const requestSequence = ++saveSequenceRef.current

      setSaveStatus('saving')
      setSaveError(null)

      const request = saveNote(wsUrl, path, normalizedContent).then(normalizeNoteDocument)
      inFlightSaveRef.current = request

      try {
        const savedNote = await request

        if (requestSequence === saveSequenceRef.current) {
          lastSavedContentRef.current = savedNote.content
          if (selectedNoteRef.current?.path === savedNote.path) {
            selectedNoteRef.current = savedNote
            loadedNotePathRef.current = savedNote.path
            setSelectedNote(savedNote)
          }

          setTree((current) => replaceNoteInTree(current, savedNote))
          setSaveStatus(editorMarkdownRef.current === savedNote.content ? 'saved' : 'unsaved')
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

    if (!selectedNotePath) {
      return true
    }

    if (editorMarkdownRef.current === lastSavedContentRef.current) {
      if (inFlightSaveRef.current) {
        await inFlightSaveRef.current.catch(() => undefined)
      }

      return true
    }

    try {
      await saveSelectedNote(selectedNotePath, editorMarkdownRef.current)
      return true
    } catch {
      return false
    }
  }, [clearAutoSave, saveSelectedNote, selectedNotePath])

  useEffect(() => {
    const abortController = new AbortController()

    setIsLoadingTree(true)
    setNotesError(null)

    void loadTree(abortController.signal)
      .catch((error) => {
        if (isAbortError(error)) {
          return
        }

        setNotesError(toErrorMessage(error))
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoadingTree(false)
        }
      })

    return () => {
      abortController.abort()
      clearAutoSave()
    }
  }, [clearAutoSave, loadTree, wsUrl])

  useEffect(() => {
    return () => {
      clearAutoSave()

      const path = selectedNotePathRef.current
      if (!path) {
        return
      }

      persistNoteSnapshot(path, editorMarkdownRef.current)
    }
  }, [clearAutoSave, persistNoteSnapshot])

  useEffect(() => {
    if (!selectedNotePath) {
      applyLoadedNote(null)
      return
    }

    if (selectedNoteRef.current?.path === selectedNotePath && loadedNotePathRef.current === selectedNotePath) {
      setIsLoadingNote(false)
      return
    }

    const abortController = new AbortController()

    setIsLoadingNote(true)
    applyLoadedNote(null)

    void fetchNote(wsUrl, selectedNotePath, abortController.signal)
      .then((note) => {
        setNotesError(null)
        setTree((current) => replaceNoteInTree(current, normalizeNoteDocument(note)))
        applyLoadedNote(note)
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return
        }

        applyLoadedNote(null)
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
  }, [applyLoadedNote, selectedNotePath, wsUrl])

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
      void saveSelectedNote(selectedNote.path, editorMarkdownRef.current)
    }, 1000)

    return clearAutoSave
  }, [clearAutoSave, editorMarkdown, isLoadingNote, saveSelectedNote, saveStatus, selectedNote])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!selectedNotePathRef.current) {
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

  const handleSelectNote = useCallback(
    (path: string) => {
      if (path === selectedNotePath) {
        return
      }

      void flushPendingSave().then((canSwitch) => {
        if (canSwitch) {
          setSelectedNotePath(path)
        }
      })
    },
    [flushPendingSave, selectedNotePath],
  )

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolderPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return [...next]
    })
  }, [])

  const openCreateNoteDialog = useCallback(
    (folderPath: string | null) => {
      const nextParentPath = folderPath ?? parentFolderPathOf(selectedNotePathRef.current)
      setCreateNoteParentPath(nextParentPath)
      setCreateNoteNameDraft(createUntitledNoteName(noteList, nextParentPath))
      setCreateNoteDialogOpen(true)
    },
    [noteList],
  )

  const openCreateFolderDialog = useCallback((folderPath: string | null) => {
    setCreateFolderParentPath(folderPath)
    setCreateFolderNameDraft('new-folder')
    setCreateFolderDialogOpen(true)
  }, [])

  const handleCreateNote = useCallback(async () => {
    const notePath = joinNotePath(createNoteParentPath, createNoteNameDraft)

    setIsCreatingNote(true)
    setNotesError(null)

    try {
      const canCreate = await flushPendingSave()
      if (!canCreate) {
        return
      }

      const createdNote = await saveNote(wsUrl, notePath, DEFAULT_NEW_NOTE_CONTENT)
      selectLoadedNote(createdNote)
      await loadTree(undefined, {
        preferredSelectedPath: createdNote.path,
        revealPaths: [parentFolderPathOf(createdNote.path) ?? ''],
      })
      setCreateNoteDialogOpen(false)
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsCreatingNote(false)
    }
  }, [createNoteNameDraft, createNoteParentPath, flushPendingSave, loadTree, selectLoadedNote, wsUrl])

  const handleCreateFolder = useCallback(async () => {
    const folderPath = joinFolderPath(createFolderParentPath, createFolderNameDraft)

    setIsCreatingFolder(true)
    setNotesError(null)

    try {
      const createdFolder = await createFolderRequest(wsUrl, folderPath)
      await loadTree(undefined, {
        revealPaths: [createdFolder.path],
      })
      setCreateFolderDialogOpen(false)
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsCreatingFolder(false)
    }
  }, [createFolderNameDraft, createFolderParentPath, loadTree, wsUrl])

  const handleStartRenameNote = useCallback((note: NoteSummary) => {
    setRenamingNotePath(note.path)
    setRenameDraft(note.name)
  }, [])

  const handleCancelRenameNote = useCallback(() => {
    setRenamingNotePath(null)
    setRenameDraft('')
  }, [])

  const handleCommitRenameNote = useCallback(async () => {
    if (!renamingNotePath || renameSubmittingRef.current) {
      return
    }

    const note = noteIndex.get(renamingNotePath)
    if (!note) {
      handleCancelRenameNote()
      return
    }

    const nextPath = joinNotePath(parentFolderPathOf(note.path), renameDraft)
    if (nextPath === note.path) {
      handleCancelRenameNote()
      return
    }

    renameSubmittingRef.current = true
    setIsRenamingNote(true)
    setNotesError(null)

    try {
      const canRename = renamingNotePath === selectedNotePathRef.current ? await flushPendingSave() : true
      if (!canRename) {
        return
      }

      const renamedNote = await renameNoteRequest(wsUrl, note.path, nextPath)
      const preferredSelectedPath =
        selectedNotePathRef.current === note.path ? renamedNote.path : selectedNotePathRef.current

      if (selectedNotePathRef.current === note.path) {
        selectLoadedNote(renamedNote)
      }

      await loadTree(undefined, {
        preferredSelectedPath,
        revealPaths: [parentFolderPathOf(renamedNote.path) ?? ''],
      })
      handleCancelRenameNote()
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      renameSubmittingRef.current = false
      setIsRenamingNote(false)
    }
  }, [flushPendingSave, handleCancelRenameNote, loadTree, noteIndex, renameDraft, renamingNotePath, selectLoadedNote, wsUrl])

  const handleOpenMoveDialog = useCallback((note: NoteSummary) => {
    setNotePendingMove(note)
    setMoveDestinationFolder(toFolderValue(parentFolderPathOf(note.path)))
  }, [])

  const handleConfirmMove = useCallback(async () => {
    if (!notePendingMove) {
      return
    }

    const destinationFolderPath = fromFolderValue(moveDestinationFolder)
    const destinationPath = joinNotePath(destinationFolderPath, notePendingMove.name)

    if (destinationPath === notePendingMove.path) {
      setNotePendingMove(null)
      return
    }

    setIsMovingNote(true)
    setNotesError(null)

    try {
      const canMove = notePendingMove.path === selectedNotePathRef.current ? await flushPendingSave() : true
      if (!canMove) {
        return
      }

      const movedNote = await renameNoteRequest(wsUrl, notePendingMove.path, destinationPath)
      const preferredSelectedPath =
        selectedNotePathRef.current === notePendingMove.path ? movedNote.path : selectedNotePathRef.current

      if (selectedNotePathRef.current === notePendingMove.path) {
        selectLoadedNote(movedNote)
      }

      await loadTree(undefined, {
        preferredSelectedPath,
        revealPaths: [destinationFolderPath ?? ''],
      })
      setNotePendingMove(null)
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsMovingNote(false)
    }
  }, [flushPendingSave, loadTree, moveDestinationFolder, notePendingMove, selectLoadedNote, wsUrl])

  const handleConfirmDeleteNote = useCallback(async () => {
    if (!notePendingDelete) {
      return
    }

    setIsDeletingNote(true)
    setNotesError(null)

    try {
      await deleteNoteRequest(wsUrl, notePendingDelete.path)

      if (selectedNotePathRef.current === notePendingDelete.path) {
        loadedNotePathRef.current = null
        selectedNoteRef.current = null
      }

      await loadTree(undefined, {
        preferredSelectedPath:
          selectedNotePathRef.current === notePendingDelete.path ? null : selectedNotePathRef.current,
      })
      setNotePendingDelete(null)
      if (selectedNotePathRef.current === notePendingDelete.path) {
        applyLoadedNote(null)
      }
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsDeletingNote(false)
    }
  }, [applyLoadedNote, loadTree, notePendingDelete, wsUrl])

  const handleConfirmDeleteFolder = useCallback(async () => {
    if (!folderPendingDelete) {
      return
    }

    setIsDeletingFolder(true)
    setNotesError(null)

    try {
      await deleteFolderRequest(wsUrl, folderPendingDelete.path)

      if (selectedNotePathRef.current && pathIsInsideFolder(selectedNotePathRef.current, folderPendingDelete.path)) {
        loadedNotePathRef.current = null
        selectedNoteRef.current = null
      }

      await loadTree(undefined, {
        preferredSelectedPath:
          selectedNotePathRef.current && pathIsInsideFolder(selectedNotePathRef.current, folderPendingDelete.path)
            ? null
            : selectedNotePathRef.current,
      })
      setFolderPendingDelete(null)
      if (selectedNotePathRef.current && pathIsInsideFolder(selectedNotePathRef.current, folderPendingDelete.path)) {
        applyLoadedNote(null)
      }
    } catch (error) {
      setNotesError(toErrorMessage(error))
    } finally {
      setIsDeletingFolder(false)
    }
  }, [applyLoadedNote, folderPendingDelete, loadTree, wsUrl])

  const headerSubtitle = selectedNoteSummary
    ? `${selectedNoteSummary.path} · ${NOTES_HOME_LABEL}`
    : `Markdown files in ${NOTES_HOME_LABEL}`

  const localBannerMessage = notesError ?? (saveStatus === 'error' ? saveError : null)
  const isCreateNoteDisabled = createNoteNameDraft.trim().length === 0 || isCreatingNote
  const isCreateFolderDisabled = createFolderNameDraft.trim().length === 0 || isCreatingFolder

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
            {selectedNotePath ? <SaveStatusPill status={saveStatus} /> : null}
            <span className="text-xs tabular-nums text-muted-foreground/60">
              {noteList.length} note{noteList.length === 1 ? '' : 's'}
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
        <div className="flex min-h-0 w-full shrink-0 flex-col border-b border-border/70 md:w-80 md:border-b-0 md:border-r">
          <div className="flex h-12 items-center justify-between border-b border-border/70 px-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                Explorer
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => openCreateFolderDialog(null)}
                aria-label="Create folder"
              >
                <FolderPlus className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => openCreateNoteDialog(null)}
                aria-label="Create note"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          <ScrollArea className="h-56 md:h-auto md:flex-1">
            {isLoadingTree ? (
              <div className="flex h-full items-center justify-center px-4 py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                Loading notes
              </div>
            ) : tree.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-muted/50">
                  <FileText className="size-5 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-medium text-foreground/75">No notes yet</p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground/60">
                  Create a markdown note or folder and it will live in {NOTES_HOME_LABEL}.
                </p>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openCreateNoteDialog(null)}
                  >
                    <Plus className="size-3.5" />
                    New note
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openCreateFolderDialog(null)}
                  >
                    <FolderPlus className="size-3.5" />
                    New folder
                  </Button>
                </div>
              </div>
            ) : (
              <NotesTree
                tree={tree}
                selectedNotePath={selectedNotePath}
                expandedFolderPaths={expandedFolderPaths}
                renamingNotePath={renamingNotePath}
                renameDraft={renameDraft}
                isRenamingNote={isRenamingNote}
                onSelectNote={handleSelectNote}
                onToggleFolder={handleToggleFolder}
                onStartRenameNote={handleStartRenameNote}
                onRenameDraftChange={setRenameDraft}
                onCommitRenameNote={handleCommitRenameNote}
                onCancelRenameNote={handleCancelRenameNote}
                onCreateNoteInFolder={openCreateNoteDialog}
                onCreateFolderInFolder={openCreateFolderDialog}
                onMoveNote={handleOpenMoveDialog}
                onDeleteNote={setNotePendingDelete}
                onDeleteFolder={setFolderPendingDelete}
              />
            )}
          </ScrollArea>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {selectedNotePath === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium text-foreground/75">Choose a note to start writing</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground/65">
                  Notes autosave as markdown files, stay organized in a nested explorer, and keep the editor in live
                  preview mode.
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
                key={selectedNote.path}
                editorId={selectedNote.path}
                markdown={selectedNote.content}
                onChange={handleEditorChange}
              />
            </Suspense>
          )}
        </div>
      </div>

      <Dialog open={createNoteDialogOpen} onOpenChange={setCreateNoteDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create note</DialogTitle>
            <DialogDescription>
              Create a markdown note anywhere inside {NOTES_HOME_LABEL}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="note-folder">Folder</Label>
              <Select
                value={toFolderValue(createNoteParentPath)}
                onValueChange={(value) => setCreateNoteParentPath(fromFolderValue(value))}
              >
                <SelectTrigger id="note-folder" className="w-full">
                  <SelectValue placeholder="Select folder" />
                </SelectTrigger>
                <SelectContent>
                  {folderOptions.map((folder) => (
                    <SelectItem key={folder.path ?? ROOT_FOLDER_VALUE} value={toFolderValue(folder.path)}>
                      {folder.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="note-name">Filename</Label>
              <Input
                id="note-name"
                value={createNoteNameDraft}
                onChange={(event) => setCreateNoteNameDraft(event.target.value)}
                placeholder="untitled-note.md"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="outline" onClick={() => setCreateNoteDialogOpen(false)} disabled={isCreatingNote}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreateNote()} disabled={isCreateNoteDisabled}>
              {isCreatingNote ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createFolderDialogOpen} onOpenChange={setCreateFolderDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Add a folder to organize notes inside {NOTES_HOME_LABEL}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="folder-parent">Parent folder</Label>
              <Select
                value={toFolderValue(createFolderParentPath)}
                onValueChange={(value) => setCreateFolderParentPath(fromFolderValue(value))}
              >
                <SelectTrigger id="folder-parent" className="w-full">
                  <SelectValue placeholder="Select parent folder" />
                </SelectTrigger>
                <SelectContent>
                  {folderOptions.map((folder) => (
                    <SelectItem key={folder.path ?? ROOT_FOLDER_VALUE} value={toFolderValue(folder.path)}>
                      {folder.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="folder-name">Folder name</Label>
              <Input
                id="folder-name"
                value={createFolderNameDraft}
                onChange={(event) => setCreateFolderNameDraft(event.target.value)}
                placeholder="new-folder"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="outline" onClick={() => setCreateFolderDialogOpen(false)} disabled={isCreatingFolder}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreateFolder()} disabled={isCreateFolderDisabled}>
              {isCreatingFolder ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notePendingMove !== null} onOpenChange={(open) => !open && setNotePendingMove(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move note</DialogTitle>
            <DialogDescription>
              {notePendingMove ? `Move ${notePendingMove.name} to another folder.` : 'Move this note to another folder.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="move-folder">Destination</Label>
            <Select
              value={moveDestinationFolder}
              onValueChange={(value) => setMoveDestinationFolder(value ?? ROOT_FOLDER_VALUE)}
            >
              <SelectTrigger id="move-folder" className="w-full">
                <SelectValue placeholder="Select destination folder" />
              </SelectTrigger>
              <SelectContent>
                {folderOptions.map((folder) => (
                  <SelectItem key={folder.path ?? ROOT_FOLDER_VALUE} value={toFolderValue(folder.path)}>
                    {folder.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="outline" onClick={() => setNotePendingMove(null)} disabled={isMovingNote}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleConfirmMove()} disabled={isMovingNote}>
              {isMovingNote ? <Loader2 className="size-4 animate-spin" /> : null}
              Move note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notePendingDelete !== null} onOpenChange={(open) => !open && setNotePendingDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete note?</DialogTitle>
            <DialogDescription>
              {notePendingDelete
                ? `This removes ${notePendingDelete.path} from ${NOTES_HOME_LABEL}.`
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
              onClick={() => void handleConfirmDeleteNote()}
              disabled={isDeletingNote}
            >
              {isDeletingNote ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={folderPendingDelete !== null} onOpenChange={(open) => !open && setFolderPendingDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete folder?</DialogTitle>
            <DialogDescription>
              {folderPendingDelete
                ? `This removes ${folderPendingDelete.path} and all nested notes from ${NOTES_HOME_LABEL}.`
                : 'This folder will be removed.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="items-center sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setFolderPendingDelete(null)}
              disabled={isDeletingFolder}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmDeleteFolder()}
              disabled={isDeletingFolder}
            >
              {isDeletingFolder ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete folder
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

function normalizeNoteDocument(note: NoteDocument): NoteDocument {
  return {
    ...note,
    content: normalizeNoteMarkdown(note.content),
  }
}

function normalizeNoteMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (normalized.trim().length === 0) {
    return ''
  }

  return `${normalized.replace(/\n+$/, '')}\n`
}

function flattenNoteTree(tree: NoteTreeNode[]): NoteSummary[] {
  const notes: NoteSummary[] = []

  for (const node of tree) {
    if (node.kind === 'file') {
      notes.push(node)
      continue
    }

    notes.push(...flattenNoteTree(node.children))
  }

  return notes
}

function flattenFolderTree(tree: NoteTreeNode[]): NoteFolder[] {
  const folders: NoteFolder[] = []

  for (const node of tree) {
    if (node.kind === 'folder') {
      folders.push(node)
      folders.push(...flattenFolderTree(node.children))
    }
  }

  return folders
}

function replaceNoteInTree(tree: NoteTreeNode[], nextNote: NoteSummary): NoteTreeNode[] {
  let changed = false
  const nextTree = tree.map((node) => {
    if (node.kind === 'folder') {
      const nextChildren = replaceNoteInTree(node.children, nextNote)
      if (nextChildren !== node.children) {
        changed = true
        return { ...node, children: nextChildren }
      }

      return node
    }

    if (node.path === nextNote.path) {
      changed = true
      return { ...nextNote, kind: 'file' as const }
    }

    return node
  })

  return changed ? nextTree : tree
}

function createUntitledNoteName(notes: NoteSummary[], folderPath: string | null): string {
  const names = new Set(
    notes
      .filter((note) => parentFolderPathOf(note.path) === folderPath)
      .map((note) => note.name.toLowerCase()),
  )

  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const name = index === 1 ? 'untitled-note.md' : `untitled-note-${index}.md`
    if (!names.has(name.toLowerCase())) {
      return name
    }
  }

  return `untitled-note-${Date.now()}.md`
}

function findNextSelectedNotePath(currentPath: string | null, notes: NoteSummary[]): string | null {
  if (currentPath && notes.some((note) => note.path === currentPath)) {
    return currentPath
  }

  return notes[0]?.path ?? null
}

function mergeExpandedFolderPaths(
  currentPaths: string[],
  tree: NoteTreeNode[],
  selectedNotePath: string | null,
  revealPaths: string[],
  expandAllOnFirstLoad: boolean,
): string[] {
  const folderPaths = new Set(flattenFolderTree(tree).map((folder) => folder.path))
  const next = expandAllOnFirstLoad ? new Set(folderPaths) : new Set(currentPaths.filter((path) => folderPaths.has(path)))

  for (const path of selectedNotePath ? ancestorFolderPaths(selectedNotePath) : []) {
    if (folderPaths.has(path)) {
      next.add(path)
    }
  }

  for (const path of revealPaths) {
    for (const ancestorPath of ancestorFolderPaths(path)) {
      if (folderPaths.has(ancestorPath)) {
        next.add(ancestorPath)
      }
    }

    if (folderPaths.has(path)) {
      next.add(path)
    }
  }

  return [...next]
}

function ancestorFolderPaths(path: string): string[] {
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return []
  }

  const segments = trimmedPath.split('/')
  const ancestors: string[] = []

  for (let index = 0; index < segments.length - 1; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join('/'))
  }

  return ancestors
}

function ensureMarkdownExtension(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    return ''
  }

  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`
}

function joinNotePath(folderPath: string | null, name: string): string {
  const normalizedName = ensureMarkdownExtension(name)
  return folderPath ? `${folderPath}/${normalizedName}` : normalizedName
}

function joinFolderPath(folderPath: string | null, name: string): string {
  const normalizedName = name.trim()
  return folderPath ? `${folderPath}/${normalizedName}` : normalizedName
}

function parentFolderPathOf(path: string | null): string | null {
  if (!path || !path.includes('/')) {
    return null
  }

  return path.slice(0, path.lastIndexOf('/'))
}

function pathIsInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`)
}

function toFolderValue(path: string | null): string {
  return path ?? ROOT_FOLDER_VALUE
}

function fromFolderValue(value: string | null): string | null {
  return value === ROOT_FOLDER_VALUE ? null : value
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
