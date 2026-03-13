import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type EditorThemeClasses,
  type LexicalEditor,
  type NodeSelection,
  type RangeSelection,
} from 'lexical'
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CHECK_LIST,
  CODE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown'
import { $createCodeNode, $isCodeNode, CodeNode } from '@lexical/code'
import { $isLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link'
import { $insertList, $isListNode, $removeList, ListItemNode, ListNode, type ListType } from '@lexical/list'
import { $setBlocksType } from '@lexical/selection'
import { $findMatchingParent, mergeRegister } from '@lexical/utils'
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode, HeadingNode, QuoteNode, type HeadingTagType } from '@lexical/rich-text'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { EditorRefPlugin } from '@lexical/react/LexicalEditorRefPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { DRAG_DROP_PASTE } from '@lexical/rich-text'
import {
  Bold as BoldIcon,
  Code as InlineCodeIcon,
  Heading1 as Heading1Icon,
  Heading2 as Heading2Icon,
  Heading3 as Heading3Icon,
  Italic as ItalicIcon,
  Link2 as LinkIcon,
  List as BulletListIcon,
  ListOrdered as OrderedListIcon,
  ListTodo as ChecklistIcon,
  Loader2,
  Quote as QuoteIcon,
  SquareCode as CodeBlockIcon,
  Strikethrough as StrikethroughIcon,
} from 'lucide-react'
import {
  memo,
  startTransition,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
  type RefObject,
} from 'react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

import { $createImageNode, $isImageNode, ImageNode, NotesImageContext } from './ImageNode'
import { uploadNoteAttachment } from './notes-api'

import './notes-lexical.css'

export interface NotesMarkdownEditorProps {
  editorId: string
  wsUrl: string
  markdown: string
  onChange: (markdown: string) => void
  placeholder?: string
  editorRef?: RefObject<LexicalEditor | null | undefined> | ((editor: LexicalEditor | null) => void)
}

type ToolbarBlockType = 'paragraph' | HeadingTagType | ListType | 'quote' | 'code'

type ToolbarState = {
  blockType: ToolbarBlockType
  hasSelection: boolean
  isBold: boolean
  isItalic: boolean
  isInlineCode: boolean
  isStrikethrough: boolean
  linkUrl: string | null
}

const IMAGE_UPLOAD_STATUS_CONTAINER_CLASS_NAME =
  'pointer-events-none absolute right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur'

const NOTES_SYNC_TAG = 'notes-markdown-sync'

const DEFAULT_TOOLBAR_STATE: ToolbarState = {
  blockType: 'paragraph',
  hasSelection: false,
  isBold: false,
  isItalic: false,
  isInlineCode: false,
  isStrikethrough: false,
  linkUrl: null,
}

const NOTES_EDITOR_THEME = {
  code: 'notes-lexical-code',
  heading: {
    h1: 'notes-lexical-heading notes-lexical-heading-h1',
    h2: 'notes-lexical-heading notes-lexical-heading-h2',
    h3: 'notes-lexical-heading notes-lexical-heading-h3',
  },
  link: 'notes-lexical-link',
  list: {
    checklist: 'notes-lexical-list notes-lexical-list-checklist',
    listitem: 'notes-lexical-list-item',
    listitemChecked: 'notes-lexical-list-item notes-lexical-list-item-checked',
    listitemUnchecked: 'notes-lexical-list-item notes-lexical-list-item-unchecked',
    nested: {
      list: 'notes-lexical-list-nested',
      listitem: 'notes-lexical-list-item',
    },
    ol: 'notes-lexical-list notes-lexical-list-ordered',
    ul: 'notes-lexical-list notes-lexical-list-bullet',
  },
  paragraph: 'notes-lexical-paragraph',
  quote: 'notes-lexical-quote',
  root: 'notes-lexical-root',
  text: {
    bold: 'notes-lexical-text-bold',
    code: 'notes-lexical-text-code',
    italic: 'notes-lexical-text-italic',
    strikethrough: 'notes-lexical-text-strikethrough',
  },
} satisfies EditorThemeClasses

