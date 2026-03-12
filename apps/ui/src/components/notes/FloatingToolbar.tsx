import { $createCodeNode, $isCodeNode } from '@lexical/code'
import { $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link'
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
  type ListType,
} from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $setBlocksType } from '@lexical/selection'
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
} from '@lexical/rich-text'
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  mergeRegister,
  type LexicalEditor,
  type LexicalNode,
  type TextFormatType,
} from 'lexical'
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
  SquareCode,
  Strikethrough,
  TextQuote,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type BlockType = 'paragraph' | 'h1' | 'h2' | 'h3' | 'quote' | 'code'
type ToolbarPlacement = 'above' | 'below'

interface ToolbarState {
  blockType: BlockType
  isBold: boolean
  isCode: boolean
  isItalic: boolean
  isLink: boolean
  isStrikethrough: boolean
  left: number
  listType: ListType | null
  placement: ToolbarPlacement
  top: number
  visible: boolean
}

const INITIAL_TOOLBAR_STATE: ToolbarState = {
  blockType: 'paragraph',
  isBold: false,
  isCode: false,
  isItalic: false,
  isLink: false,
  isStrikethrough: false,
  left: 0,
  listType: null,
  placement: 'above',
  top: 0,
  visible: false,
}

function getSelectionRect(nativeSelection: Selection): DOMRect | null {
  if (nativeSelection.rangeCount === 0) {
    return null
  }

  const range = nativeSelection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  if (rect.width > 0 || rect.height > 0) {
    return rect
  }

  const clientRects = Array.from(range.getClientRects())
  return clientRects[0] ?? null
}

function getNearestListNode(node: LexicalNode | null) {
  let current = node
  while (current !== null) {
    if ($isListNode(current)) {
      return current
    }
    current = current.getParent()
  }

  return null
}

function getNearestLinkNode(node: LexicalNode | null) {
  let current = node
  while (current !== null) {
    if ($isLinkNode(current)) {
      return current
    }
    current = current.getParent()
  }

  return null
}

function getSelectionBlockType(node: LexicalNode): BlockType {
  const block = node.getTopLevelElementOrThrow()

  if ($isHeadingNode(block)) {
    const tag = block.getTag()
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      return tag
    }
  }

  if ($isQuoteNode(block)) {
    return 'quote'
  }

  if ($isCodeNode(block)) {
    return 'code'
  }

  return 'paragraph'
}

function toggleToolbarBlockType(editor: LexicalEditor, blockType: Exclude<BlockType, 'paragraph'>) {
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      return
    }

    const currentBlockType = getSelectionBlockType(selection.anchor.getNode())
    if (currentBlockType === blockType) {
      $setBlocksType(selection, () => $createParagraphNode())
      return
    }

    switch (blockType) {
      case 'h1':
      case 'h2':
      case 'h3':
        $setBlocksType(selection, () => $createHeadingNode(blockType))
        break
      case 'quote':
        $setBlocksType(selection, () => $createQuoteNode())
        break
      case 'code':
        $setBlocksType(selection, () => $createCodeNode())
        break
    }
  })
}

