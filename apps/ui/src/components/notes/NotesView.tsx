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
} from "react";
import {
  FileText,
  FolderPlus,
  Loader2,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { ViewHeader } from "@/components/ViewHeader";
import { NoteSearchPalette } from "@/components/notes/NoteSearchPalette";
import { NotesTree } from "@/components/notes/NotesTree";
import {
  readStoredLastOpenNotePath,
  writeStoredLastOpenNotePath,
} from "@/components/notes/notes-storage";
import {
  createFolder as createFolderRequest,
  deleteFolder as deleteFolderRequest,
  deleteNote as deleteNoteRequest,
  fetchNote,
  fetchNoteTree,
  renameNote as renameNoteRequest,
  saveNote,
} from "@/components/notes/notes-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { NoteDocument, NoteFolder, NoteSummary, NoteTreeNode } from "@middleman/protocol";

type SaveStatus = "saved" | "saving" | "unsaved" | "error";

const DEFAULT_NEW_NOTE_CONTENT = "# Untitled note\n";
const NOTES_HOME_LABEL = "~/.middleman/notes";
const ROOT_FOLDER_VALUE = "__root__";
const NOTES_DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
const NOTES_EXPLORER_COLLAPSED_STORAGE_KEY = "middleman:notes:explorer-collapsed";
const NOTES_EXPANDED_FOLDERS_STORAGE_KEY = "middleman:notes:expanded-folders";
const NOTE_SEARCH_SHORTCUT_LABEL = "Cmd/Ctrl+P";
const NotesMarkdownEditor = lazy(async () => {
  const module = await import("@/components/notes/NotesMarkdownEditor");
  return { default: module.NotesMarkdownEditor };
});

interface NotesViewProps {
  wsUrl: string;
  onBack: () => void;
  statusBanner?: ReactNode;
  onToggleMobileSidebar: () => void;
}

export function NotesView({ wsUrl, onBack, statusBanner, onToggleMobileSidebar }: NotesViewProps) {
  const isDesktopExplorerLayout = useDesktopExplorerLayout();
  const [storedExpandedFolders] = useState(readStoredExpandedFolderPaths);
  const [tree, setTree] = useState<NoteTreeNode[]>([]);
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteDocument | null>(null);
  const [editorMarkdown, setEditorMarkdown] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [isLoadingTree, setIsLoadingTree] = useState(true);
  const [isLoadingNote, setIsLoadingNote] = useState(false);
  const [expandedFolderPaths, setExpandedFolderPaths] = useState<string[]>(
    storedExpandedFolders.paths,
  );
  const [activeFolderPath, setActiveFolderPath] = useState<string | null>(null);
  const [isDesktopExplorerCollapsed, setIsDesktopExplorerCollapsed] = useState(
    readStoredExplorerCollapsed,
  );
  const [isMobileExplorerOpen, setIsMobileExplorerOpen] = useState(false);
  const [isSearchPaletteOpen, setIsSearchPaletteOpen] = useState(false);
  const [renamingNotePath, setRenamingNotePath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isRenamingNote, setIsRenamingNote] = useState(false);
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [pendingInlineCreateNotePath, setPendingInlineCreateNotePath] = useState<string | null>(
    null,
  );
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [createFolderParentPath, setCreateFolderParentPath] = useState<string | null>(null);
  const [createFolderNameDraft, setCreateFolderNameDraft] = useState("new-folder");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [notePendingMove, setNotePendingMove] = useState<NoteSummary | null>(null);
  const [moveDestinationFolder, setMoveDestinationFolder] = useState(ROOT_FOLDER_VALUE);
  const [isMovingNote, setIsMovingNote] = useState(false);
  const [notePendingDelete, setNotePendingDelete] = useState<NoteSummary | null>(null);
  const [folderPendingDelete, setFolderPendingDelete] = useState<NoteFolder | null>(null);
  const [isDeletingNote, setIsDeletingNote] = useState(false);
  const [isDeletingFolder, setIsDeletingFolder] = useState(false);

  const lastSavedContentRef = useRef("");
  const autoSaveTimeoutRef = useRef<number | null>(null);
  const editorMarkdownRef = useRef(editorMarkdown);
  const saveSequenceRef = useRef(0);
  const inFlightSaveRef = useRef<Promise<NoteDocument> | null>(null);
  const selectedNotePathRef = useRef<string | null>(selectedNotePath);
  const selectedNoteRef = useRef<NoteDocument | null>(selectedNote);
  const expandedFolderPathsRef = useRef<string[]>(expandedFolderPaths);
  const wsUrlRef = useRef(wsUrl);
  const loadedNotePathRef = useRef<string | null>(null);
  const renameSubmittingRef = useRef(false);
  const hasInitializedExpansionRef = useRef(false);
  const hasStoredExpandedFolderPathsRef = useRef(storedExpandedFolders.hasStoredValue);
  const lastOpenNotePathRef = useRef(readStoredLastOpenNotePath());
  const hasResolvedInitialLastOpenNoteRef = useRef(false);

  const noteList = useMemo(() => flattenNoteTree(tree), [tree]);
  const folderList = useMemo(() => flattenFolderTree(tree), [tree]);
  const folderPathSet = useMemo(
    () => new Set(folderList.map((folder) => folder.path)),
    [folderList],
  );
  const noteIndex = useMemo(() => new Map(noteList.map((note) => [note.path, note])), [noteList]);

  editorMarkdownRef.current = editorMarkdown;
  selectedNotePathRef.current = selectedNotePath;
  selectedNoteRef.current = selectedNote;
  expandedFolderPathsRef.current = expandedFolderPaths;
  wsUrlRef.current = wsUrl;

  const selectedNoteSummary = selectedNotePath ? (noteIndex.get(selectedNotePath) ?? null) : null;

  const folderOptions = useMemo(
    () => [
      { path: null, label: NOTES_HOME_LABEL },
      ...folderList.map((folder) => ({ path: folder.path, label: folder.path })),
    ],
    [folderList],
  );

  const clearAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current !== null) {
      window.clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = null;
    }
  }, []);

  const applyLoadedNote = useCallback((note: NoteDocument | null) => {
    if (!note) {
      loadedNotePathRef.current = null;
      selectedNoteRef.current = null;
      setSelectedNote(null);
      setEditorMarkdown("");
      editorMarkdownRef.current = "";
      lastSavedContentRef.current = "";
      setSaveStatus("saved");
      setSaveError(null);
      return;
    }

    const normalizedNote = normalizeNoteDocument(note);
    loadedNotePathRef.current = normalizedNote.path;
    selectedNoteRef.current = normalizedNote;
    setSelectedNote(normalizedNote);
    setEditorMarkdown(normalizedNote.content);
    editorMarkdownRef.current = normalizedNote.content;
    lastSavedContentRef.current = normalizedNote.content;
    setSaveStatus("saved");
    setSaveError(null);
  }, []);

  const selectLoadedNote = useCallback((note: NoteDocument) => {
    const normalizedNote = normalizeNoteDocument(note);
    selectedNotePathRef.current = normalizedNote.path;
    loadedNotePathRef.current = normalizedNote.path;
    selectedNoteRef.current = normalizedNote;
    setSelectedNotePath(normalizedNote.path);
    setSelectedNote(normalizedNote);
    setEditorMarkdown(normalizedNote.content);
    editorMarkdownRef.current = normalizedNote.content;
    lastSavedContentRef.current = normalizedNote.content;
    setSaveStatus("saved");
    setSaveError(null);
  }, []);

  const loadTree = useCallback(
    async (
      signal?: AbortSignal,
      options?: {
        preferredSelectedPath?: string | null;
        revealPaths?: string[];
      },
    ) => {
      const nextTree = await fetchNoteTree(wsUrl, signal);
      const nextNotes = flattenNoteTree(nextTree);
      const storedLastOpenNotePath =
        !hasResolvedInitialLastOpenNoteRef.current && options?.preferredSelectedPath === undefined
          ? lastOpenNotePathRef.current
          : null;
      const nextSelectedPath = findNextSelectedNotePath(
        options?.preferredSelectedPath ?? storedLastOpenNotePath ?? selectedNotePathRef.current,
        nextNotes,
        storedLastOpenNotePath !== null,
      );
      const shouldExpandAllOnFirstLoad =
        !hasInitializedExpansionRef.current && !hasStoredExpandedFolderPathsRef.current;
      const shouldRevealSelectedNotePath =
        hasInitializedExpansionRef.current || !hasStoredExpandedFolderPathsRef.current;
      const nextExpandedFolders = mergeExpandedFolderPaths(
        expandedFolderPathsRef.current,
        nextTree,
        nextSelectedPath,
        options?.revealPaths ?? [],
        shouldExpandAllOnFirstLoad,
        shouldRevealSelectedNotePath,
      );

      if (!hasResolvedInitialLastOpenNoteRef.current) {
        writeStoredLastOpenNotePath(nextSelectedPath);
      }

      hasInitializedExpansionRef.current = true;
      hasResolvedInitialLastOpenNoteRef.current = true;
      startTransition(() => {
        setTree(nextTree);
        setSelectedNotePath(nextSelectedPath);
        setExpandedFolderPaths(nextExpandedFolders);
      });
    },
    [wsUrl],
  );

  const persistNoteSnapshot = useCallback((path: string, content: string) => {
    const normalizedContent = normalizeNoteMarkdown(content);
    if (normalizedContent === lastSavedContentRef.current) {
      return;
    }

    void saveNote(wsUrlRef.current, path, normalizedContent).catch(() => undefined);
  }, []);

  const saveSelectedNote = useCallback(
    async (path: string, content: string): Promise<NoteDocument> => {
      const normalizedContent = normalizeNoteMarkdown(content);
      const requestSequence = ++saveSequenceRef.current;

      setSaveStatus("saving");
      setSaveError(null);

      const request = saveNote(wsUrl, path, normalizedContent).then(normalizeNoteDocument);
      inFlightSaveRef.current = request;

      try {
        const savedNote = await request;

        if (requestSequence === saveSequenceRef.current) {
          lastSavedContentRef.current = savedNote.content;
          if (selectedNoteRef.current?.path === savedNote.path) {
            selectedNoteRef.current = savedNote;
            loadedNotePathRef.current = savedNote.path;
            setSelectedNote(savedNote);
          }

          setTree((current) => replaceNoteInTree(current, savedNote));
          setSaveStatus(editorMarkdownRef.current === savedNote.content ? "saved" : "unsaved");
        }

        return savedNote;
      } catch (error) {
        if (requestSequence === saveSequenceRef.current) {
          setSaveStatus("error");
          setSaveError(toErrorMessage(error));
        }

        throw error;
      } finally {
        if (inFlightSaveRef.current === request) {
          inFlightSaveRef.current = null;
        }
      }
    },
    [wsUrl],
  );

  const flushPendingSave = useCallback(async (): Promise<boolean> => {
    clearAutoSave();

    if (!selectedNotePath) {
      return true;
    }

    if (editorMarkdownRef.current === lastSavedContentRef.current) {
      if (inFlightSaveRef.current) {
        await inFlightSaveRef.current.catch(() => undefined);
      }

      return true;
    }

    try {
      await saveSelectedNote(selectedNotePath, editorMarkdownRef.current);
      return true;
    } catch {
      return false;
    }
  }, [clearAutoSave, saveSelectedNote, selectedNotePath]);

  useEffect(() => {
    const abortController = new AbortController();

    setIsLoadingTree(true);
    setNotesError(null);

    void loadTree(abortController.signal)
      .catch((error) => {
        if (isAbortError(error)) {
          return;
        }

        setNotesError(toErrorMessage(error));
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoadingTree(false);
        }
      });

    return () => {
      abortController.abort();
      clearAutoSave();
    };
  }, [clearAutoSave, loadTree, wsUrl]);

  useEffect(() => {
    return () => {
      clearAutoSave();

      const path = selectedNotePathRef.current;
      if (!path) {
        return;
      }

      persistNoteSnapshot(path, editorMarkdownRef.current);
    };
  }, [clearAutoSave, persistNoteSnapshot]);

  useEffect(() => {
    if (!selectedNotePath) {
      applyLoadedNote(null);
      return;
    }

    if (
      selectedNoteRef.current?.path === selectedNotePath &&
      loadedNotePathRef.current === selectedNotePath
    ) {
      setIsLoadingNote(false);
      return;
    }

    const abortController = new AbortController();

    setIsLoadingNote(true);
    applyLoadedNote(null);

    void fetchNote(wsUrl, selectedNotePath, abortController.signal)
      .then((note) => {
        setNotesError(null);
        setTree((current) => replaceNoteInTree(current, normalizeNoteDocument(note)));
        applyLoadedNote(note);
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return;
        }

        applyLoadedNote(null);
        setNotesError(toErrorMessage(error));
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoadingNote(false);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [applyLoadedNote, selectedNotePath, wsUrl]);

  useEffect(() => {
    clearAutoSave();

    if (!selectedNote || isLoadingNote) {
      return;
    }

    if (editorMarkdown === lastSavedContentRef.current) {
      if (saveStatus !== "saving") {
        setSaveStatus("saved");
      }

      return;
    }

    setSaveStatus((current) => (current === "saving" ? current : "unsaved"));

    autoSaveTimeoutRef.current = window.setTimeout(() => {
      autoSaveTimeoutRef.current = null;
      void saveSelectedNote(selectedNote.path, editorMarkdownRef.current);
    }, 1000);

    return clearAutoSave;
  }, [clearAutoSave, editorMarkdown, isLoadingNote, saveSelectedNote, saveStatus, selectedNote]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!selectedNotePathRef.current) {
        return;
      }

      if (editorMarkdownRef.current === lastSavedContentRef.current) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    setActiveFolderPath((current) => {
      if (!current) {
        return current;
      }

      return folderPathSet.has(current) ? current : null;
    });
  }, [folderPathSet]);

  useEffect(() => {
    setActiveFolderPath(parentFolderPathOf(selectedNotePath));
  }, [selectedNotePath]);

  useEffect(() => {
    writeStoredExplorerCollapsed(isDesktopExplorerCollapsed);
  }, [isDesktopExplorerCollapsed]);

  useEffect(() => {
    if (!hasInitializedExpansionRef.current) {
      return;
    }

    if (!hasStoredExpandedFolderPathsRef.current && folderList.length === 0) {
      return;
    }

    writeStoredExpandedFolderPaths(expandedFolderPaths);
    hasStoredExpandedFolderPathsRef.current = true;
  }, [expandedFolderPaths, folderList.length]);

  useEffect(() => {
    if (isDesktopExplorerLayout) {
      return;
    }

    setIsMobileExplorerOpen(false);
  }, [isDesktopExplorerLayout]);

  useEffect(() => {
    if (!isMobileExplorerOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileExplorerOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isMobileExplorerOpen]);

  useEffect(() => {
    if (!hasResolvedInitialLastOpenNoteRef.current) {
      return;
    }

    writeStoredLastOpenNotePath(selectedNotePath);
  }, [selectedNotePath]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key.toLowerCase() !== "p" || event.altKey || event.shiftKey) {
        return;
      }

      if (!event.metaKey && !event.ctrlKey) {
        return;
      }

      event.preventDefault();
      setIsSearchPaletteOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);

  const handleEditorChange = useCallback((nextMarkdown: string) => {
    setEditorMarkdown(normalizeNoteMarkdown(nextMarkdown));
  }, []);

  const handleSelectNote = useCallback(
    (path: string) => {
      if (path === selectedNotePath) {
        if (!isDesktopExplorerLayout) {
          setIsMobileExplorerOpen(false);
        }
        return;
      }

      void flushPendingSave().then((canSwitch) => {
        if (canSwitch) {
          setSelectedNotePath(path);
          setExpandedFolderPaths((current) =>
            mergeExpandedFolderPaths(current, tree, path, [], false),
          );
          setActiveFolderPath(parentFolderPathOf(path));
          if (!isDesktopExplorerLayout) {
            setIsMobileExplorerOpen(false);
          }
        }
      });
    },
    [flushPendingSave, isDesktopExplorerLayout, selectedNotePath, tree],
  );

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolderPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
        setActiveFolderPath((currentActive) => (currentActive === path ? null : currentActive));
      } else {
        next.add(path);
        setActiveFolderPath(path);
      }

      return [...next];
    });
  }, []);

  const handleSetExplorerCollapsed = useCallback(
    (nextCollapsed: boolean) => {
      if (isDesktopExplorerLayout) {
        setIsDesktopExplorerCollapsed(nextCollapsed);
        return;
      }

      setIsMobileExplorerOpen(!nextCollapsed);
    },
    [isDesktopExplorerLayout],
  );

  const handleToggleMobileExplorer = useCallback(() => {
    if (isDesktopExplorerLayout) {
      return;
    }

    setIsMobileExplorerOpen((current) => !current);
  }, [isDesktopExplorerLayout]);

  const handleSetSearchPaletteOpen = useCallback((open: boolean) => {
    setIsSearchPaletteOpen(open);
  }, []);

  const openSearchPalette = useCallback(() => {
    setIsSearchPaletteOpen(true);
  }, []);

  const openCreateFolderDialog = useCallback((folderPath: string | null) => {
    setCreateFolderParentPath(folderPath);
    setCreateFolderNameDraft("new-folder");
    setCreateFolderDialogOpen(true);
  }, []);

  const handleCreateNote = useCallback(
    async (folderPath?: string | null) => {
      const nextParentPath = resolveCreateNoteParentPath(
        folderPath,
        activeFolderPath,
        expandedFolderPaths,
        folderPathSet,
      );
      const notePath = joinNotePath(
        nextParentPath,
        createUntitledNoteName(noteList, nextParentPath),
      );

      setIsCreatingNote(true);
      setNotesError(null);

      try {
        const canCreate = await flushPendingSave();
        if (!canCreate) {
          return;
        }

        const createdNote = await saveNote(wsUrl, notePath, DEFAULT_NEW_NOTE_CONTENT);
        const createdFolderPath = parentFolderPathOf(createdNote.path);
        setPendingInlineCreateNotePath(createdNote.path);
        setRenamingNotePath(createdNote.path);
        setRenameDraft(createdNote.name);
        setActiveFolderPath(createdFolderPath);
        selectLoadedNote(createdNote);
        await loadTree(undefined, {
          preferredSelectedPath: createdNote.path,
          revealPaths: [createdFolderPath ?? ""],
        });
        if (!isDesktopExplorerLayout) {
          setIsMobileExplorerOpen(false);
        }
      } catch (error) {
        setNotesError(toErrorMessage(error));
      } finally {
        setIsCreatingNote(false);
      }
    },
    [
      activeFolderPath,
      expandedFolderPaths,
      flushPendingSave,
      folderPathSet,
      isDesktopExplorerLayout,
      loadTree,
      noteList,
      selectLoadedNote,
      wsUrl,
    ],
  );

  const handleCreateFolder = useCallback(async () => {
    const folderPath = joinFolderPath(createFolderParentPath, createFolderNameDraft);

    setIsCreatingFolder(true);
    setNotesError(null);

    try {
      const createdFolder = await createFolderRequest(wsUrl, folderPath);
      await loadTree(undefined, {
        revealPaths: [createdFolder.path],
      });
      setCreateFolderDialogOpen(false);
    } catch (error) {
      setNotesError(toErrorMessage(error));
    } finally {
      setIsCreatingFolder(false);
    }
  }, [createFolderNameDraft, createFolderParentPath, loadTree, wsUrl]);

  const handleStartRenameNote = useCallback((note: NoteSummary) => {
    setRenamingNotePath(note.path);
    setRenameDraft(note.name);
  }, []);

  const clearRenameState = useCallback(() => {
    setRenamingNotePath(null);
    setRenameDraft("");
  }, []);

  const handleCancelRenameNote = useCallback(() => {
    const notePath = renamingNotePath;
    const shouldDeletePendingNote = notePath !== null && notePath === pendingInlineCreateNotePath;

    clearRenameState();
    setPendingInlineCreateNotePath((current) => (current === notePath ? null : current));

    if (!shouldDeletePendingNote || !notePath) {
      return;
    }

    setNotesError(null);

    void deleteNoteRequest(wsUrl, notePath)
      .then(async () => {
        const wasSelected = selectedNotePathRef.current === notePath;

        if (wasSelected) {
          loadedNotePathRef.current = null;
          selectedNoteRef.current = null;
        }

        await loadTree(undefined, {
          preferredSelectedPath: wasSelected ? null : selectedNotePathRef.current,
          revealPaths: [parentFolderPathOf(notePath) ?? ""],
        });

        if (wasSelected) {
          applyLoadedNote(null);
        }
      })
      .catch((error) => {
        setNotesError(toErrorMessage(error));
      });
  }, [
    applyLoadedNote,
    clearRenameState,
    loadTree,
    pendingInlineCreateNotePath,
    renamingNotePath,
    wsUrl,
  ]);

  const handleCommitRenameNote = useCallback(async () => {
    if (!renamingNotePath || renameSubmittingRef.current) {
      return;
    }

    const note = noteIndex.get(renamingNotePath);
    if (!note) {
      handleCancelRenameNote();
      return;
    }

    if (renameDraft.trim().length === 0) {
      handleCancelRenameNote();
      return;
    }

    const nextPath = joinNotePath(parentFolderPathOf(note.path), renameDraft);
    if (nextPath === note.path) {
      clearRenameState();
      setPendingInlineCreateNotePath((current) => (current === note.path ? null : current));
      return;
    }

    renameSubmittingRef.current = true;
    setIsRenamingNote(true);
    setNotesError(null);

    try {
      const canRename =
        renamingNotePath === selectedNotePathRef.current ? await flushPendingSave() : true;
      if (!canRename) {
        return;
      }

      const renamedNote = await renameNoteRequest(wsUrl, note.path, nextPath);
      const preferredSelectedPath =
        selectedNotePathRef.current === note.path ? renamedNote.path : selectedNotePathRef.current;

      if (selectedNotePathRef.current === note.path) {
        selectLoadedNote(renamedNote);
      }

      await loadTree(undefined, {
        preferredSelectedPath,
        revealPaths: [parentFolderPathOf(renamedNote.path) ?? ""],
      });
      clearRenameState();
      setPendingInlineCreateNotePath((current) => (current === note.path ? null : current));
    } catch (error) {
      setNotesError(toErrorMessage(error));
    } finally {
      renameSubmittingRef.current = false;
      setIsRenamingNote(false);
    }
  }, [
    clearRenameState,
    flushPendingSave,
    loadTree,
    noteIndex,
    renameDraft,
    renamingNotePath,
    selectLoadedNote,
    wsUrl,
  ]);

  const handleOpenMoveDialog = useCallback((note: NoteSummary) => {
    setNotePendingMove(note);
    setMoveDestinationFolder(toFolderValue(parentFolderPathOf(note.path)));
  }, []);

  const handleConfirmMove = useCallback(async () => {
    if (!notePendingMove) {
      return;
    }

    const destinationFolderPath = fromFolderValue(moveDestinationFolder);
    const destinationPath = joinNotePath(destinationFolderPath, notePendingMove.name);

    if (destinationPath === notePendingMove.path) {
      setNotePendingMove(null);
      return;
    }

    setIsMovingNote(true);
    setNotesError(null);

    try {
      const canMove =
        notePendingMove.path === selectedNotePathRef.current ? await flushPendingSave() : true;
      if (!canMove) {
        return;
      }

      const movedNote = await renameNoteRequest(wsUrl, notePendingMove.path, destinationPath);
      const preferredSelectedPath =
        selectedNotePathRef.current === notePendingMove.path
          ? movedNote.path
          : selectedNotePathRef.current;

      if (selectedNotePathRef.current === notePendingMove.path) {
        selectLoadedNote(movedNote);
      }

      await loadTree(undefined, {
        preferredSelectedPath,
        revealPaths: [destinationFolderPath ?? ""],
      });
      setNotePendingMove(null);
    } catch (error) {
      setNotesError(toErrorMessage(error));
    } finally {
      setIsMovingNote(false);
    }
  }, [flushPendingSave, loadTree, moveDestinationFolder, notePendingMove, selectLoadedNote, wsUrl]);

  const handleConfirmDeleteNote = useCallback(async () => {
    if (!notePendingDelete) {
      return;
    }

    setIsDeletingNote(true);
    setNotesError(null);

    try {
      await deleteNoteRequest(wsUrl, notePendingDelete.path);

      if (selectedNotePathRef.current === notePendingDelete.path) {
        loadedNotePathRef.current = null;
        selectedNoteRef.current = null;
      }

      await loadTree(undefined, {
        preferredSelectedPath:
          selectedNotePathRef.current === notePendingDelete.path
            ? null
            : selectedNotePathRef.current,
      });
      setNotePendingDelete(null);
      if (selectedNotePathRef.current === notePendingDelete.path) {
        applyLoadedNote(null);
      }
    } catch (error) {
      setNotesError(toErrorMessage(error));
    } finally {
      setIsDeletingNote(false);
    }
  }, [applyLoadedNote, loadTree, notePendingDelete, wsUrl]);

  const handleConfirmDeleteFolder = useCallback(async () => {
    if (!folderPendingDelete) {
      return;
    }

    setIsDeletingFolder(true);
    setNotesError(null);

    try {
      await deleteFolderRequest(wsUrl, folderPendingDelete.path);

      if (
        selectedNotePathRef.current &&
        pathIsInsideFolder(selectedNotePathRef.current, folderPendingDelete.path)
      ) {
        loadedNotePathRef.current = null;
        selectedNoteRef.current = null;
      }

      await loadTree(undefined, {
        preferredSelectedPath:
          selectedNotePathRef.current &&
          pathIsInsideFolder(selectedNotePathRef.current, folderPendingDelete.path)
            ? null
            : selectedNotePathRef.current,
      });
      setFolderPendingDelete(null);
      if (
        selectedNotePathRef.current &&
        pathIsInsideFolder(selectedNotePathRef.current, folderPendingDelete.path)
      ) {
        applyLoadedNote(null);
      }
    } catch (error) {
      setNotesError(toErrorMessage(error));
    } finally {
      setIsDeletingFolder(false);
    }
  }, [applyLoadedNote, folderPendingDelete, loadTree, wsUrl]);

  const headerSubtitle = selectedNoteSummary
    ? `${selectedNoteSummary.path} · ${NOTES_HOME_LABEL}`
    : `Markdown files in ${NOTES_HOME_LABEL}`;

  const isExplorerCollapsed = isDesktopExplorerLayout
    ? isDesktopExplorerCollapsed
    : !isMobileExplorerOpen;
  const showExplorerRail = isDesktopExplorerLayout && isDesktopExplorerCollapsed;
  const showExplorerPanel = isDesktopExplorerLayout
    ? !isDesktopExplorerCollapsed
    : isMobileExplorerOpen;
  const localBannerMessage = notesError ?? (saveStatus === "error" ? saveError : null);
  const isCreateFolderDisabled = createFolderNameDraft.trim().length === 0 || isCreatingFolder;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <ViewHeader
        className="mb-0"
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
            {!isDesktopExplorerLayout ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleToggleMobileExplorer}
                aria-label={isMobileExplorerOpen ? "Close notes explorer" : "Open notes explorer"}
                aria-pressed={isMobileExplorerOpen}
                title={isMobileExplorerOpen ? "Close explorer" : "Open explorer"}
              >
                {isMobileExplorerOpen ? (
                  <PanelLeft className="size-4" />
                ) : (
                  <PanelRight className="size-4" />
                )}
              </Button>
            ) : null}
            {selectedNotePath ? <SaveStatusPill status={saveStatus} /> : null}
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

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {!isDesktopExplorerLayout && isMobileExplorerOpen ? (
          <button
            type="button"
            className="absolute inset-0 z-10 bg-background/72 backdrop-blur-[2px]"
            onClick={() => setIsMobileExplorerOpen(false)}
            aria-label="Close notes explorer"
          />
        ) : null}

        {showExplorerRail ? (
          <div className="hidden h-full shrink-0 overflow-hidden border-r border-border/70 bg-background md:flex md:w-12">
            <div className="flex h-full flex-col items-center gap-1 border-border/70 px-2 py-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={openSearchPalette}
                aria-label="Search notes"
                title={`Search notes (${NOTE_SEARCH_SHORTCUT_LABEL})`}
              >
                <Search className="size-4" />
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                      onClick={() => handleSetExplorerCollapsed(false)}
                      aria-label="Expand explorer"
                      aria-pressed={false}
                    />
                  }
                >
                  <PanelRight className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6}>
                  Show explorer
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        ) : null}

        {showExplorerPanel ? (
          <div
            className={cn(
              "min-h-0 shrink-0 overflow-hidden border-border/70 bg-background",
              isDesktopExplorerLayout
                ? "flex w-full flex-col border-b md:w-80 md:border-b-0 md:border-r"
                : "absolute inset-y-0 left-0 z-20 flex w-[min(22rem,calc(100vw-2rem))] max-w-full flex-col border-r shadow-2xl",
            )}
          >
            <>
              <div className="flex h-11 items-center justify-end border-b border-border/70 px-2">
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={openSearchPalette}
                    aria-label="Search notes"
                    title={`Search notes (${NOTE_SEARCH_SHORTCUT_LABEL})`}
                  >
                    <Search className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openCreateFolderDialog(null)}
                    aria-label="Create folder"
                    title="Create folder"
                  >
                    <FolderPlus className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleCreateNote()}
                    aria-label="Create note"
                    title="Create note"
                    disabled={isCreatingNote}
                  >
                    {isCreatingNote ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "transition-colors",
                      isExplorerCollapsed
                        ? "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                        : "bg-accent text-foreground",
                    )}
                    onClick={() => handleSetExplorerCollapsed(!isExplorerCollapsed)}
                    aria-label={isExplorerCollapsed ? "Expand explorer" : "Collapse explorer"}
                    aria-pressed={!isExplorerCollapsed}
                    title={isExplorerCollapsed ? "Show explorer" : "Hide explorer"}
                  >
                    <PanelRight className="size-3.5" />
                  </Button>
                </div>
              </div>

              <ScrollArea
                className={cn("min-h-0 flex-1", isDesktopExplorerLayout ? "h-56 md:h-auto" : null)}
              >
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
                        onClick={() => void handleCreateNote()}
                        disabled={isCreatingNote}
                      >
                        {isCreatingNote ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Plus className="size-3.5" />
                        )}
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
                    onCreateNoteInFolder={handleCreateNote}
                    onCreateFolderInFolder={openCreateFolderDialog}
                    onMoveNote={handleOpenMoveDialog}
                    onDeleteNote={setNotePendingDelete}
                    onDeleteFolder={setFolderPendingDelete}
                  />
                )}
              </ScrollArea>
            </>
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {selectedNotePath === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium text-foreground/75">
                  Choose a note to start writing
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground/65">
                  Notes autosave as markdown files, stay organized in a nested explorer, and keep
                  the editor in live preview mode.
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
                wsUrl={wsUrl}
                markdown={editorMarkdown}
                onChange={handleEditorChange}
              />
            </Suspense>
          )}
        </div>
      </div>

      <NoteSearchPalette
        notes={noteList}
        open={isSearchPaletteOpen}
        selectedNotePath={selectedNotePath}
        onOpenChange={handleSetSearchPaletteOpen}
        onSelectNote={handleSelectNote}
      />

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
                    <SelectItem
                      key={folder.path ?? ROOT_FOLDER_VALUE}
                      value={toFolderValue(folder.path)}
                    >
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
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateFolderDialogOpen(false)}
              disabled={isCreatingFolder}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateFolder()}
              disabled={isCreateFolderDisabled}
            >
              {isCreatingFolder ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderPlus className="size-4" />
              )}
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={notePendingMove !== null}
        onOpenChange={(open) => !open && setNotePendingMove(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move note</DialogTitle>
            <DialogDescription>
              {notePendingMove
                ? `Move ${notePendingMove.name} to another folder.`
                : "Move this note to another folder."}
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
                  <SelectItem
                    key={folder.path ?? ROOT_FOLDER_VALUE}
                    value={toFolderValue(folder.path)}
                  >
                    {folder.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNotePendingMove(null)}
              disabled={isMovingNote}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleConfirmMove()} disabled={isMovingNote}>
              {isMovingNote ? <Loader2 className="size-4 animate-spin" /> : null}
              Move note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={notePendingDelete !== null}
        onOpenChange={(open) => !open && setNotePendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete note?</DialogTitle>
            <DialogDescription>
              {notePendingDelete
                ? `This removes ${notePendingDelete.path} from ${NOTES_HOME_LABEL}.`
                : "This note will be removed."}
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
              {isDeletingNote ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={folderPendingDelete !== null}
        onOpenChange={(open) => !open && setFolderPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete folder?</DialogTitle>
            <DialogDescription>
              {folderPendingDelete
                ? `This removes ${folderPendingDelete.path} and all nested notes from ${NOTES_HOME_LABEL}.`
                : "This folder will be removed."}
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
              {isDeletingFolder ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveStatusPill({ status }: { status: SaveStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "saved" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        status === "saving" && "bg-sky-500/10 text-sky-600 dark:text-sky-400",
        status === "unsaved" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        status === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {status === "saving" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
      {status === "saved"
        ? "Saved"
        : status === "saving"
          ? "Saving"
          : status === "unsaved"
            ? "Unsaved"
            : "Save failed"}
    </span>
  );
}

function readStoredExplorerCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(NOTES_EXPLORER_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function readStoredExpandedFolderPaths(): {
  paths: string[];
  hasStoredValue: boolean;
} {
  if (typeof window === "undefined") {
    return { paths: [], hasStoredValue: false };
  }

  try {
    const storedPaths = window.localStorage.getItem(NOTES_EXPANDED_FOLDERS_STORAGE_KEY);
    if (storedPaths === null) {
      return { paths: [], hasStoredValue: false };
    }

    const parsed = JSON.parse(storedPaths);
    if (!Array.isArray(parsed)) {
      return { paths: [], hasStoredValue: false };
    }

    const paths = parsed
      .filter((path): path is string => typeof path === "string")
      .map((path) => path.trim())
      .filter((path) => path.length > 0);

    return {
      paths: [...new Set(paths)],
      hasStoredValue: true,
    };
  } catch {
    return { paths: [], hasStoredValue: false };
  }
}

function writeStoredExpandedFolderPaths(paths: string[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(NOTES_EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function writeStoredExplorerCollapsed(isCollapsed: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (isCollapsed) {
      window.localStorage.setItem(NOTES_EXPLORER_COLLAPSED_STORAGE_KEY, "true");
      return;
    }

    window.localStorage.removeItem(NOTES_EXPLORER_COLLAPSED_STORAGE_KEY);
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

function useDesktopExplorerLayout(): boolean {
  const [matches, setMatches] = useState(readDesktopExplorerLayoutMatch);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(NOTES_DESKTOP_MEDIA_QUERY);
    const updateMatches = () => {
      setMatches(mediaQuery.matches);
    };

    updateMatches();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateMatches);
      return () => {
        mediaQuery.removeEventListener("change", updateMatches);
      };
    }

    mediaQuery.addListener(updateMatches);
    return () => {
      mediaQuery.removeListener(updateMatches);
    };
  }, []);

  return matches;
}

function readDesktopExplorerLayoutMatch(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }

  return window.matchMedia(NOTES_DESKTOP_MEDIA_QUERY).matches;
}

function normalizeNoteDocument(note: NoteDocument): NoteDocument {
  return {
    ...note,
    content: normalizeNoteMarkdown(note.content),
  };
}

function normalizeNoteMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return "";
  }

  return `${normalized.replace(/\n+$/, "")}\n`;
}

function flattenNoteTree(tree: NoteTreeNode[]): NoteSummary[] {
  const notes: NoteSummary[] = [];

  for (const node of tree) {
    if (node.kind === "file") {
      notes.push(node);
      continue;
    }

    notes.push(...flattenNoteTree(node.children));
  }

  return notes;
}

function flattenFolderTree(tree: NoteTreeNode[]): NoteFolder[] {
  const folders: NoteFolder[] = [];

  for (const node of tree) {
    if (node.kind === "folder") {
      folders.push(node);
      folders.push(...flattenFolderTree(node.children));
    }
  }

  return folders;
}

function replaceNoteInTree(tree: NoteTreeNode[], nextNote: NoteSummary): NoteTreeNode[] {
  let changed = false;
  const nextTree = tree.map((node) => {
    if (node.kind === "folder") {
      const nextChildren = replaceNoteInTree(node.children, nextNote);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }

      return node;
    }

    if (node.path === nextNote.path) {
      changed = true;
      return { ...nextNote, kind: "file" as const };
    }

    return node;
  });

  return changed ? nextTree : tree;
}

function createUntitledNoteName(notes: NoteSummary[], folderPath: string | null): string {
  const names = new Set(
    notes
      .filter((note) => parentFolderPathOf(note.path) === folderPath)
      .map((note) => note.name.toLowerCase()),
  );

  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const name = index === 1 ? "Untitled.md" : `Untitled ${index}.md`;
    if (!names.has(name.toLowerCase())) {
      return name;
    }
  }

  return `Untitled ${Date.now()}.md`;
}

function findNextSelectedNotePath(
  currentPath: string | null,
  notes: NoteSummary[],
  preserveEmptySelectionWhenMissing = false,
): string | null {
  if (currentPath && notes.some((note) => note.path === currentPath)) {
    return currentPath;
  }

  if (currentPath && preserveEmptySelectionWhenMissing) {
    return null;
  }

  return notes[0]?.path ?? null;
}

function mergeExpandedFolderPaths(
  currentPaths: string[],
  tree: NoteTreeNode[],
  selectedNotePath: string | null,
  revealPaths: string[],
  expandAllOnFirstLoad: boolean,
  revealSelectedNotePath = true,
): string[] {
  const folderPaths = new Set(flattenFolderTree(tree).map((folder) => folder.path));
  const next = expandAllOnFirstLoad
    ? new Set(folderPaths)
    : new Set(currentPaths.filter((path) => folderPaths.has(path)));

  if (revealSelectedNotePath) {
    for (const path of selectedNotePath ? ancestorFolderPaths(selectedNotePath) : []) {
      if (folderPaths.has(path)) {
        next.add(path);
      }
    }
  }

  for (const path of revealPaths) {
    for (const ancestorPath of ancestorFolderPaths(path)) {
      if (folderPaths.has(ancestorPath)) {
        next.add(ancestorPath);
      }
    }

    if (folderPaths.has(path)) {
      next.add(path);
    }
  }

  return [...next];
}

function ancestorFolderPaths(path: string): string[] {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return [];
  }

  const segments = trimmedPath.split("/");
  const ancestors: string[] = [];

  for (let index = 0; index < segments.length - 1; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join("/"));
  }

  return ancestors;
}

function ensureMarkdownExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function joinNotePath(folderPath: string | null, name: string): string {
  const normalizedName = ensureMarkdownExtension(name);
  return folderPath ? `${folderPath}/${normalizedName}` : normalizedName;
}

function joinFolderPath(folderPath: string | null, name: string): string {
  const normalizedName = name.trim();
  return folderPath ? `${folderPath}/${normalizedName}` : normalizedName;
}

function parentFolderPathOf(path: string | null): string | null {
  if (!path || !path.includes("/")) {
    return null;
  }

  return path.slice(0, path.lastIndexOf("/"));
}

function resolveCreateNoteParentPath(
  folderPath: string | null | undefined,
  activeFolderPath: string | null,
  expandedFolderPaths: string[],
  folderPathSet: Set<string>,
): string | null {
  if (folderPath !== undefined) {
    return folderPath;
  }

  const expandedFolderSet = new Set(expandedFolderPaths);
  if (
    activeFolderPath &&
    folderPathSet.has(activeFolderPath) &&
    expandedFolderSet.has(activeFolderPath) &&
    ancestorFolderPaths(activeFolderPath).every((ancestorPath) =>
      expandedFolderSet.has(ancestorPath),
    )
  ) {
    return activeFolderPath;
  }

  return null;
}

function pathIsInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function toFolderValue(path: string | null): string {
  return path ?? ROOT_FOLDER_VALUE;
}

function fromFolderValue(value: string | null): string | null {
  return value === ROOT_FOLDER_VALUE ? null : value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