const IMAGE_MARKDOWN_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => {
    if (!$isImageNode(node)) {
      return null
    }

    return `![${escapeImageAltText(node.getAltText())}](${node.getSrc()})`
  },
  importRegExp: /!\[([^\]]*)\]\(([^()\s]+)\)/,
  regExp: /!\[([^\]]*)\]\(([^()\s]+)\)$/,
  replace: (node, match) => {
    const altText = match[1] ?? ''
    const src = match[2] ?? ''
    if (!src) {
      return
    }

    node.replace($createImageNode({ altText, src }))
  },
  trigger: ')',
  type: 'text-match',
}

export const NOTES_EDITOR_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  CODE,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  IMAGE_MARKDOWN_TRANSFORMER,
  LINK,
]

const NOTES_EDITOR_NODES = [CodeNode, HeadingNode, ImageNode, LinkNode, ListItemNode, ListNode, QuoteNode]

export const NotesMarkdownEditor = memo(function NotesMarkdownEditor({
  editorId,
  wsUrl,
  markdown,
  onChange,
  placeholder = 'Start writing...',
  editorRef,
}: NotesMarkdownEditorProps) {
  const normalizedMarkdown = normalizeEditorMarkdown(markdown)
  const onChangeRef = useRef(onChange)
  const lastPublishedMarkdownRef = useRef(normalizedMarkdown)

  const [statusError, setStatusError] = useState<string | null>(null)
  const [uploadCount, setUploadCount] = useState(0)

  onChangeRef.current = onChange

  const statusText = uploadCount > 0 ? `Uploading ${uploadCount} image${uploadCount === 1 ? '' : 's'}...` : statusError

  return (
    <NotesImageContext.Provider value={{ wsUrl }}>
      <LexicalComposer
        initialConfig={{
          editable: true,
          editorState: () => {
            $convertFromMarkdownString(normalizedMarkdown, NOTES_EDITOR_TRANSFORMERS)
          },
          namespace: `notes:${editorId}`,
          nodes: NOTES_EDITOR_NODES,
          onError: (error) => {
            throw error
          },
          theme: NOTES_EDITOR_THEME,
        }}
      >
        {editorRef ? <EditorRefPlugin editorRef={editorRef} /> : null}
        <NotesMarkdownSyncPlugin
          lastPublishedMarkdownRef={lastPublishedMarkdownRef}
          markdown={normalizedMarkdown}
        />
        <NotesMarkdownChangePlugin
          lastPublishedMarkdownRef={lastPublishedMarkdownRef}
          onChangeRef={onChangeRef}
        />
        <NotesImageUploadPlugin
          setStatusError={setStatusError}
          setUploadCount={setUploadCount}
          wsUrl={wsUrl}
        />
        <ListPlugin />
        <CheckListPlugin />
        <LinkPlugin />
        <ClickableLinkPlugin newTab />
        <MarkdownShortcutPlugin transformers={NOTES_EDITOR_TRANSFORMERS} />

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          {statusText ? (
            <div
              className={cn(
                IMAGE_UPLOAD_STATUS_CONTAINER_CLASS_NAME,
                uploadCount > 0
                  ? 'border-border/70 bg-background/95 text-foreground'
                  : 'border-destructive/20 bg-destructive/10 text-destructive',
              )}
            >
              {uploadCount > 0 ? <Loader2 className="size-3.5 animate-spin" /> : null}
              <span>{statusText}</span>
            </div>
          ) : null}

          <div className="notes-lexical-scroll-area min-h-0 flex-1 overflow-y-auto">
            <div className="notes-lexical-shell">
              <RichTextPlugin
                ErrorBoundary={LexicalErrorBoundary}
                contentEditable={
                  <ContentEditable
                    aria-label="Notes editor"
                    className="notes-lexical-editor outline-none"
                    spellCheck
                  />
                }
                placeholder={<div className="notes-lexical-placeholder">{placeholder}</div>}
              />
            </div>
          </div>

          <NotesToolbarPlugin />
        </div>
      </LexicalComposer>
    </NotesImageContext.Provider>
  )
})