function FloatingToolbarButton({
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
        'rounded-full border-0 bg-transparent text-popover-foreground/70 shadow-none hover:bg-accent/80 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-ring/60',
        active && 'bg-accent text-accent-foreground',
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

export function FloatingToolbar() {
  const [editor] = useLexicalComposerContext()
  const [isMounted, setIsMounted] = useState(false)
  const [toolbarState, setToolbarState] = useState(INITIAL_TOOLBAR_STATE)
  const animationFrameRef = useRef<number | null>(null)

  const hideToolbar = useCallback(() => {
    setToolbarState((current) => {
      if (!current.visible) {
        return current
      }

      return {
        ...current,
        visible: false,
      }
    })
  }, [])

  const updateToolbar = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }

    const rootElement = editor.getRootElement()
    const nativeSelection = window.getSelection()
    if (rootElement === null || nativeSelection === null || nativeSelection.rangeCount === 0) {
      hideToolbar()
      return
    }

    const anchorNode = nativeSelection.anchorNode
    const focusNode = nativeSelection.focusNode
    if (
      anchorNode === null ||
      focusNode === null ||
      !rootElement.contains(anchorNode) ||
      !rootElement.contains(focusNode)
    ) {
      hideToolbar()
      return
    }

    const rect = getSelectionRect(nativeSelection)
    if (rect === null || rect.bottom < 0 || rect.top > window.innerHeight) {
      hideToolbar()
      return
    }

    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed() || selection.getTextContent().length === 0) {
        hideToolbar()
        return
      }

      const selectionAnchorNode = selection.anchor.getNode()
      const listNode = getNearestListNode(selectionAnchorNode)
      const linkNode = getNearestLinkNode(selectionAnchorNode)
      const placement: ToolbarPlacement = rect.top < 84 ? 'below' : 'above'

      setToolbarState({
        blockType: getSelectionBlockType(selectionAnchorNode),
        isBold: selection.hasFormat('bold'),
        isCode: selection.hasFormat('code'),
        isItalic: selection.hasFormat('italic'),
        isLink: linkNode !== null,
        isStrikethrough: selection.hasFormat('strikethrough'),
        left: Math.min(Math.max(rect.left + rect.width / 2, 16), window.innerWidth - 16),
        listType: listNode?.getListType() ?? null,
        placement,
        top: placement === 'above' ? rect.top : rect.bottom,
        visible: true,
      })
    })
  }, [editor, hideToolbar])

  const scheduleToolbarUpdate = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
    }

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null
      updateToolbar()
    })
  }, [updateToolbar])

  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(() => {
        scheduleToolbarUpdate()
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          scheduleToolbarUpdate()
          return false
        },
        COMMAND_PRIORITY_LOW,
      ),
    )
  }, [editor, scheduleToolbarUpdate])

  useEffect(() => {
    const handleViewportChange = () => {
      scheduleToolbarUpdate()
    }

    window.addEventListener('resize', handleViewportChange)
    document.addEventListener('scroll', handleViewportChange, true)

    return () => {
      window.removeEventListener('resize', handleViewportChange)
      document.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [scheduleToolbarUpdate])

  const handleToolbarMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
  }, [])

  const toggleInlineFormat = useCallback(
    (format: TextFormatType) => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, format)
    },
    [editor],
  )

  const toggleList = useCallback(
    (listType: ListType) => {
      let activeListType: ListType | null = null

      editor.getEditorState().read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }

        activeListType = getNearestListNode(selection.anchor.getNode())?.getListType() ?? null
      })

      if (activeListType === listType) {
        editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)
        return
      }

      switch (listType) {
        case 'check':
          editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)
          break
        case 'bullet':
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
          break
        case 'number':
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
          break
      }
    },
    [editor],
  )

  const toggleLink = useCallback(() => {
    let activeLinkUrl: string | null = null

    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }

      activeLinkUrl = getNearestLinkNode(selection.anchor.getNode())?.getURL() ?? null
    })

    if (activeLinkUrl !== null) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)
      return
    }

    const nextUrl = window.prompt('Enter a URL', 'https://')
    if (nextUrl === null) {
      return
    }

    const normalizedUrl = nextUrl.trim()
    if (normalizedUrl.length === 0) {
      return
    }

    editor.focus()
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, normalizedUrl)
  }, [editor])

  if (!isMounted) {
    return null
  }

  const transform =
    toolbarState.placement === 'above'
      ? toolbarState.visible
        ? 'translate(-50%, calc(-100% - 12px))'
        : 'translate(-50%, calc(-100% - 6px))'
      : toolbarState.visible
        ? 'translate(-50%, 12px)'
        : 'translate(-50%, 6px)'

  return createPortal(
    <div
      aria-hidden={!toolbarState.visible}
      aria-label="Text formatting toolbar"
      className={cn(
        'fixed z-50 flex max-w-[calc(100vw-24px)] items-center gap-0.5 overflow-x-auto rounded-full border border-border/60 bg-popover/95 px-1.5 py-1 text-popover-foreground shadow-lg shadow-black/15 backdrop-blur-md [scrollbar-width:none] transition-[opacity,transform] duration-150 ease-out will-change-[opacity,transform] [&::-webkit-scrollbar]:hidden',
        toolbarState.visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
      )}
      onMouseDown={handleToolbarMouseDown}
      role="toolbar"
      style={{
        left: toolbarState.left,
        top: toolbarState.top,
        transform,
      }}
    >
      <div className="flex items-center gap-0.5">
        <FloatingToolbarButton
          active={toolbarState.isBold}
          label="Bold"
          onClick={() => {
            toggleInlineFormat('bold')
          }}
        >
          <Bold />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.isItalic}
          label="Italic"
          onClick={() => {
            toggleInlineFormat('italic')
          }}
        >
          <Italic />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.isStrikethrough}
          label="Strikethrough"
          onClick={() => {
            toggleInlineFormat('strikethrough')
          }}
        >
          <Strikethrough />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.isCode}
          label="Inline code"
          onClick={() => {
            toggleInlineFormat('code')
          }}
        >
          <Code />
        </FloatingToolbarButton>
      </div>

      <Separator className="mx-0.5 h-4 bg-border/50" orientation="vertical" />

      <div className="flex items-center gap-0.5">
        <FloatingToolbarButton
          active={toolbarState.blockType === 'h1'}
          label="Heading 1"
          onClick={() => {
            toggleToolbarBlockType(editor, 'h1')
          }}
        >
          <Heading1 />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.blockType === 'h2'}
          label="Heading 2"
          onClick={() => {
            toggleToolbarBlockType(editor, 'h2')
          }}
        >
          <Heading2 />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.blockType === 'h3'}
          label="Heading 3"
          onClick={() => {
            toggleToolbarBlockType(editor, 'h3')
          }}
        >
          <Heading3 />
        </FloatingToolbarButton>
      </div>

      <Separator className="mx-0.5 h-4 bg-border/50" orientation="vertical" />

      <div className="flex items-center gap-0.5">
        <FloatingToolbarButton
          active={toolbarState.listType === 'check'}
          label="Checklist"
          onClick={() => {
            toggleList('check')
          }}
        >
          <ListTodo />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.listType === 'bullet'}
          label="Bullet list"
          onClick={() => {
            toggleList('bullet')
          }}
        >
          <List />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.listType === 'number'}
          label="Ordered list"
          onClick={() => {
            toggleList('number')
          }}
        >
          <ListOrdered />
        </FloatingToolbarButton>
      </div>

      <Separator className="mx-0.5 h-4 bg-border/50" orientation="vertical" />

      <div className="flex items-center gap-0.5">
        <FloatingToolbarButton
          active={toolbarState.blockType === 'code'}
          label="Code block"
          onClick={() => {
            toggleToolbarBlockType(editor, 'code')
          }}
        >
          <SquareCode />
        </FloatingToolbarButton>
        <FloatingToolbarButton
          active={toolbarState.blockType === 'quote'}
          label="Quote"
          onClick={() => {
            toggleToolbarBlockType(editor, 'quote')
          }}
        >
          <TextQuote />
        </FloatingToolbarButton>
        <FloatingToolbarButton active={toolbarState.isLink} label="Link" onClick={toggleLink}>
          <Link2 />
        </FloatingToolbarButton>
      </div>
    </div>,
    document.body,
  )
}
