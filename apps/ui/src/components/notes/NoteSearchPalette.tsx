import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  shortcutLabel?: string
}

interface NoteSearchResult {
  note: NoteSummary
  score: number
  matchIndices: number[]
}

/** Strip trailing `.md` / `.markdown` extension for display. */
function displayPath(path: string): string {
  return path.replace(/\.(?:md|markdown)$/i, '')
}

export function NoteSearchPalette({
  notes,
  open,
  selectedNotePath,
  onOpenChange,
  onSelectNote,
}: NoteSearchPaletteProps) {
  const inputId = useId()
  const resultRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const deferredQuery = useDeferredValue(query)

  const results = useMemo(() => fuzzySearchNotes(notes, deferredQuery), [notes, deferredQuery])

  useEffect(() => {
    if (!open) {
      return
    }

    setQuery('')
    window.setTimeout(() => {
      const input = document.getElementById(inputId) as HTMLInputElement | null
      input?.focus()
      input?.select()
    }, 0)
  }, [inputId, open])

  useEffect(() => {
    if (!open) {
      return
    }

    const selectedIndex = results.findIndex((result) => result.note.path === selectedNotePath)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [open, results, selectedNotePath])

  useEffect(() => {
    if (!open || results.length === 0) {
      return
    }

    const activeResult = results[Math.min(activeIndex, results.length - 1)]
    const activeElement = resultRefs.current.get(activeResult.note.path)
    if (typeof activeElement?.scrollIntoView === 'function') {
      activeElement.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [activeIndex, open, results])

  const handleSelectResult = (result: NoteSearchResult) => {
    onSelectNote(result.note.path)
    onOpenChange(false)
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const activeResult = results[activeIndex]
      if (activeResult) {
        handleSelectResult(activeResult)
      }
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(42rem,calc(100%-2rem))] max-w-3xl gap-0 overflow-hidden border border-border/50 bg-popover p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">Search notes</DialogTitle>
        <DialogDescription className="sr-only">
          Search note filenames and paths, then press Enter to open a match.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b border-border/40 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground/60" />
          <Input
            id={inputId}
            aria-label="Search notes"
            className="h-10 border-0 bg-transparent px-0 text-sm text-popover-foreground shadow-none placeholder:text-muted-foreground/50 focus-visible:border-0 focus-visible:ring-0"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search notes…"
            spellCheck={false}
            value={query}
          />
        </div>

        <ScrollArea className="max-h-[min(26rem,60vh)]">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-popover-foreground/70">No matching notes</p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                Try a shorter filename fragment or part of the path.
              </p>
            </div>
          ) : (
            <div className="p-1">
              {results.map((result, index) => {
                const isActive = index === activeIndex

                return (
                  <button
                    key={result.note.path}
                    ref={(node) => {
                      resultRefs.current.set(result.note.path, node)
                    }}
                    type="button"
                    className={cn(
                      'flex w-full items-center rounded-md px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-popover-foreground/70 hover:bg-accent/50 hover:text-popover-foreground',
                    )}
                    onClick={() => handleSelectResult(result)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span className="min-w-0 truncate font-editor text-[13px] leading-tight">
                      <HighlightedPath
                        path={displayPath(result.note.path)}
                        matchIndices={result.matchIndices}
                        active={isActive}
                      />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="flex items-center gap-3 border-t border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground/50">
          <span><kbd className="font-sans">↵</kbd> open</span>
          <span><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans">esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function HighlightedPath({
  path,
  matchIndices,
  active,
}: {
  path: string
  matchIndices: number[]
  active: boolean
}) {
  if (matchIndices.length === 0) {
    return path
  }

  const highlightedIndices = new Set(matchIndices)

  return path.split('').map((character, index) => (
    <span
      key={`${path}-${index}`}
      className={cn(
        highlightedIndices.has(index)
          ? active
            ? 'text-accent-foreground font-medium'
            : 'text-popover-foreground font-medium'
          : undefined,
      )}
    >
      {character}
    </span>
  ))
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
