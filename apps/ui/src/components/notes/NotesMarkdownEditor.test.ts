/** @vitest-environment jsdom */

import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@milkdown/kit/core', () => ({
  Editor: {
    make: () => ({
      config() {
        return this
      },
      use() {
        return this
      },
    }),
  },
  defaultValueCtx: Symbol('defaultValueCtx'),
  editorViewCtx: Symbol('editorViewCtx'),
  editorViewOptionsCtx: Symbol('editorViewOptionsCtx'),
  rootCtx: Symbol('rootCtx'),
  serializerCtx: Symbol('serializerCtx'),
}))

vi.mock('@milkdown/kit/plugin/clipboard', () => ({ clipboard: {} }))
vi.mock('@milkdown/kit/plugin/cursor', () => ({ cursor: {} }))
vi.mock('@milkdown/kit/plugin/history', () => ({ history: {} }))
vi.mock('@milkdown/kit/plugin/indent', () => ({ indent: {} }))
vi.mock('@milkdown/kit/plugin/listener', () => ({ listener: {} }))
vi.mock('@milkdown/kit/plugin/trailing', () => ({ trailing: {} }))

vi.mock('@milkdown/kit/preset/commonmark', () => {
  const createSchema = (name: string) => ({
    node: Symbol(name),
    type: () => Symbol(`${name}-type`),
  })

  return {
    blockquoteSchema: createSchema('blockquote'),
    bulletListSchema: createSchema('bullet-list'),
    codeBlockSchema: createSchema('code-block'),
    commonmark: {},
    emphasisSchema: createSchema('emphasis'),
    headingSchema: createSchema('heading'),
    imageSchema: createSchema('image'),
    inlineCodeSchema: createSchema('inline-code'),
    linkSchema: createSchema('link'),
    listItemSchema: createSchema('list-item'),
    orderedListSchema: createSchema('ordered-list'),
    strongSchema: createSchema('strong'),
    toggleEmphasisCommand: { key: 'toggleEmphasis' },
    toggleInlineCodeCommand: { key: 'toggleInlineCode' },
    toggleLinkCommand: { key: 'toggleLink' },
    toggleStrongCommand: { key: 'toggleStrong' },
    turnIntoTextCommand: { key: 'turnIntoText' },
    wrapInHeadingCommand: { key: 'wrapInHeading' },
  }
})

vi.mock('@milkdown/kit/preset/gfm', () => ({
  gfm: {},
  toggleStrikethroughCommand: { key: 'toggleStrikethrough' },
}))

vi.mock('@milkdown/kit/prose/commands', () => ({
  lift: () => false,
  setBlockType: () => () => false,
  wrapIn: () => () => false,
}))

vi.mock('@milkdown/kit/prose/schema-list', () => ({
  liftListItem: () => () => false,
  wrapInList: () => () => false,
}))

vi.mock('@milkdown/kit/utils', () => ({
  $view: () => ({}),
  callCommand: () => () => false,
  insert: () => () => undefined,
}))

vi.mock('@milkdown/theme-nord', () => ({
  nord: () => undefined,
}))

vi.mock('@milkdown/react', async () => {
  const React = await import('react')
  const EditorContext = React.createContext<Record<string, unknown>>({})

  return {
    Milkdown: () => React.createElement('div', { 'data-testid': 'milkdown-root' }),
    MilkdownProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(
        EditorContext.Provider,
        {
          value: {
            editor: { current: undefined },
            loading: true,
            setEditorFactory: () => undefined,
          },
        },
        children,
      ),
    useEditor: () => {
      const editorInfo = React.useContext(EditorContext) as {
        editor?: { current?: unknown }
        loading?: boolean
        setEditorFactory?: (factory: unknown) => void
      }

      React.useLayoutEffect(() => {
        editorInfo.setEditorFactory?.(() => () => undefined)
      }, [editorInfo])

      return {
        get: () => editorInfo.editor!.current,
        loading: editorInfo.loading ?? false,
      }
    },
  }
})

vi.mock('@/components/notes/notes-api', () => ({
  resolveNoteImageUrl: (_wsUrl: string, src: string) => src,
  uploadNoteAttachment: vi.fn(),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: {
    children: ReactNode
  } & Record<string, unknown>) => createElement('button', props, children),
}))

vi.mock('@/components/ui/separator', () => ({
  Separator: (props: Record<string, unknown>) => createElement('div', props),
}))

import { NotesMarkdownEditor } from './NotesMarkdownEditor'

let container: HTMLDivElement
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
  it('mounts without touching the editor instance before the provider is ready', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        createElement(NotesMarkdownEditor, {
          editorId: 'note-1',
          markdown: '',
          onChange: vi.fn(),
          wsUrl: 'ws://127.0.0.1:47187',
        }),
      )
    })

    await Promise.resolve()

    expect(container.querySelector('[data-testid="milkdown-root"]')).toBeTruthy()
    expect(container.textContent).toContain('Start writing...')
  })
})
