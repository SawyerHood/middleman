import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import {
  $createParagraphNode,
  $insertNodes,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  PASTE_COMMAND,
  mergeRegister,
} from 'lexical'
import { Loader2 } from 'lucide-react'
import { memo, useEffect, useEffectEvent, useMemo, useState } from 'react'

import { $createImageNode, NotesImageContext } from './ImageNode'
import { FloatingToolbar } from './FloatingToolbar'
import { uploadNoteAttachment } from './notes-api'
import { NOTES_EDITOR_NODES, NOTES_MARKDOWN_TRANSFORMERS } from './notes-markdown'

const editorTheme = {
  paragraph: 'mb-4 leading-[1.72] text-foreground/95 last:mb-0',
  heading: {
    h1: 'mb-6 mt-4 text-[2.3rem] font-bold leading-tight tracking-[-0.04em] text-foreground first:mt-0 md:text-[2.75rem]',
    h2: 'mb-4 mt-12 text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] text-foreground first:mt-0 md:text-[2rem]',
    h3: 'mb-3 mt-10 text-[1.35rem] font-semibold leading-tight tracking-[-0.02em] text-foreground first:mt-0 md:text-[1.55rem]',
    h4: 'mb-3 mt-8 text-lg font-semibold tracking-tight text-foreground first:mt-0 md:text-[1.15rem]',
    h5: 'mb-2 mt-6 text-base font-semibold tracking-tight text-foreground first:mt-0',
    h6: 'mb-2 mt-6 text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground first:mt-0',
  },
  list: {
    ul: 'mb-6 ml-6 list-disc space-y-2',
    ol: 'mb-6 ml-6 list-decimal space-y-2',
    checklist: 'mb-6 ml-0 space-y-2 pl-0',
    listitem: 'leading-[1.72] marker:text-muted-foreground/65',
    listitemChecked:
      "relative list-none pl-9 text-muted-foreground/80 before:absolute before:left-0 before:top-[0.42rem] before:h-5 before:w-5 before:rounded-md before:border before:border-primary/30 before:bg-primary/15 before:content-[''] after:pointer-events-none after:absolute after:left-[0.43rem] after:top-[0.7rem] after:h-2.5 after:w-1.5 after:rotate-45 after:border-b-2 after:border-r-2 after:border-primary after:content-['']",
    listitemUnchecked:
      "relative list-none pl-9 before:absolute before:left-0 before:top-[0.42rem] before:h-5 before:w-5 before:rounded-md before:border before:border-border before:bg-background/80 before:content-['']",
    nested: {
      list: 'mt-2',
      listitem: 'mt-2',
    },
  },
  quote: 'mb-6 border-l border-border pl-4 italic text-muted-foreground',
  code: 'mb-6 block rounded-xl border border-border/70 bg-muted/45 px-4 py-3 font-mono text-[13px] leading-6 text-foreground',
  link: 'text-primary/90 underline decoration-transparent underline-offset-4 transition-colors hover:text-primary hover:decoration-primary/60',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    code: 'rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground',
  },
}

interface NotesMarkdownEditorProps {
  editorId: string
  wsUrl: string
  markdown: string
  onChange: (markdown: string) => void
  placeholder?: string
}

interface UploadedImage {
  altText: string
  src: string
}

export const NotesMarkdownEditor = memo(function NotesMarkdownEditor({
  editorId,
  wsUrl,
  markdown,
  onChange,
  placeholder = 'Start writing...',
}: NotesMarkdownEditorProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: `middleman-notes-${editorId}`,
      theme: editorTheme,
      nodes: NOTES_EDITOR_NODES,
      onError(error: Error) {
        throw error
      },
      editorState() {
        if (!markdown.trim()) {
          return
        }

        $convertFromMarkdownString(markdown, NOTES_MARKDOWN_TRANSFORMERS)
      },
    }),
    [editorId, markdown],
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <NotesImageContext.Provider value={wsUrl}>
        <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
          <ImagePlugin wsUrl={wsUrl} />
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Note editor"
                className="mx-auto block min-h-full w-full max-w-[720px] px-5 py-8 text-[16px] leading-[1.72] text-foreground outline-none md:px-10 md:py-14"
                spellCheck
              />
            }
            placeholder={
              <div className="pointer-events-none absolute inset-x-0 top-8 px-5 text-[16px] leading-[1.72] text-muted-foreground/40 md:top-14 md:px-10">
                <div className="mx-auto max-w-[720px]">{placeholder}</div>
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <LinkPlugin />
        <FloatingToolbar />
        <MarkdownShortcutPlugin transformers={NOTES_MARKDOWN_TRANSFORMERS} />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(editorState) => {
            editorState.read(() => {
              onChange($convertToMarkdownString(NOTES_MARKDOWN_TRANSFORMERS))
            })
          }}
        />
      </NotesImageContext.Provider>
    </LexicalComposer>
  )
})

