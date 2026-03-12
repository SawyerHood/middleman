/** @vitest-environment jsdom */

import { fireEvent, getByAltText, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotesMarkdownEditor } from './NotesMarkdownEditor'

vi.mock('./FloatingToolbar', () => ({
  FloatingToolbar: () => null,
}))

let container!: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderEditor(props: {
  editorId: string
  markdown: string
  onChange: (markdown: string) => void
  wsUrl: string
}) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(createElement(NotesMarkdownEditor, props))
  })
}

describe('NotesMarkdownEditor', () => {
  it('renders attachment and absolute-url markdown images as img elements', async () => {
    renderEditor({
      editorId: 'images.md',
      markdown: ['![Attachment](attachments/uploaded.png)', '', '![External](https://example.com/image.png)'].join(
        '\n',
      ),
      onChange: vi.fn(),
      wsUrl: 'ws://127.0.0.1:47187',
    })

    await waitFor(() => {
      expect(getByAltText(container, 'Attachment').getAttribute('src')).toBe(
        'http://127.0.0.1:47187/api/notes/attachments/uploaded.png',
      )
      expect(getByAltText(container, 'External').getAttribute('src')).toBe('https://example.com/image.png')
    })
  })

  it('uploads pasted images and inserts markdown after the upload completes', async () => {
    let resolveResponse: ((response: Response) => void) | undefined

    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve
          }),
      ),
    )

    renderEditor({
      editorId: 'paste.md',
      markdown: '',
      onChange: vi.fn(),
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const editor = container.querySelector('[contenteditable="true"]')
    expect(editor).not.toBeNull()
    if (!editor) {
      return
    }

    const file = new File(['image-data'], 'holiday-shot.png', { type: 'image/png' })

    fireEvent.paste(editor, {
      clipboardData: {
        files: [file],
        items: [
          {
            getAsFile: () => file,
            kind: 'file',
            type: 'image/png',
          },
        ],
        types: ['Files'],
      },
    })

    await waitFor(() => {
      expect(getByText(container, 'Uploading 1 image...')).not.toBeNull()
    })

    resolveResponse?.(
      new Response(JSON.stringify({ path: 'attachments/1700000000000-uploaded.png' }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
        status: 201,
      }),
    )

    await waitFor(() => {
      expect(getByAltText(container, 'holiday shot').getAttribute('src')).toBe(
        'http://127.0.0.1:47187/api/notes/attachments/1700000000000-uploaded.png',
      )
    })

    await waitFor(() => {
      expect(queryByText(container, 'Uploading 1 image...')).toBeNull()
    })
  })
})
