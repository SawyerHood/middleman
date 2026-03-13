import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core'
import { type Ctx } from '@milkdown/kit/ctx'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { cursor } from '@milkdown/kit/plugin/cursor'
import { history } from '@milkdown/kit/plugin/history'
import { indent } from '@milkdown/kit/plugin/indent'
import { listener } from '@milkdown/kit/plugin/listener'
import { trailing } from '@milkdown/kit/plugin/trailing'
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  commonmark,
  emphasisSchema,
  headingSchema,
  imageSchema,
  inlineCodeSchema,
  linkSchema,
  listItemSchema,
  orderedListSchema,
  strongSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark'
import { gfm, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { type Node as ProseNode, type NodeType } from '@milkdown/kit/prose/model'
import { lift, setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import { type EditorState } from '@milkdown/kit/prose/state'
import { type EditorView } from '@milkdown/kit/prose/view'
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import { $view, callCommand, insert } from '@milkdown/kit/utils'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { nord } from '@milkdown/theme-nord'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Loader2,
  SquareCode,
  Strikethrough,
  TextQuote,
} from 'lucide-react'
import { memo, startTransition, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

import { resolveNoteImageUrl, uploadNoteAttachment } from './notes-api'

import './notes-milkdown.css'

type BlockType = 'paragraph' | 'h1' | 'h2' | 'h3' | 'quote' | 'code'
type ListType = 'bullet' | 'number' | 'check' | null

interface NotesMarkdownEditorProps {
  editorId: string
  wsUrl: string
  markdown: string
  onChange: (markdown: string) => void
  placeholder?: string
}

interface ToolbarState {
  blockType: BlockType
  isBold: boolean
  isCode: boolean
  isItalic: boolean
  isLink: boolean
  isStrikethrough: boolean
  listType: ListType
}

interface UploadedImage {
  altText: string
  src: string
}

interface AncestorMatch {
  node: ProseNode
  pos: number
}

interface PositionedNode {
  node: ProseNode
  pos: number
}

const INITIAL_TOOLBAR_STATE: ToolbarState = {
  blockType: 'paragraph',
  isBold: false,
  isCode: false,
  isItalic: false,
  isLink: false,
  isStrikethrough: false,
  listType: null,
}

const IMAGE_UPLOAD_STATUS_CONTAINER_CLASS_NAME =
  'pointer-events-none absolute right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur'

const notesImageView = (wsUrl: string) =>
  $view(imageSchema.node, (ctx) => {
    const imageType = imageSchema.type(ctx)

    return (initialNode: ProseNode) => {
      const dom = document.createElement('img')
      dom.className = 'notes-milkdown-image'
      dom.loading = 'lazy'
      applyImageNodeAttributes(dom, initialNode, wsUrl)

      return {
        dom,
        update(updatedNode: ProseNode) {
          if (updatedNode.type !== imageType) {
            return false
          }

          applyImageNodeAttributes(dom, updatedNode, wsUrl)
          return true
        },
      }
    }
  })

export const NotesMarkdownEditor = memo(function NotesMarkdownEditor(props: NotesMarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <NotesMarkdownEditorContent {...props} />
    </MilkdownProvider>
  )
})

function NotesMarkdownEditorContent({
  editorId,
  wsUrl,
  markdown,
  onChange,
  placeholder = 'Start writing...',
}: NotesMarkdownEditorProps) {
  const initialMarkdown = useRef(markdown).current
  const lastSerializedMarkdownRef = useRef(initialMarkdown)
  const onChangeRef = useRef(onChange)
  const imageViewPlugin = useMemo(() => notesImageView(wsUrl), [wsUrl])
  const [toolbarState, setToolbarState] = useState(INITIAL_TOOLBAR_STATE)
  const [isEmpty, setIsEmpty] = useState(() => initialMarkdown.trim().length === 0)
  const [uploadCount, setUploadCount] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)

  onChangeRef.current = onChange

  const syncToolbarState = useEffectEvent((ctx: Ctx, state: EditorState) => {
    const nextToolbarState = readToolbarState(ctx, state)

    startTransition(() => {
      setToolbarState((current) =>
        areToolbarStatesEqual(current, nextToolbarState) ? current : nextToolbarState,
      )
    })
  })

  const publishMarkdown = useEffectEvent((nextMarkdown: string) => {
    lastSerializedMarkdownRef.current = nextMarkdown
    setIsEmpty(nextMarkdown.trim().length === 0)
    onChangeRef.current(nextMarkdown)
  })

  const { get: getEditor, loading } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, initialMarkdown)
          nord(ctx)
          ctx.update(editorViewOptionsCtx, (options) => ({
            ...options,
            dispatchTransaction: (transaction) => {
              const view = ctx.get(editorViewCtx)
              const currentState = view.state
              const selectionChanged = !transaction.selection.eq(currentState.selection)
              const nextState = currentState.apply(transaction)

              view.updateState(nextState)

              if (transaction.docChanged || selectionChanged || transaction.storedMarksSet) {
                syncToolbarState(ctx, nextState)
              }

              if (!transaction.docChanged) {
                return
              }

              const nextMarkdown = ctx.get(serializerCtx)(nextState.doc)
              if (nextMarkdown === lastSerializedMarkdownRef.current) {
                return
              }

              publishMarkdown(nextMarkdown)
            },
          }))
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(clipboard)
        .use(cursor)
        .use(trailing)
        .use(indent)
        .use(listener)
        .use(imageViewPlugin),
    [editorId, imageViewPlugin, initialMarkdown],
  )

  const withEditor = <T,>(action: (ctx: Ctx, view: EditorView) => T): T | undefined => {
    if (loading) {
      return undefined
    }

    const editor = getEditor()
    if (!editor) {
      return undefined
    }

    return editor.action((ctx) => action(ctx, ctx.get(editorViewCtx)))
  }

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

      const snippet = uploadedImages.map(({ altText, src }) => formatImageMarkdown(altText, src)).join('\n\n')

      withEditor((ctx, view) => {
        view.focus()
        const selection = view.state.selection
        const needsLeadingLineBreak = selection.$from.parent.textContent.trim().length > 0
        const markdownToInsert = needsLeadingLineBreak ? `\n\n${snippet}\n\n` : `${snippet}\n\n`
        const inserted = insert(markdownToInsert)
        inserted(ctx)
      })
    } catch (error) {
      setUploadError(toErrorMessage(error))
    } finally {
      setUploadCount((count) => Math.max(0, count - files.length))
    }
  })

  useEffect(() => {
    if (loading) {
      return
    }

    withEditor((ctx, view) => {
      syncToolbarState(ctx, view.state)
    })
  }, [loading, syncToolbarState])

  useEffect(() => {
    if (loading) {
      return
    }

    return withEditor((_ctx, view) => {
      const handlePaste = (event: ClipboardEvent) => {
        const imageFiles = extractImageFilesFromPasteEvent(event)
        if (imageFiles.length === 0) {
          return
        }

        event.preventDefault()
        void uploadImages(imageFiles)
      }

      const handleDragOver = (event: DragEvent) => {
        const imageFiles = extractImageFilesFromDataTransfer(event.dataTransfer)
        if (imageFiles.length === 0) {
          return
        }

        event.preventDefault()
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy'
        }
      }

      const handleDrop = (event: DragEvent) => {
        const imageFiles = extractImageFilesFromDataTransfer(event.dataTransfer)
        if (imageFiles.length === 0) {
          return
        }

        event.preventDefault()
        view.focus()
        void uploadImages(imageFiles)
      }

      view.dom.addEventListener('paste', handlePaste)
      view.dom.addEventListener('dragover', handleDragOver)
      view.dom.addEventListener('drop', handleDrop)

      return () => {
        view.dom.removeEventListener('paste', handlePaste)
        view.dom.removeEventListener('dragover', handleDragOver)
        view.dom.removeEventListener('drop', handleDrop)
      }
    })
  }, [loading, uploadImages])

  const toggleHeading = (level: 1 | 2 | 3) => {
    withEditor((ctx, view) => {
      view.focus()

      if (toolbarState.blockType === `h${level}`) {
        return callCommand(turnIntoTextCommand.key)(ctx)
      }

      return callCommand(wrapInHeadingCommand.key, level)(ctx)
    })
  }

  const toggleBold = () => {
    withEditor((ctx, view) => {
      view.focus()
      return callCommand(toggleStrongCommand.key)(ctx)
    })
  }

  const toggleItalic = () => {
    withEditor((ctx, view) => {
      view.focus()
      return callCommand(toggleEmphasisCommand.key)(ctx)
    })
  }

  const toggleStrikethrough = () => {
    withEditor((ctx, view) => {
      view.focus()
      return callCommand(toggleStrikethroughCommand.key)(ctx)
    })
  }

  const toggleInlineCode = () => {
    withEditor((ctx, view) => {
      view.focus()
      return callCommand(toggleInlineCodeCommand.key)(ctx)
    })
  }

  const toggleBlockquote = () => {
    withEditor((ctx, view) => {
      view.focus()

      const blockquoteType = blockquoteSchema.type(ctx)
      const activeBlockquote = findAncestorNode(view.state.selection.$from, (node) => node.type === blockquoteType)
      if (activeBlockquote) {
        return lift(view.state, view.dispatch)
      }

      return wrapIn(blockquoteType)(view.state, view.dispatch)
    })
  }

  const toggleCodeBlock = () => {
    withEditor((ctx, view) => {
      view.focus()

      const codeBlockType = codeBlockSchema.type(ctx)
      if (toolbarState.blockType === 'code') {
        return callCommand(turnIntoTextCommand.key)(ctx)
      }

      return wrapInOrSetBlockType(view, codeBlockType)
    })
  }

  const toggleBulletList = () => {
    withEditor((ctx, view) => {
      view.focus()
      return toggleList(view, ctx, 'bullet', toolbarState.listType)
    })
  }

  const toggleOrderedList = () => {
    withEditor((ctx, view) => {
      view.focus()
      return toggleList(view, ctx, 'number', toolbarState.listType)
    })
  }

  const toggleTaskList = () => {
    withEditor((ctx, view) => {
      view.focus()
      return toggleChecklist(view, ctx, toolbarState.listType)
    })
  }

  const toggleLink = () => {
    withEditor((ctx, view) => {
      view.focus()

      if (toolbarState.isLink) {
        return callCommand(toggleLinkCommand.key)(ctx)
      }

      const nextUrl = window.prompt('Enter a URL', 'https://')
      if (nextUrl === null) {
        return false
      }

      const normalizedUrl = nextUrl.trim()
      if (normalizedUrl.length === 0) {
        return false
      }

      return callCommand(toggleLinkCommand.key, { href: normalizedUrl })(ctx)
    })
  }

  const isUploading = uploadCount > 0
  const statusText = isUploading
    ? `Uploading ${uploadCount} image${uploadCount === 1 ? '' : 's'}...`
    : uploadError

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {isUploading || uploadError ? (
        <div
          className={cn(
            IMAGE_UPLOAD_STATUS_CONTAINER_CLASS_NAME,
            isUploading
              ? 'border-border/70 bg-background/95 text-foreground'
              : 'border-destructive/20 bg-destructive/10 text-destructive',
          )}
        >
          {isUploading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          <span>{statusText}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="notes-milkdown-shell mx-auto min-h-full w-full max-w-[860px]">
          {isEmpty ? (
            <div className="notes-milkdown-placeholder" aria-hidden="true">
              {placeholder}
            </div>
          ) : null}
          <Milkdown />
          {loading ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/65 backdrop-blur-[2px]">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border/50 bg-card/95 px-3 py-1.5 backdrop-blur-sm md:px-4">
        <div className="mx-auto flex max-w-[860px] flex-wrap items-center gap-0.5">
          <ToolbarButton active={toolbarState.isBold} label="Bold" onClick={toggleBold}>
            <Bold className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.isItalic} label="Italic" onClick={toggleItalic}>
            <Italic className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.isStrikethrough} label="Strikethrough" onClick={toggleStrikethrough}>
            <Strikethrough className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.isCode} label="Inline code" onClick={toggleInlineCode}>
            <Code className="size-3.5" />
          </ToolbarButton>
          <Separator className="mx-1.5 hidden h-4 sm:block" orientation="vertical" />
          <ToolbarButton active={toolbarState.blockType === 'h1'} label="Heading 1" onClick={() => toggleHeading(1)}>
            <Heading1 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.blockType === 'h2'} label="Heading 2" onClick={() => toggleHeading(2)}>
            <Heading2 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.blockType === 'h3'} label="Heading 3" onClick={() => toggleHeading(3)}>
            <Heading3 className="size-3.5" />
          </ToolbarButton>
          <Separator className="mx-1.5 hidden h-4 sm:block" orientation="vertical" />
          <ToolbarButton active={toolbarState.listType === 'bullet'} label="Bulleted list" onClick={toggleBulletList}>
            <List className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.listType === 'number'} label="Numbered list" onClick={toggleOrderedList}>
            <ListOrdered className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.listType === 'check'} label="Checklist" onClick={toggleTaskList}>
            <ListTodo className="size-3.5" />
          </ToolbarButton>
          <Separator className="mx-1.5 hidden h-4 sm:block" orientation="vertical" />
          <ToolbarButton active={toolbarState.blockType === 'code'} label="Code block" onClick={toggleCodeBlock}>
            <SquareCode className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.blockType === 'quote'} label="Quote" onClick={toggleBlockquote}>
            <TextQuote className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton active={toolbarState.isLink} label="Link" onClick={toggleLink}>
            <Link2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>
    </div>
  )
}

