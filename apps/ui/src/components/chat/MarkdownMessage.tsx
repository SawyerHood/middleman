import {
  isValidElement,
  memo,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  ChevronRight,
  FileCode2,
  FileText,
  ZoomIn,
} from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  normalizeArtifactShortcodes,
  parseArtifactReference,
  type ArtifactReference,
} from '@/lib/artifacts'
import { isLocalFileUrl, rewriteLocalFileUrl } from '@/lib/read-file-url'
import { cn } from '@/lib/utils'
import { ContentZoomDialog } from './ContentZoomDialog'

const EXTRA_ALLOWED_PROTOCOLS = /^(vscode-insiders|vscode|swarm-file):\/\//i

const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown|mdx)$/i

let mermaidInitialized = false

function urlTransform(url: string): string {
  if (EXTRA_ALLOWED_PROTOCOLS.test(url) || isLocalFileUrl(url)) return url
  return defaultUrlTransform(url)
}

interface MarkdownMessageProps {
  content: string
  variant?: 'message' | 'document'
  onArtifactClick?: (artifact: ArtifactReference) => void
  enableMermaid?: boolean
  className?: string
  wsUrl?: string
}

type ZoomTarget =
  | {
      type: 'image'
      src: string
      alt: string
    }
  | {
      type: 'mermaid'
      svg: string
    }

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  variant = 'message',
  onArtifactClick,
  enableMermaid = false,
  className,
  wsUrl,
}: MarkdownMessageProps) {
  const isDocument = variant === 'document'
  const canExpandContent = isDocument && enableMermaid
  const normalizedContent = useMemo(
    () => normalizeArtifactShortcodes(content),
    [content],
  )
  const [zoomTarget, setZoomTarget] = useState<ZoomTarget | null>(null)

  return (
    <>
      <div
        className={cn(
          'min-w-0 overflow-hidden',
          isDocument ? 'text-[15px] leading-[1.8]' : 'text-sm leading-relaxed',
          className,
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={urlTransform}
          components={{
            p({ children }) {
              return (
                <p
                  className={cn(
                    'break-words whitespace-pre-wrap',
                    isDocument
                      ? 'mb-5 text-foreground/90 last:mb-0'
                      : 'mb-2 last:mb-0',
                  )}
                >
                  {children}
                </p>
              )
            },
            h1({ children }) {
              return (
                <h1
                  className={cn(
                    isDocument
                      ? 'mb-4 mt-8 border-b border-border/50 pb-3 text-2xl font-bold tracking-tight text-foreground first:mt-0'
                      : 'mb-2 text-base font-semibold',
                  )}
                >
                  {children}
                </h1>
              )
            },
            h2({ children }) {
              return (
                <h2
                  className={cn(
                    isDocument
                      ? 'mb-3 mt-7 border-b border-border/40 pb-2 text-xl font-semibold tracking-tight text-foreground first:mt-0'
                      : 'mb-2 text-[15px] font-semibold',
                  )}
                >
                  {children}
                </h2>
              )
            },
            h3({ children }) {
              return (
                <h3
                  className={cn(
                    isDocument
                      ? 'mb-2 mt-6 text-lg font-semibold tracking-tight text-foreground first:mt-0'
                      : 'mb-2 text-sm font-semibold',
                  )}
                >
                  {children}
                </h3>
              )
            },
            h4({ children }) {
              return (
                <h4
                  className={cn(
                    isDocument
                      ? 'mb-2 mt-5 text-base font-semibold text-foreground first:mt-0'
                      : 'mb-2 text-sm font-semibold',
                  )}
                >
                  {children}
                </h4>
              )
            },
            ul({ children }) {
              return (
                <ul
                  className={cn(
                    isDocument
                      ? 'mb-5 list-disc space-y-1.5 pl-6 text-foreground/90 last:mb-0'
                      : 'mb-2 list-disc space-y-0.5 pl-5 last:mb-0',
                  )}
                >
                  {children}
                </ul>
              )
            },
            ol({ children }) {
              return (
                <ol
                  className={cn(
                    isDocument
                      ? 'mb-5 list-decimal space-y-1.5 pl-8 text-foreground/90 last:mb-0'
                      : 'mb-2 list-decimal space-y-0.5 pl-7 last:mb-0',
                  )}
                >
                  {children}
                </ol>
              )
            },
            li({ children }) {
              return (
                <li className="break-words [&>p]:mb-1.5 [&>p]:last:mb-0 [&>input[type=checkbox]]:pointer-events-none [&>input[type=checkbox]]:mr-1.5 [&>input[type=checkbox]]:accent-primary [&>input[type=checkbox]]:opacity-80">
                  {children}
                </li>
              )
            },
            input({ node: _node, ref: _ref, ...props }) {
              if (props.type === 'checkbox') {
                return (
                  <span
                    className={cn(
                      'mr-1.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none align-middle',
                      props.checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40 bg-background',
                    )}
                    aria-checked={!!props.checked}
                    role="checkbox"
                  >
                    {props.checked ? '✓' : ''}
                  </span>
                )
              }
              return <input {...props} />
            },
            blockquote({ children }) {
              return (
                <blockquote
                  className={cn(
                    'my-4 border-l-2 pl-4 italic text-muted-foreground',
                    isDocument
                      ? 'border-primary/30 text-[15px]'
                      : 'border-border text-sm',
                  )}
                >
                  {children}
                </blockquote>
              )
            },
            hr() {
              return (
                <hr
                  className={cn('my-6 border-border/50', isDocument && 'my-8')}
                />
              )
            },
            a({ children, href }) {
              const rawHref = typeof href === 'string' ? href : undefined
              const resolvedHref = rawHref
                ? rewriteLocalFileUrl(wsUrl, rawHref) ?? rawHref
                : rawHref

              const artifact = parseArtifactReference(rawHref, {
                title: extractLinkText(children),
              })
              if (artifact && onArtifactClick) {
                return (
                  <ArtifactReferenceCard
                    artifact={artifact}
                    onClick={onArtifactClick}
                  />
                )
              }

              return (
                <a
                  href={resolvedHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'break-all text-primary underline decoration-primary/30 underline-offset-2',
                    'transition-colors hover:decoration-primary/60',
                    isDocument && 'hover:text-primary/80',
                  )}
                >
                  {children}
                </a>
              )
            },
            img({ src, alt, title }) {
              const imageSrc =
                typeof src === 'string'
                  ? rewriteLocalFileUrl(wsUrl, src) ?? src
                  : null
              if (!imageSrc) {
                return null
              }

              const imageAlt = alt ?? title ?? 'Image preview'

              if (!canExpandContent) {
                return (
                  <img
                    src={imageSrc}
                    alt={alt ?? ''}
                    title={title}
                    loading="lazy"
                    className={cn(
                      'h-auto max-w-full rounded-lg border border-border/50 bg-muted/20',
                      isDocument ? 'my-5' : 'my-2',
                    )}
                  />
                )
              }

              return (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setZoomTarget({
                      type: 'image',
                      src: imageSrc,
                      alt: imageAlt,
                    })
                  }
                  className={cn(
                    'group/zoom relative my-5 inline-block h-auto w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/55 p-0 text-left',
                    'bg-muted/15 text-left transition-all duration-150',
                    'hover:scale-[1.005] hover:border-primary/35',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
                  )}
                  aria-label={`Expand image: ${imageAlt}`}
                >
                  <img
                    src={imageSrc}
                    alt={alt ?? ''}
                    title={title}
                    loading="lazy"
                    className="mx-auto h-auto max-h-[460px] w-auto max-w-full"
                  />
                  <span
                    className={cn(
                      'pointer-events-none absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md',
                      'bg-black/55 text-white/85 shadow-sm backdrop-blur-sm',
                      'opacity-0 transition-opacity duration-150',
                      'group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100',
                    )}
                    aria-hidden="true"
                  >
                    <ZoomIn className="size-3.5" />
                  </span>
                </Button>
              )
            },
            code({ className, children }) {
              const contentValue = String(children)
              const language = resolveCodeLanguage(className)
              const hasLanguageClass = /language-/.test(className ?? '')
              const isBlock = hasLanguageClass || contentValue.includes('\n')

              if (isBlock) {
                const normalizedCode = contentValue.replace(/\n$/, '')

                if (enableMermaid && language === 'mermaid') {
                  return (
                    <MermaidDiagram
                      code={normalizedCode}
                      expandable={canExpandContent}
                      onExpand={(svg) =>
                        setZoomTarget({ type: 'mermaid', svg })
                      }
                    />
                  )
                }

                return (
                  <div className={cn(isDocument ? 'my-5' : 'my-2')}>
                    {language ? (
                      <div className="flex items-center rounded-t-lg border border-b-0 border-border/50 bg-muted/40 px-3 py-1.5">
                        <span className="font-mono text-[11px] font-medium text-muted-foreground">
                          {language}
                        </span>
                      </div>
                    ) : null}
                    <div
                      className={cn(
                        'w-full border border-border/50 bg-muted/25',
                        language ? 'rounded-b-lg' : 'rounded-lg',
                      )}
                    >
                      <pre className="overflow-x-auto p-4">
                        <code
                          className={cn(
                            'font-mono text-foreground/90',
                            isDocument
                              ? 'text-[13px] leading-6'
                              : 'text-xs leading-5',
                          )}
                        >
                          {normalizedCode}
                        </code>
                      </pre>
                    </div>
                  </div>
                )
              }

              return (
                <code
                  className={cn(
                    'rounded bg-muted/70 font-mono text-foreground',
                    isDocument
                      ? 'px-1.5 py-0.5 text-[13px]'
                      : 'px-1 py-0.5 text-xs',
                  )}
                >
                  {children}
                </code>
              )
            },
            pre({ children }) {
              return <>{children}</>
            },
            table({ children }) {
              return (
                <div
                  className={cn(
                    'my-4 w-full overflow-x-auto',
                    isDocument && 'my-5',
                  )}
                >
                  <table className="w-full border-collapse text-sm">
                    {children}
                  </table>
                </div>
              )
            },
            th({ children }) {
              return (
                <th className="border border-border/50 bg-muted/40 px-3 py-2 text-left text-xs font-semibold text-foreground">
                  {children}
                </th>
              )
            },
            td({ children }) {
              return (
                <td className="border border-border/50 px-3 py-2 text-foreground/90">
                  {children}
                </td>
              )
            },
            strong({ children }) {
              return (
                <strong className="font-semibold text-foreground">
                  {children}
                </strong>
              )
            },
            em({ children }) {
              return <em className="italic">{children}</em>
            },
          }}
        >
          {normalizedContent}
        </ReactMarkdown>
      </div>

      <ContentZoomDialog
        open={zoomTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setZoomTarget(null)
          }
        }}
        title={
          zoomTarget?.type === 'mermaid'
            ? 'Expanded Mermaid diagram'
            : 'Expanded image preview'
        }
      >
        {zoomTarget?.type === 'image' ? (
          <img
            src={zoomTarget.src}
            alt={zoomTarget.alt}
            className="h-auto max-h-full w-auto max-w-full rounded-md"
          />
        ) : zoomTarget?.type === 'mermaid' ? (
          <div
            className={cn(
              'flex min-h-full min-w-full items-center justify-center',
              '[&_svg]:h-auto [&_svg]:max-h-full [&_svg]:max-w-full',
            )}
            dangerouslySetInnerHTML={{ __html: zoomTarget.svg }}
          />
        ) : null}
      </ContentZoomDialog>
    </>
  )
})

