import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  resolveDialogInitialFocus,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { NoteSummary } from '@middleman/protocol'

const MAX_RESULTS = 50
const PATH_BOUNDARY_PATTERN = /[/._\-\s]/

interface NoteSearchPaletteProps {
  notes: NoteSummary[]
  open: boolean
  selectedNotePath: string | null
  onOpenChange: (open: boolean) => void
  onSelectNote: (path: string) => void
}

interface NoteSearchResult {
  note: NoteSummary
  score: number
  matchIndices: number[]
}

export function NoteSearchPalette({
  notes,
  open,
  selectedNotePath,
  onOpenChange,
  onSelectNote,
}: NoteSearchPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [activePath, setActivePath] = useState('')
  const deferredQuery = useDeferredValue(query)

  const results = useMemo(() => fuzzySearchNotes(notes, deferredQuery), [notes, deferredQuery])

  useEffect(() => {
    if (!open) {
      return
    }

    setQuery('')
    window.setTimeout(() => {
      inputRef.current?.select()
    }, 0)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    const nextActivePath =
      (selectedNotePath && results.some((result) => result.note.path === selectedNotePath) ? selectedNotePath : null) ??
      results[0]?.note.path ??
      ''

    setActivePath(nextActivePath)
  }, [open, results, selectedNotePath])

  const handleSelectResult = (path: string) => {
    onSelectNote(path)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        initialFocus={(openType) => (resolveDialogInitialFocus(openType) ? inputRef.current : false)}
        className="w-[min(40rem,calc(100%-2rem))] max-w-none gap-0 overflow-hidden border border-border/60 bg-popover p-0 shadow-2xl sm:max-w-[40rem]"
      >
        <DialogTitle className="sr-only">Search notes</DialogTitle>
        <DialogDescription className="sr-only">Search note paths, then press Enter to open a match.</DialogDescription>

        <Command
          label="Search notes"
          shouldFilter={false}
          loop
          value={activePath}
          onValueChange={setActivePath}
          className="rounded-none bg-transparent p-0"
        >
          <div className="border-b border-border/50">
            <CommandInput
              ref={inputRef}
              aria-label="Search notes"
              className="font-editor text-[13px]"
              onValueChange={setQuery}
              placeholder="Search notes"
              value={query}
            />
          </div>

          <CommandList className="max-h-[min(26rem,60vh)] py-1">
            <CommandEmpty className="px-4 py-6 font-editor text-[13px] text-muted-foreground">
              No matching notes.
            </CommandEmpty>

            {results.map((result) => (
              <CommandItem
                key={result.note.path}
                value={result.note.path}
                className={cn(
                  'mx-1 gap-0 rounded-lg px-4 py-2 font-editor text-[13px]',
                  result.note.path === selectedNotePath && 'text-foreground',
                )}
                onSelect={() => handleSelectResult(result.note.path)}
              >
                <LeftTruncatedPath path={result.note.path} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function LeftTruncatedPath({ path }: { path: string }) {
  const { basename, directory } = splitPath(path)

  return (
    <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap">
      {directory ? (
        <span
          dir="rtl"
          className="min-w-0 shrink truncate text-left text-muted-foreground/75 group-data-[selected=true]/command-item:text-accent-foreground/70"
        >
          {directory}
        </span>
      ) : null}
      {directory ? (
        <span className="shrink-0 text-muted-foreground/75 group-data-[selected=true]/command-item:text-accent-foreground/70">
          /
        </span>
      ) : null}
      <span className="shrink-0 text-foreground group-data-[selected=true]/command-item:text-accent-foreground">
        {basename}
      </span>
    </span>
  )
}

function splitPath(path: string): { basename: string; basenameOffset: number; directory: string | null } {
  const basenameOffset = path.lastIndexOf('/') + 1

  return {
    basename: path.slice(basenameOffset),
    basenameOffset,
    directory: basenameOffset > 0 ? path.slice(0, basenameOffset - 1) : null,
  }
}

export function fuzzySearchNotes(notes: NoteSummary[], query: string): NoteSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return notes.slice(0, MAX_RESULTS).map((note) => ({
      note,
      score: 0,
      matchIndices: [],
    }))
  }

  return notes
    .map((note) => {
      const match = scoreNotePathMatch(note.path, normalizedQuery)
      if (!match) {
        return null
      }

      return {
        note,
        score: match.score,
        matchIndices: match.matchIndices,
      }
    })
    .filter((result): result is NoteSearchResult => result !== null)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      if (left.note.path.length !== right.note.path.length) {
        return left.note.path.length - right.note.path.length
      }

      return left.note.path.localeCompare(right.note.path)
    })
    .slice(0, MAX_RESULTS)
}

function scoreNotePathMatch(
  path: string,
  normalizedQuery: string,
): { score: number; matchIndices: number[] } | null {
  const normalizedPath = path.toLowerCase()
  const basenameStart = normalizedPath.lastIndexOf('/') + 1
  const normalizedBasename = normalizedPath.slice(basenameStart)

  let score = 0
  let searchFrom = 0
  let previousIndex = -1
  const matchIndices: number[] = []

  if (normalizedPath === normalizedQuery) {
    score += 160
  } else if (normalizedBasename === normalizedQuery) {
    score += 130
  }

  if (normalizedPath.includes(normalizedQuery)) {
    score += 60
  }

  if (normalizedBasename.includes(normalizedQuery)) {
    score += 45
  }

  if (normalizedBasename.startsWith(normalizedQuery)) {
    score += 24
  }

  for (const character of normalizedQuery) {
    const matchIndex = normalizedPath.indexOf(character, searchFrom)
    if (matchIndex === -1) {
      return null
    }

    matchIndices.push(matchIndex)
    score += 12

    if (matchIndex === previousIndex + 1) {
      score += 18
    }

    if (matchIndex >= basenameStart) {
      score += 8
    }

    const previousCharacter = normalizedPath[matchIndex - 1]
    if (matchIndex === 0 || PATH_BOUNDARY_PATTERN.test(previousCharacter)) {
      score += 14
    }

    score -= Math.max(matchIndex - searchFrom, 0)
    previousIndex = matchIndex
    searchFrom = matchIndex + 1
  }

  score += Math.max(18 - path.length / 4, 0)

  return { score, matchIndices }
}