function ToolbarButton({
  active = false,
  children,
  label,
  onClick,
}: {
  active?: boolean
  children: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'size-7 rounded-md border border-transparent bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60',
        active && 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary',
      )}
      onClick={onClick}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  )
}

function applyImageNodeAttributes(dom: HTMLImageElement, node: ProseNode, wsUrl: string): void {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
  const title = typeof node.attrs.title === 'string' ? node.attrs.title : ''

  dom.alt = alt
  dom.src = resolveNoteImageUrl(wsUrl, src)

  if (title.length > 0) {
    dom.title = title
  } else {
    dom.removeAttribute('title')
  }
}

function readToolbarState(ctx: Ctx, state: EditorState): ToolbarState {
  const strong = strongSchema.type(ctx)
  const emphasis = emphasisSchema.type(ctx)
  const inlineCode = inlineCodeSchema.type(ctx)
  const link = linkSchema.type(ctx)

  return {
    blockType: readBlockType(ctx, state),
    isBold: isMarkActive(state, strong),
    isCode: isMarkActive(state, inlineCode),
    isItalic: isMarkActive(state, emphasis),
    isLink: isMarkActive(state, link),
    isStrikethrough: isMarkActive(state, getStrikeThroughMarkType(state)),
    listType: readListType(ctx, state),
  }
}