function NotesMarkdownSyncPlugin({
  markdown,
  lastPublishedMarkdownRef,
}: {
  markdown: string
  lastPublishedMarkdownRef: MutableRefObject<string>
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    if (markdown === lastPublishedMarkdownRef.current) {
      return
    }

    const currentMarkdown = readEditorMarkdown(editor)
    if (currentMarkdown === markdown) {
      lastPublishedMarkdownRef.current = markdown
      return
    }

    lastPublishedMarkdownRef.current = markdown
    editor.update(
      () => {
        $convertFromMarkdownString(markdown, NOTES_EDITOR_TRANSFORMERS)
      },
      { tag: NOTES_SYNC_TAG },
    )
  }, [editor, lastPublishedMarkdownRef, markdown])

  return null
}

function NotesMarkdownChangePlugin({
  lastPublishedMarkdownRef,
  onChangeRef,
}: {
  lastPublishedMarkdownRef: MutableRefObject<string>
  onChangeRef: MutableRefObject<(markdown: string) => void>
}) {
  return (
    <OnChangePlugin
      ignoreSelectionChange
      onChange={(editorState, _editor, tags) => {
        if (tags.has(NOTES_SYNC_TAG)) {
          return
        }

        editorState.read(() => {
          const nextMarkdown = normalizeEditorMarkdown($convertToMarkdownString(NOTES_EDITOR_TRANSFORMERS))
          if (nextMarkdown === lastPublishedMarkdownRef.current) {
            return
          }

          lastPublishedMarkdownRef.current = nextMarkdown
          startTransition(() => {
            onChangeRef.current(nextMarkdown)
          })
        })
      }}
    />
  )
}