function ArtifactReferenceCard({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  const isMarkdownFile = MARKDOWN_EXTENSION_PATTERN.test(artifact.fileName)
  const CardIcon = isMarkdownFile ? FileText : FileCode2

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onClick(artifact)}
      className={cn(
        'group/card my-2.5 h-auto w-full justify-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm font-normal',
        'border-primary/20 bg-primary/[0.04] transition-all duration-150',
        'hover:border-primary/35 hover:bg-primary/[0.07] hover:shadow-sm',
        'active:scale-[0.995]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
      )}
      data-artifact-card="true"
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover/card:bg-primary/15">
        <CardIcon className="size-4" aria-hidden="true" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-foreground">
          {artifact.title ?? artifact.fileName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
          {artifact.path}
        </span>
      </span>

      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-all group-hover/card:text-primary">
        <ChevronRight className="size-4" aria-hidden="true" />
      </span>
    </Button>
  )
}

function extractLinkText(children: ReactNode): string | undefined {
  const text = flattenText(children).trim()
  return text || undefined
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map((child) => flattenText(child)).join('')
  }

  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return flattenText(props.children)
  }

  return ''
}

function MermaidDiagram({
  code,
  expandable = false,
  onExpand,
}: {
  code: string
  expandable?: boolean
  onExpand?: (svg: string) => void
}) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const diagramId = useId().replace(/[:]/g, '-')

  useEffect(() => {
    let cancelled = false

    setSvg(null)
    setError(null)

    void (async () => {
      try {
        const module = await import('mermaid')
        const mermaidApi = module.default

        if (!mermaidInitialized) {
          mermaidApi.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'default',
          })
          mermaidInitialized = true
        }

        const renderId = `mermaid-${diagramId}-${Math.random().toString(16).slice(2, 8)}`
        const { svg: renderedSvg } = await mermaidApi.render(renderId, code)

        if (cancelled) {
          return
        }

        setSvg(renderedSvg)
      } catch (renderError) {
        if (cancelled) {
          return
        }

        setError(
          renderError instanceof Error
            ? renderError.message
            : 'Unable to render Mermaid diagram.',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, diagramId])

  const canExpand =
    expandable && !!svg && !error && typeof onExpand === 'function'

  return (
    <div className="my-5 overflow-hidden rounded-lg border border-border/50 bg-background">
      <div className="flex items-center justify-between border-b border-border/40 bg-muted/30 px-3 py-1.5">
        <span className="font-mono text-[11px] font-medium text-muted-foreground">
          mermaid
        </span>
        {canExpand ? (
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
            <ZoomIn className="size-3" aria-hidden="true" />
            <span>Click to expand</span>
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="p-4">
          <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>Mermaid render error: {error}</span>
          </div>
        </div>
      ) : svg ? (
        canExpand ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onExpand(svg)}
            className={cn(
              'group/zoom relative block h-auto w-full cursor-zoom-in overflow-hidden p-0 text-left text-sm font-normal',
              'transition-colors hover:bg-muted/20',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-inset',
            )}
            aria-label="Expand Mermaid diagram"
          >
            <ScrollArea className="max-h-[70vh] w-full">
              <div
                className="flex justify-center p-4 [&_svg]:h-auto [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </ScrollArea>
            <span
              className={cn(
                'pointer-events-none absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md',
                'bg-black/55 text-white/85 shadow-sm backdrop-blur-sm',
                'opacity-0 transition-opacity duration-150',
                'group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100',
              )}
              aria-hidden="true"
            >
              <ZoomIn className="size-3.5" />
            </span>
          </Button>
        ) : (
          <ScrollArea className="max-h-[70vh]">
            <div
              className="flex justify-center p-4 [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </ScrollArea>
        )
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">
          Rendering diagram…
        </p>
      )}
    </div>
  )
}

function resolveCodeLanguage(className: string | undefined): string | null {
  if (!className) {
    return null
  }

  const token = className
    .split(/\s+/)
    .find((entry) => entry.trim().toLowerCase().startsWith('language-'))

  if (!token) {
    return null
  }

  return token.replace(/^language-/i, '').toLowerCase()
}