function readBlockType(ctx: Ctx, state: EditorState): BlockType {
  const { $from } = state.selection
  const codeBlockType = codeBlockSchema.type(ctx)
  const blockquoteType = blockquoteSchema.type(ctx)
  const headingType = headingSchema.type(ctx)

  if (findAncestorNode($from, (node) => node.type === codeBlockType)) {
    return 'code'
  }

  if (findAncestorNode($from, (node) => node.type === blockquoteType)) {
    return 'quote'
  }

  const activeHeading = findAncestorNode($from, (node) => node.type === headingType)
  if (activeHeading) {
    switch (activeHeading.node.attrs.level) {
      case 1:
        return 'h1'
      case 2:
        return 'h2'
      case 3:
        return 'h3'
    }
  }

  return 'paragraph'
}

function readListType(ctx: Ctx, state: EditorState): ListType {
  const listItemType = listItemSchema.type(ctx)
  const bulletListType = bulletListSchema.type(ctx)
  const orderedListType = orderedListSchema.type(ctx)
  const listItem = findAncestorNode(state.selection.$from, (node) => node.type === listItemType)
  const list = findAncestorNode(
    state.selection.$from,
    (node) => node.type === bulletListType || node.type === orderedListType,
  )

  if (!listItem || !list) {
    return null
  }

  if (listItem.node.attrs.checked !== null && listItem.node.attrs.checked !== undefined) {
    return 'check'
  }

  return list.node.type === orderedListType ? 'number' : 'bullet'
}