function NotesImageUploadPlugin({
  wsUrl,
  setStatusError,
  setUploadCount,
}: {
  wsUrl: string
  setStatusError: (value: string | null) => void
  setUploadCount: (value: number | ((current: number) => number)) => void
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(
    () =>
      editor.registerCommand(
        DRAG_DROP_PASTE,
        (files) => {
          const imageFiles = files.filter((file) => file.type.startsWith('image/'))
          if (imageFiles.length === 0) {
            return false
          }

          setStatusError(null)
          setUploadCount((count) => count + imageFiles.length)

          void Promise.all(
            imageFiles.map(async (file) => ({
              altText: resolveImageAltText(file),
              src: await uploadNoteAttachment(wsUrl, file),
            })),
          )
            .then((uploads) => {
              editor.update(() => {
                $insertNodes(uploads.map((upload) => $createImageNode(upload)))
              })
            })
            .catch((error) => {
              setStatusError(toErrorMessage(error, 'Unable to upload image.'))
            })
            .finally(() => {
              setUploadCount((count) => Math.max(0, count - imageFiles.length))
            })

          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, setStatusError, setUploadCount, wsUrl],
  )

  return null
}

function NotesToolbarPlugin() {
  const [editor] = useLexicalComposerContext()
  const [toolbarState, setToolbarState] = useState(DEFAULT_TOOLBAR_STATE)

  useEffect(() => {
    const updateToolbarState = (nextState: ToolbarState) => {
      setToolbarState((currentState) => (isToolbarStateEqual(currentState, nextState) ? currentState : nextState))
    }

    updateToolbarState(editor.getEditorState().read(readToolbarState))

    return mergeRegister(
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          updateToolbarState(editor.getEditorState().read(readToolbarState))
          return false
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerUpdateListener(({ editorState }) => {
        updateToolbarState(editorState.read(readToolbarState))
      }),
    )
  }, [editor])

  const handleToggleHeading = (tag: HeadingTagType) => {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }

      if (toolbarState.blockType === tag) {
        $setBlocksType(selection, () => $createParagraphNode())
        return
      }

      unwrapListIfNeeded(selection)
      $setBlocksType(selection, () => $createHeadingNode(tag))
    })
  }

  const handleToggleList = (listType: ListType) => {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }

      if (toolbarState.blockType === listType) {
        $removeList()
        return
      }

      $insertList(listType)
    })
  }

  const handleToggleQuote = () => {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }

      if (toolbarState.blockType === 'quote') {
        $setBlocksType(selection, () => $createParagraphNode())
        return
      }

      unwrapListIfNeeded(selection)
      $setBlocksType(selection, () => $createQuoteNode())
    })
  }

  const handleToggleCodeBlock = () => {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }

      if (toolbarState.blockType === 'code') {
        $setBlocksType(selection, () => $createParagraphNode())
        return
      }

      unwrapListIfNeeded(selection)
      $setBlocksType(selection, () => $createCodeNode())
    })
  }

  const handleToggleLink = () => {
    const initialValue = toolbarState.linkUrl ?? 'https://'
    const nextUrl = window.prompt('Enter a link URL', initialValue)
    if (nextUrl === null) {
      return
    }

    const trimmedUrl = nextUrl.trim()
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, trimmedUrl.length > 0 ? trimmedUrl : null)
  }

  return (
    <div className="notes-lexical-toolbar-shell">
      <div className="notes-lexical-toolbar-track">
        <div className="notes-lexical-toolbar">
          <ToolbarButton
            active={toolbarState.isBold}
            aria-label="Bold"
            disabled={!toolbarState.hasSelection}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
            title="Bold"
          >
            <BoldIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.isItalic}
            aria-label="Italic"
            disabled={!toolbarState.hasSelection}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
            title="Italic"
          >
            <ItalicIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.isStrikethrough}
            aria-label="Strikethrough"
            disabled={!toolbarState.hasSelection}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')}
            title="Strikethrough"
          >
            <StrikethroughIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.isInlineCode}
            aria-label="Inline code"
            disabled={!toolbarState.hasSelection}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}
            title="Inline code"
          >
            <InlineCodeIcon />
          </ToolbarButton>

          <Separator className="mx-1 h-5 bg-border/50" orientation="vertical" />

          <ToolbarButton
            active={toolbarState.blockType === 'h1'}
            aria-label="Heading 1"
            disabled={!toolbarState.hasSelection}
            onClick={() => handleToggleHeading('h1')}
            title="Heading 1"
          >
            <Heading1Icon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.blockType === 'h2'}
            aria-label="Heading 2"
            disabled={!toolbarState.hasSelection}
            onClick={() => handleToggleHeading('h2')}
            title="Heading 2"
          >
            <Heading2Icon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.blockType === 'h3'}
            aria-label="Heading 3"
            disabled={!toolbarState.hasSelection}
            onClick={() => handleToggleHeading('h3')}
            title="Heading 3"
          >
            <Heading3Icon />
          </ToolbarButton>

          <Separator className="mx-1 h-5 bg-border/50" orientation="vertical" />

          <ToolbarButton
            active={toolbarState.blockType === 'bullet'}
            aria-label="Bullet list"
            disabled={!toolbarState.hasSelection}
            onClick={() => handleToggleList('bullet')}
            title="Bullet list"
          >
            <BulletListIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.blockType === 'number'}
            aria-label="Ordered list"
            disabled={!toolbarState.hasSelection}
            onClick={() => handleToggleList('number')}
            title="Ordered list"
          >
            <OrderedListIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.blockType === 'check'}
            aria-label="Checklist"
            disabled={!toolbarState.hasSelection}
            onClick={() => handleToggleList('check')}
            title="Checklist"
          >
            <ChecklistIcon />
          </ToolbarButton>

          <Separator className="mx-1 h-5 bg-border/50" orientation="vertical" />

          <ToolbarButton
            active={toolbarState.blockType === 'code'}
            aria-label="Code block"
            disabled={!toolbarState.hasSelection}
            onClick={handleToggleCodeBlock}
            title="Code block"
          >
            <CodeBlockIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.blockType === 'quote'}
            aria-label="Blockquote"
            disabled={!toolbarState.hasSelection}
            onClick={handleToggleQuote}
            title="Blockquote"
          >
            <QuoteIcon />
          </ToolbarButton>
          <ToolbarButton
            active={toolbarState.linkUrl !== null}
            aria-label="Link"
            disabled={!toolbarState.hasSelection}
            onClick={handleToggleLink}
            title="Link"
          >
            <LinkIcon />
          </ToolbarButton>
        </div>
      </div>
    </div>
  )
}

