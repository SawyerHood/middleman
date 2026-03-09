import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  ExternalLink,
  FileCode2,
  FileImage,
  FileText,
  ListTodo,
  Loader2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ArtifactReference } from '@/lib/artifacts'
import { toVscodeInsidersHref } from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import type { UserEscalation } from '@middleman/protocol'
import { EscalationCard } from './EscalationCard'
import { MarkdownMessage } from './MarkdownMessage'

export type ArtifactPanelSelection =
  | {
      type: 'artifact'
      artifact: ArtifactReference
    }
  | {
      type: 'escalation'
      escalationId: string
    }

interface ArtifactPanelProps {
  selection: ArtifactPanelSelection | null
  escalations: UserEscalation[]
  wsUrl: string
  onClose: () => void
  onArtifactClick?: (artifact: ArtifactReference) => void
  onResolveEscalation?: (input: {
    escalationId: string
    choice: string
    isCustom: boolean
  }) => Promise<void>
  onOpenEscalationsView?: () => void
}

interface ReadFileResult {
  path: string
  content: string
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i
const IMAGE_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg)$/i

export function ArtifactPanel({
  selection,
  escalations,
  wsUrl,
  onClose,
  onArtifactClick,
  onResolveEscalation,
  onOpenEscalationsView,
}: ArtifactPanelProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedArtifact = selection?.type === 'artifact' ? selection.artifact : null
  const selectedEscalation =
    selection?.type === 'escalation'
      ? escalations.find((escalation) => escalation.id === selection.escalationId) ?? null
      : null
  const artifactPath = selectedArtifact?.path ?? null
  const selectionKey =
    selection?.type === 'artifact'
      ? selection.artifact.path
      : selection?.type === 'escalation'
        ? `escalation:${selection.escalationId}`
        : null

  useEffect(() => {
    if (!selectionKey) {
      setIsVisible(false)
      setIsClosing(false)
      return
    }

    setIsClosing(false)
    setIsVisible(false)
    const frame = window.requestAnimationFrame(() => {
      setIsVisible(true)
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [selectionKey])

  useEffect(() => {
    if (!artifactPath) {
      setContent('')
      setResolvedPath(null)
      setError(null)
      setIsLoading(false)
      return
    }

    const isImageArtifact =
      IMAGE_FILE_PATTERN.test(selectedArtifact?.fileName ?? '') || IMAGE_FILE_PATTERN.test(artifactPath)
    if (isImageArtifact) {
      setContent('')
      setResolvedPath(artifactPath)
      setError(null)
      setIsLoading(false)
      return
    }

    const abortController = new AbortController()

    setIsLoading(true)
    setError(null)
    setContent('')
    setResolvedPath(null)

    void (async () => {
      try {
        const file = await readArtifactFile({
          wsUrl,
          path: artifactPath,
          signal: abortController.signal,
        })

        if (abortController.signal.aborted) {
          return
        }

        setContent(file.content)
        setResolvedPath(file.path)
        setError(null)
      } catch (readError) {
        if (abortController.signal.aborted) {
          return
        }

        setError(readError instanceof Error ? readError.message : 'Failed to read file.')
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [artifactPath, selectedArtifact?.fileName, wsUrl])

  useEffect(() => {
    return () => {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current)
      }
    }
  }, [])

  const handleAnimatedClose = () => {
    setIsClosing(true)
    setIsVisible(false)
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current)
    }
    closingTimerRef.current = setTimeout(() => {
      setIsClosing(false)
      onClose()
    }, 260)
  }

  const displayPath = resolvedPath ?? artifactPath ?? ''
  const isImage = useMemo(
    () =>
      IMAGE_FILE_PATTERN.test(selectedArtifact?.fileName ?? '') || IMAGE_FILE_PATTERN.test(displayPath),
    [displayPath, selectedArtifact?.fileName],
  )
  const isMarkdown = useMemo(() => MARKDOWN_FILE_PATTERN.test(displayPath), [displayPath])
  const imageFileUrl = useMemo(() => {
    if (!isImage || !displayPath) {
      return null
    }

    return resolveReadFileUrl(wsUrl, displayPath)
  }, [displayPath, isImage, wsUrl])

  if (!selection && !isClosing) {
    return null
  }

  const panelTitle = selectedArtifact
    ? selectedArtifact.fileName
    : selectedEscalation
      ? selectedEscalation.title
      : 'Details'
  const panelSubtitle = selectedArtifact
    ? displayPath
    : selectedEscalation
      ? selectedEscalation.status === 'open'
        ? 'Open task'
        : 'Resolved task'
      : 'Selection unavailable'
  const PanelIcon = selectedArtifact
    ? isImage
      ? FileImage
      : isMarkdown
        ? FileText
        : FileCode2
    : ListTodo
  const isOpen = Boolean(selectionKey) || isClosing

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleAnimatedClose()
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className={cn(
            'fixed inset-0 z-50',
            'transition-[backdrop-filter,background-color] duration-300 ease-out',
            isVisible
              ? 'bg-background/60 backdrop-blur-[2px]'
              : 'pointer-events-none bg-transparent backdrop-blur-0',
            isClosing && !isVisible && 'pointer-events-none',
          )}
        />
        <DialogPrimitive.Popup
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-full flex-col',
            'max-md:max-w-full md:max-w-[min(880px,90vw)]',
            'border-l border-border/80 bg-background',
            'shadow-[-8px_0_32px_-4px_rgba(0,0,0,0.12)] outline-none',
            'transition-all duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)]',
            isVisible ? 'translate-x-0 opacity-100' : 'translate-x-[40%] opacity-0',
          )}
        >
          <DialogTitle className="sr-only">{panelTitle}</DialogTitle>
          <header className="flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5 backdrop-blur">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PanelIcon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-foreground">{panelTitle}</h2>
                <p
                  className={cn(
                    'truncate text-[11px] text-muted-foreground',
                    selectedArtifact ? 'font-mono' : '',
                  )}
                >
                  {panelSubtitle}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {selectedArtifact ? (
                <>
                  <a
                    href={toVscodeInsidersHref(displayPath || selectedArtifact.path)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                      'text-muted-foreground transition-colors',
                      'hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <ExternalLink className="size-3" aria-hidden="true" />
                    <span className="hidden sm:inline">Open in VS Code</span>
                    <span className="sm:hidden">VS Code</span>
                  </a>

                  <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />
                </>
              ) : onOpenEscalationsView ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onOpenEscalationsView}
                  >
                    Open tasks
                  </Button>

                  <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />
                </>
              ) : null}

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-md',
                  'text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
                onClick={handleAnimatedClose}
                aria-label="Close artifact panel"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </header>

          <ScrollArea
            className={cn(
              'min-h-0 flex-1',
              '[&>[data-slot=scroll-area-scrollbar]]:w-2',
              '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
              'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
            )}
          >
            <div className="px-6 py-6">
              {selectedEscalation ? (
                <EscalationCard
                  escalation={selectedEscalation}
                  variant="panel"
                  onResolveEscalation={onResolveEscalation}
                />
              ) : isLoading ? (
                <div className="flex items-center gap-2.5 py-12 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>Loading file...</span>
                </div>
              ) : error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : selectedArtifact && isImage ? (
                imageFileUrl ? (
                  <div className="mx-auto flex max-w-[820px] justify-center">
                    <img
                      src={imageFileUrl}
                      alt={selectedArtifact.fileName || 'Artifact image'}
                      className="max-h-[calc(100vh-180px)] max-w-full rounded-lg border border-border/60 bg-muted/20 object-contain"
                    />
                  </div>
                ) : (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    Unable to load image preview.
                  </div>
                )
              ) : selectedArtifact && isMarkdown ? (
                <article className="mx-auto max-w-[680px]">
                  <MarkdownMessage
                    content={content}
                    variant="document"
                    enableMermaid
                    onArtifactClick={onArtifactClick}
                  />
                </article>
              ) : selectedArtifact ? (
                <ScrollArea className="w-full rounded-lg border border-border/60 bg-muted/25">
                  <pre className="p-4">
                    <code className="whitespace-pre font-mono text-[13px] leading-relaxed text-foreground/90">
                      {content}
                    </code>
                  </pre>
                </ScrollArea>
              ) : (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                  This selection is no longer available.
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

async function readArtifactFile({
  wsUrl,
  path,
  signal,
}: {
  wsUrl: string
  path: string
  signal: AbortSignal
}): Promise<ReadFileResult> {
  const endpoint = resolveReadFileEndpoint(wsUrl)

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
    signal,
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `File read failed (${response.status})`

    throw new Error(message)
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid file read response.')
  }

  const resolvedPath = typeof payload.path === 'string' ? payload.path : path
  const content = typeof payload.content === 'string' ? payload.content : ''

  return {
    path: resolvedPath,
    content,
  }
}

function resolveReadFileEndpoint(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = '/api/read-file'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '/api/read-file'
  }
}

function resolveReadFileUrl(wsUrl: string, path: string): string {
  const endpoint = resolveReadFileEndpoint(wsUrl)
  const separator = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${separator}path=${encodeURIComponent(path)}`
}