function areToolbarStatesEqual(left: ToolbarState, right: ToolbarState): boolean {
  return (
    left.blockType === right.blockType &&
    left.isBold === right.isBold &&
    left.isCode === right.isCode &&
    left.isItalic === right.isItalic &&
    left.isLink === right.isLink &&
    left.isStrikethrough === right.isStrikethrough &&
    left.listType === right.listType
  )
}

function isMarkActive(state: EditorState, markType: ReturnType<typeof strongSchema.type>): boolean {
  const { empty, from, to } = state.selection
  if (empty) {
    return Boolean(markType.isInSet(state.storedMarks ?? state.selection.$from.marks()))
  }

  return state.doc.rangeHasMark(from, to, markType)
}

function getStrikeThroughMarkType(state: EditorState) {
  const schema = state.schema
  const strikeThrough = schema.marks.strike_through ?? schema.marks.strikethrough
  if (!strikeThrough) {
    throw new Error('Milkdown strike-through mark is unavailable.')
  }

  return strikeThrough
}

function findAncestorNode(
  $from: EditorState['selection']['$from'],
  predicate: (node: ProseNode) => boolean,
): AncestorMatch | null {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (!predicate(node)) {
      continue
    }

    return {
      node,
      pos: $from.before(depth),
    }
  }

  return null
}

