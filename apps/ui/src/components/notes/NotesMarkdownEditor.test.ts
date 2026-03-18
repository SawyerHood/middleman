/** @vitest-environment jsdom */

import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown'
import { DRAG_DROP_PASTE } from '@lexical/rich-text'
import { getByRole, waitFor } from '@testing-library/dom'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $nodesOfType,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from 'lexical'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { $createListItemNode, $createListNode, ListItemNode } from '@lexical/list'

const mocks = vi.hoisted(() => ({
  resolveNoteImageUrl: vi.fn((_wsUrl: string, src: string) => `resolved:${src}`),
  uploadNoteAttachment: vi.fn(),
}))

vi.mock('./notes-api', () => ({
  resolveNoteImageUrl: mocks.resolveNoteImageUrl,
  uploadNoteAttachment: mocks.uploadNoteAttachment,
}))

import { NOTES_EDITOR_TRANSFORMERS, NotesMarkdownEditor } from './NotesMarkdownEditor'

let container!: HTMLDivElement
let root: Root | null = null

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container?.remove()
  vi.clearAllMocks()
})

describe('NotesMarkdownEditor', () => {
  it('loads markdown into Lexical, including checklists and image nodes', async () => {
    const editorRef = createEditorRef()

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: '# Hello\n\n- [x] done\n\n![Cat](attachments/cat.png)\n',
      onChange: vi.fn(),
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)

    expect(getByRole(container, 'heading', { level: 1, name: 'Hello' })).toBeTruthy()
    expect(container.querySelector('[role="checkbox"][aria-checked="true"]')).toBeTruthy()

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('resolved:attachments/cat.png')
    expect(mocks.resolveNoteImageUrl).toHaveBeenCalledWith('ws://127.0.0.1:47187', 'attachments/cat.png')

    const exportedMarkdown = editor.getEditorState().read(() => $convertToMarkdownString(NOTES_EDITOR_TRANSFORMERS))
    expect(exportedMarkdown).toBe('# Hello\n\n- [x] done\n\n![Cat](attachments/cat.png)')
  })

  it('publishes markdown changes back to the parent', async () => {
    const editorRef = createEditorRef()
    const onChange = vi.fn()

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: '',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)

    editor.update(() => {
      $convertFromMarkdownString('## Updated\n\n- [x] done', NOTES_EDITOR_TRANSFORMERS)
    })

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('## Updated\n\n- [x] done\n')
    })
  })

  it('converts "- [ ]" into an interactive checklist when space is typed', async () => {
    const editorRef = createEditorRef()
    const onChange = vi.fn()

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: '',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)

    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('- [ ]'))
      $getRoot().clear()
      $getRoot().append(paragraph)
      paragraph.selectEnd()
    })

    await flushMicrotasks()
    onChange.mockClear()

    const preventDefault = vi.fn()
    editor.dispatchCommand(KEY_SPACE_COMMAND, { preventDefault } as unknown as KeyboardEvent)

    await waitFor(() => {
      expect(container.querySelector('[role="checkbox"][aria-checked="false"]')).toBeTruthy()
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(editor.getEditorState().read(() => $convertToMarkdownString(NOTES_EDITOR_TRANSFORMERS))).toBe('- [ ] ')
    expect(onChange).toHaveBeenLastCalledWith('- [ ] \n')
  })

  it('converts "[ ]" at the start of an existing bullet list item into a checklist item', async () => {
    const editorRef = createEditorRef()
    const onChange = vi.fn()

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: '',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)

    editor.update(() => {
      const bulletList = $createListNode('bullet')
      bulletList.append($createListItemNode().append($createTextNode('first')))
      const pendingItem = $createListItemNode().append($createTextNode('[ ]'))
      bulletList.append(pendingItem)
      $getRoot().clear()
      $getRoot().append(bulletList)

      const textNode = pendingItem.getChildren().find($isTextNode)
      if (!$isTextNode(textNode)) {
        throw new Error('Expected pending list item to contain a text node')
      }

      textNode.selectEnd()
    })

    await flushMicrotasks()
    onChange.mockClear()

    const preventDefault = vi.fn()
    editor.dispatchCommand(KEY_SPACE_COMMAND, { preventDefault } as unknown as KeyboardEvent)

    await waitFor(() => {
      expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1)
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(editor.getEditorState().read(() => $convertToMarkdownString(NOTES_EDITOR_TRANSFORMERS))).toBe('- first\n\n- [ ] ')
    expect(onChange).toHaveBeenLastCalledWith('- first\n\n- [ ] \n')
  })

  it('uploads pasted or dropped images through the notes API and inserts markdown-backed image nodes', async () => {
    const editorRef = createEditorRef()
    const onChange = vi.fn()
    const file = new File(['image'], 'cat-photo.png', { type: 'image/png' })

    mocks.uploadNoteAttachment.mockResolvedValue('attachments/cat.png')

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: '',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)
    editor.dispatchCommand(DRAG_DROP_PASTE, [file])

    await waitFor(() => {
      expect(mocks.uploadNoteAttachment).toHaveBeenCalledWith('ws://127.0.0.1:47187', file)
    })

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('![cat photo](attachments/cat.png)\n')
    })

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('resolved:attachments/cat.png')
  })

  it('indents list items with Tab and outdents them with Shift+Tab', async () => {
    const editorRef = createEditorRef()
    const onChange = vi.fn()

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: '- first\n- second\n',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)

    selectListItemText(editor, 'second')

    const indentEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' })
    editor.dispatchCommand(KEY_TAB_COMMAND, indentEvent)

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('- first\n    - second\n')
    })
    expect(indentEvent.defaultPrevented).toBe(true)

    selectListItemText(editor, 'second')

    const outdentEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab', shiftKey: true })
    editor.dispatchCommand(KEY_TAB_COMMAND, outdentEvent)

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('- first\n- second\n')
    })
    expect(outdentEvent.defaultPrevented).toBe(true)
  })

  it('registers undo history so undo restores the previous markdown state', async () => {
    const editorRef = createEditorRef()
    const onChange = vi.fn()

    await mountEditor({
      editorId: 'note-1',
      editorRef,
      markdown: 'Initial\n',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = await waitForEditor(editorRef)

    editor.update(() => {
      $convertFromMarkdownString('Updated', NOTES_EDITOR_TRANSFORMERS)
    })

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('Updated\n')
    })

    editor.dispatchCommand(UNDO_COMMAND, undefined)

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('Initial\n')
    })
  })
})

async function mountEditor(props: Parameters<typeof NotesMarkdownEditor>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  flushSync(() => {
    root?.render(createElement(NotesMarkdownEditor, props))
  })

  await flushMicrotasks()
}

function createEditorRef() {
  return {
    current: null as LexicalEditor | null,
  }
}

async function waitForEditor(editorRef: { current: LexicalEditor | null }) {
  await waitFor(() => {
    expect(editorRef.current).not.toBeNull()
  })

  return editorRef.current as LexicalEditor
}

function selectListItemText(editor: LexicalEditor, itemText: string) {
  editor.update(() => {
    const listItem = $nodesOfType(ListItemNode).find((node) => node.getTextContent() === itemText)
    if (!listItem) {
      throw new Error(`Unable to find list item "${itemText}"`)
    }

    const textNode = listItem.getChildren().find($isTextNode)
    if (!$isTextNode(textNode)) {
      throw new Error(`List item "${itemText}" does not contain a text node`)
    }

    textNode.selectEnd()
  })
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}
