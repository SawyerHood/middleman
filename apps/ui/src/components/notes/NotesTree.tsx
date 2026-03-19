import { useMemo, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { NoteFolder, NoteSummary, NoteTreeNode } from "@middleman/protocol";

interface NotesTreeProps {
  tree: NoteTreeNode[];
  selectedNotePath: string | null;
  expandedFolderPaths: string[];
  renamingNotePath: string | null;
  renameDraft: string;
  isRenamingNote: boolean;
  onSelectNote: (path: string) => void;
  onToggleFolder: (path: string) => void;
  onStartRenameNote: (note: NoteSummary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRenameNote: () => Promise<void> | void;
  onCancelRenameNote: () => void;
  onCreateNoteInFolder: (folderPath: string | null) => void;
  onCreateFolderInFolder: (folderPath: string | null) => void;
  onMoveNote: (note: NoteSummary) => void;
  onDeleteNote: (note: NoteSummary) => void;
  onDeleteFolder: (folder: NoteFolder) => void;
}

export function NotesTree({
  tree,
  selectedNotePath,
  expandedFolderPaths,
  renamingNotePath,
  renameDraft,
  isRenamingNote,
  onSelectNote,
  onToggleFolder,
  onStartRenameNote,
  onRenameDraftChange,
  onCommitRenameNote,
  onCancelRenameNote,
  onCreateNoteInFolder,
  onCreateFolderInFolder,
  onMoveNote,
  onDeleteNote,
  onDeleteFolder,
}: NotesTreeProps) {
  const expandedFolderSet = useMemo(() => new Set(expandedFolderPaths), [expandedFolderPaths]);

  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          depth={0}
          expandedFolderSet={expandedFolderSet}
          isRenamingNote={isRenamingNote}
          node={node}
          onCancelRenameNote={onCancelRenameNote}
          onCommitRenameNote={onCommitRenameNote}
          onCreateFolderInFolder={onCreateFolderInFolder}
          onCreateNoteInFolder={onCreateNoteInFolder}
          onDeleteFolder={onDeleteFolder}
          onDeleteNote={onDeleteNote}
          onMoveNote={onMoveNote}
          onRenameDraftChange={onRenameDraftChange}
          onSelectNote={onSelectNote}
          onStartRenameNote={onStartRenameNote}
          onToggleFolder={onToggleFolder}
          renameDraft={renameDraft}
          renamingNotePath={renamingNotePath}
          selectedNotePath={selectedNotePath}
        />
      ))}
    </div>
  );
}

function TreeNodeRow({
  depth,
  expandedFolderSet,
  isRenamingNote,
  node,
  onCancelRenameNote,
  onCommitRenameNote,
  onCreateFolderInFolder,
  onCreateNoteInFolder,
  onDeleteFolder,
  onDeleteNote,
  onMoveNote,
  onRenameDraftChange,
  onSelectNote,
  onStartRenameNote,
  onToggleFolder,
  renameDraft,
  renamingNotePath,
  selectedNotePath,
}: {
  depth: number;
  expandedFolderSet: Set<string>;
  isRenamingNote: boolean;
  node: NoteTreeNode;
  onCancelRenameNote: () => void;
  onCommitRenameNote: () => Promise<void> | void;
  onCreateFolderInFolder: (folderPath: string | null) => void;
  onCreateNoteInFolder: (folderPath: string | null) => void;
  onDeleteFolder: (folder: NoteFolder) => void;
  onDeleteNote: (note: NoteSummary) => void;
  onMoveNote: (note: NoteSummary) => void;
  onRenameDraftChange: (value: string) => void;
  onSelectNote: (path: string) => void;
  onStartRenameNote: (note: NoteSummary) => void;
  onToggleFolder: (path: string) => void;
  renameDraft: string;
  renamingNotePath: string | null;
  selectedNotePath: string | null;
}) {
  const ignoreNextRenameBlurRef = useRef(false);
  const paddingLeft = depth * 14 + 10;

  if (node.kind === "folder") {
    const isExpanded = expandedFolderSet.has(node.path);

    return (
      <>
        <ContextMenu>
          <ContextMenuTrigger className="w-full">
            <button
              type="button"
              className="flex h-8 w-full items-center rounded-md pr-3 text-left text-[13px] text-foreground/80 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{ paddingLeft }}
              onClick={() => onToggleFolder(node.path)}
              title={node.path}
            >
              {isExpanded ? (
                <ChevronDown className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onCreateNoteInFolder(node.path)}>
              New note
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateFolderInFolder(node.path)}>
              New folder
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => onDeleteFolder(node)}>
              Delete folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isExpanded
          ? node.children.map((child) => (
              <TreeNodeRow
                key={child.path}
                depth={depth + 1}
                expandedFolderSet={expandedFolderSet}
                isRenamingNote={isRenamingNote}
                node={child}
                onCancelRenameNote={onCancelRenameNote}
                onCommitRenameNote={onCommitRenameNote}
                onCreateFolderInFolder={onCreateFolderInFolder}
                onCreateNoteInFolder={onCreateNoteInFolder}
                onDeleteFolder={onDeleteFolder}
                onDeleteNote={onDeleteNote}
                onMoveNote={onMoveNote}
                onRenameDraftChange={onRenameDraftChange}
                onSelectNote={onSelectNote}
                onStartRenameNote={onStartRenameNote}
                onToggleFolder={onToggleFolder}
                renameDraft={renameDraft}
                renamingNotePath={renamingNotePath}
                selectedNotePath={selectedNotePath}
              />
            ))
          : null}
      </>
    );
  }

  const isSelected = node.path === selectedNotePath;
  const isRenaming = node.path === renamingNotePath;

  return (
    <ContextMenu>
      <ContextMenuTrigger className="w-full">
        <div
          className={cn(
            "flex min-h-8 w-full items-center rounded-md pr-3 transition-colors",
            isSelected ? "bg-muted/55 text-foreground" : "hover:bg-muted/25",
          )}
          style={{ paddingLeft }}
        >
          <span className="mr-1 inline-flex size-3.5 shrink-0" aria-hidden="true" />
          {isRenaming ? (
            <Input
              autoFocus
              className="h-7 border-border/70 bg-background/80 text-[13px]"
              disabled={isRenamingNote}
              onBlur={() => {
                if (ignoreNextRenameBlurRef.current) {
                  ignoreNextRenameBlurRef.current = false;
                  return;
                }

                void onCommitRenameNote();
              }}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void onCommitRenameNote();
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  ignoreNextRenameBlurRef.current = true;
                  onCancelRenameNote();
                }
              }}
              value={renameDraft}
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded-md py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => onSelectNote(node.path)}
              onDoubleClick={() => onStartRenameNote(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isSelected) {
                  event.preventDefault();
                  onStartRenameNote(node);
                }
              }}
              title={node.path}
            >
              <span className="block truncate">{node.name}</span>
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onStartRenameNote(node)}>Rename</ContextMenuItem>
        <ContextMenuItem onClick={() => onMoveNote(node)}>Move to…</ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => onDeleteNote(node)}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