function ImagePlugin({ wsUrl }: { wsUrl: string }) {
  const [editor] = useLexicalComposerContext()
  const [uploadCount, setUploadCount] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const uploadImages = useEffectEvent(async (files: File[]) => {
    if (files.length === 0) {
      return
    }

    setUploadError(null)
    setUploadCount((count) => count + files.length)

    try {
      const uploadedImages: UploadedImage[] = []

      for (const file of files) {
        const src = await uploadNoteAttachment(wsUrl, file)
        uploadedImages.push({
          altText: resolveImageAltText(file),
          src,
        })
      }

      editor.update(
        () => {
          insertUploadedImages(uploadedImages)
        },
        { discrete: true },
      )
    } catch (error) {
      setUploadError(toErrorMessage(error))
    } finally {
      setUploadCount((count) => Math.max(0, count - files.length))
    }
  })

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const imageFiles = extractImageFilesFromPasteEvent(event)
          if (imageFiles.length === 0) {
            return false
          }

          event.preventDefault()
          void uploadImages(imageFiles)
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DRAGOVER_COMMAND,
        (event) => {
          const imageFiles = extractImageFilesFromDataTransfer(event.dataTransfer)
          if (imageFiles.length === 0) {
            return false
          }

          event.preventDefault()
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy'
          }
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        (event) => {
          const imageFiles = extractImageFilesFromDataTransfer(event.dataTransfer)
          if (imageFiles.length === 0) {
            return false
          }

          event.preventDefault()
          void uploadImages(imageFiles)
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
    )
  }, [editor, uploadImages])

  if (uploadCount === 0 && uploadError === null) {
    return null
  }

  const isUploading = uploadCount > 0
  const statusText = isUploading
    ? `Uploading ${uploadCount} image${uploadCount === 1 ? '' : 's'}...`
    : uploadError

  return (
    <div
      className={`pointer-events-none absolute right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur ${
        isUploading
          ? 'border-border/70 bg-background/95 text-foreground'
          : 'border-destructive/20 bg-destructive/10 text-destructive'
      }`}
    >
      {isUploading ? <Loader2 className="size-3.5 animate-spin" /> : null}
      <span>{statusText}</span>
    </div>
  )
}

function insertUploadedImages(images: UploadedImage[]): void {
  if (images.length === 0) {
    return
  }

  const nodes = images.map(({ altText, src }) => $createImageNode({ altText, src }))
  $insertNodes(nodes)

  const lastNode = nodes.at(-1)
  if (!lastNode) {
    return
  }

  if (lastNode.getNextSibling() !== null) {
    lastNode.selectNext()
    return
  }

  const trailingParagraph = $createParagraphNode()
  lastNode.insertAfter(trailingParagraph)
  trailingParagraph.select()
}

function extractImageFilesFromPasteEvent(event: Event): File[] {
  if (!('clipboardData' in event)) {
    return []
  }

  return extractImageFilesFromDataTransfer((event as ClipboardEvent).clipboardData)
}

function extractImageFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) {
    return []
  }

  const files = Array.from(dataTransfer.files ?? []).filter((file) => file.type.startsWith('image/'))
  if (files.length > 0) {
    return files
  }

  const fallbackFiles: File[] = []
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) {
      continue
    }

    const file = item.getAsFile()
    if (file) {
      fallbackFiles.push(file)
    }
  }

  return fallbackFiles
}

function resolveImageAltText(file: File): string {
  const trimmedName = file.name.trim()
  if (!trimmedName) {
    return 'image'
  }

  const baseName = trimmedName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return baseName || 'image'
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return 'Unable to upload image.'
}