function ToolbarButton({
  active,
  children,
  className,
  onMouseDown,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size'> & {
  active?: boolean
}) {
  return (
    <Button
      {...props}
      className={cn('notes-lexical-toolbar-button', active && 'notes-lexical-toolbar-button-active', className)}
      onMouseDown={(event) => {
        event.preventDefault()
        onMouseDown?.(event)
      }}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  )
}

function readToolbarState(): ToolbarState {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) && !$isNodeSelection(selection)) {
    return DEFAULT_TOOLBAR_STATE
  }

  return {
    blockType: getSelectionBlockType(selection),
    hasSelection: true,
    isBold: $isRangeSelection(selection) ? selection.hasFormat('bold') : false,
    isInlineCode: $isRangeSelection(selection) ? selection.hasFormat('code') : false,
    isItalic: $isRangeSelection(selection) ? selection.hasFormat('italic') : false,
    isStrikethrough: $isRangeSelection(selection) ? selection.hasFormat('strikethrough') : false,
    linkUrl: getSelectionLinkUrl(selection),
  }
}

function getSelectionBlockType(selection: NodeSelection | RangeSelection): ToolbarBlockType {
  const anchorNode = getSelectionAnchorNode(selection)
  const listNode = $findMatchingParent(anchorNode, $isListNode)
  if ($isListNode(listNode)) {
    return listNode.getListType()
  }

  const topLevelElement = $isRootOrShadowRoot(anchorNode)
    ? anchorNode.getChildAtIndex(0) ?? $getRoot()
    : anchorNode.getTopLevelElementOrThrow()

  if ($isHeadingNode(topLevelElement)) {
    const tag = topLevelElement.getTag()
    return tag === 'h1' || tag === 'h2' || tag === 'h3' ? tag : 'paragraph'
  }

  if ($isQuoteNode(topLevelElement)) {
    return 'quote'
  }

  if ($isCodeNode(topLevelElement)) {
    return 'code'
  }

  return 'paragraph'
}

function getSelectionLinkUrl(selection: NodeSelection | RangeSelection): string | null {
  const nodes = $isRangeSelection(selection)
    ? [selection.anchor.getNode(), selection.focus.getNode()]
    : selection.getNodes()

  for (const node of nodes) {
    if ($isLinkNode(node)) {
      return node.getURL()
    }

    const parentLinkNode = $findMatchingParent(node, $isLinkNode)
    if ($isLinkNode(parentLinkNode)) {
      return parentLinkNode.getURL()
    }
  }

  return null
}

function getSelectionAnchorNode(selection: NodeSelection | RangeSelection) {
  if ($isRangeSelection(selection)) {
    return selection.anchor.getNode()
  }

  return selection.getNodes()[0] ?? $getRoot()
}

function unwrapListIfNeeded(selection: RangeSelection): void {
  if (getSelectionBlockType(selection) === 'bullet' || getSelectionBlockType(selection) === 'number' || getSelectionBlockType(selection) === 'check') {
    $removeList()
  }
}

function isToolbarStateEqual(left: ToolbarState, right: ToolbarState): boolean {
  return (
    left.blockType === right.blockType &&
    left.hasSelection === right.hasSelection &&
    left.isBold === right.isBold &&
    left.isInlineCode === right.isInlineCode &&
    left.isItalic === right.isItalic &&
    left.isStrikethrough === right.isStrikethrough &&
    left.linkUrl === right.linkUrl
  )
}

function readEditorMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => normalizeEditorMarkdown($convertToMarkdownString(NOTES_EDITOR_TRANSFORMERS)))
}

function normalizeEditorMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (normalized.trim().length === 0) {
    return ''
  }

  return `${normalized.replace(/\n+$/, '')}\n`
}

function escapeImageAltText(altText: string): string {
  return altText.replace(/]/g, '\\]')
}

function resolveImageAltText(file: File): string {
  const trimmedName = file.name.trim()
  if (!trimmedName) {
    return 'image'
  }

  const baseName = trimmedName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return baseName || 'image'
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return fallback
}