function collectSelectedListItems(state: EditorState, listItemType: NodeType): PositionedNode[] {
  const items = new Map<number, PositionedNode>()
  const from = state.selection.from
  const to = state.selection.empty ? state.selection.to + 1 : state.selection.to

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === listItemType) {
      items.set(pos, { node, pos })
    }
  })

  if (items.size > 0) {
    return [...items.values()]
  }

  const currentItem = findAncestorNode(state.selection.$from, (node) => node.type === listItemType)
  if (!currentItem) {
    return []
  }

  return [{ node: currentItem.node, pos: currentItem.pos }]
}

function toggleList(
  view: EditorView,
  ctx: Ctx,
  targetListType: Exclude<ListType, 'check' | null>,
  activeListType: ListType,
): boolean {
  const bulletListType = bulletListSchema.type(ctx)
  const orderedListType = ctx.get(editorViewCtx).state.schema.nodes.ordered_list
  const listItemType = listItemSchema.type(ctx)
  const targetNodeType = targetListType === 'number' ? orderedListType : bulletListType

  if (!targetNodeType) {
    return false
  }

  if (activeListType === targetListType) {
    return liftListItem(listItemType)(view.state, view.dispatch)
  }

  if (activeListType === 'check') {
    clearTaskState(view, ctx)
  }

  const listNode = findCurrentListNode(view, ctx)
  if (listNode) {
    const nextAttrs =
      targetListType === 'number'
        ? {
            order: typeof listNode.node.attrs.order === 'number' ? listNode.node.attrs.order : 1,
            spread: Boolean(listNode.node.attrs.spread),
          }
        : {
            spread: Boolean(listNode.node.attrs.spread),
          }

    view.dispatch(view.state.tr.setNodeMarkup(listNode.pos, targetNodeType, nextAttrs).scrollIntoView())
    return true
  }

  return wrapInList(targetNodeType)(view.state, view.dispatch)
}

function toggleChecklist(view: EditorView, ctx: Ctx, activeListType: ListType): boolean {
  const bulletListType = bulletListSchema.type(ctx)
  const listItemType = listItemSchema.type(ctx)

  if (activeListType === 'check') {
    return clearTaskState(view, ctx)
  }

  if (activeListType === 'number') {
    const currentList = findCurrentListNode(view, ctx)
    if (currentList) {
      view.dispatch(
        view.state.tr
          .setNodeMarkup(currentList.pos, bulletListType, {
            spread: Boolean(currentList.node.attrs.spread),
          })
          .scrollIntoView(),
      )
    }
  } else if (activeListType === null) {
    const wrapped = wrapInList(bulletListType)(view.state, view.dispatch)
    if (!wrapped) {
      return false
    }
  }

  const selectedItems = collectSelectedListItems(view.state, listItemType)
  if (selectedItems.length === 0) {
    return false
  }

  let transaction = view.state.tr
  for (const { node, pos } of selectedItems) {
    transaction = transaction.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      checked: false,
    })
  }

  view.dispatch(transaction.scrollIntoView())
  return true
}

function clearTaskState(view: EditorView, ctx: Ctx): boolean {
  const listItemType = listItemSchema.type(ctx)
  const selectedItems = collectSelectedListItems(view.state, listItemType)
  if (selectedItems.length === 0) {
    return false
  }

  let transaction = view.state.tr
  for (const { node, pos } of selectedItems) {
    transaction = transaction.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      checked: null,
    })
  }

  view.dispatch(transaction.scrollIntoView())
  return true
}

function findCurrentListNode(view: EditorView, ctx: Ctx): AncestorMatch | null {
  const bulletListType = bulletListSchema.type(ctx)
  const orderedListType = ctx.get(editorViewCtx).state.schema.nodes.ordered_list

  if (!orderedListType) {
    return findAncestorNode(view.state.selection.$from, (node) => node.type === bulletListType)
  }

  return findAncestorNode(
    view.state.selection.$from,
    (node) => node.type === bulletListType || node.type === orderedListType,
  )
}

function wrapInOrSetBlockType(view: EditorView, nodeType: NodeType): boolean {
  return setBlockType(nodeType)(view.state, view.dispatch)
}

function formatImageMarkdown(altText: string, src: string): string {
  return `![${altText.replace(/]/g, '\\]')}](${src})`
}

function extractImageFilesFromPasteEvent(event: ClipboardEvent): File[] {
  return extractImageFilesFromDataTransfer(event.clipboardData)
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
