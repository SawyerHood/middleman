/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesView } from './NotesView'

const NOTES_EXPLORER_COLLAPSED_STORAGE_KEY = 'middleman:notes:explorer-collapsed'

const notesApiMocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  deleteNote: vi.fn(),
  fetchNote: vi.fn(),
  fetchNoteTree: vi.fn(),
  renameNote: vi.fn(),
  saveNote: vi.fn(),
}))

vi.mock('@/components/notes/notes-api', () => notesApiMocks)

vi.mock('@/components/notes/NotesMarkdownEditor', () => ({
  NotesMarkdownEditor: ({
    markdown,
  }: {
    editorId: string
    markdown: string
    onChange: (value: string) => void
  }) => createElement('div', { 'data-testid': 'notes-editor' }, markdown),
}))

class ResizeObserverMock {
  constructor(_callback: ResizeObserverCallback) {}

  disconnect() {}

  observe() {}

  unobserve() {}
}

function createNoteSummary(path: string) {
  const name = path.split('/').at(-1) ?? path
  const title = name.replace(/\.md$/i, '').replace(/[-_]/g, ' ')

  return {
    path,
    name,
    title,
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
    sizeBytes: 18,
  }
}

function createNoteDocument(path: string, content?: string) {
  return {
    ...createNoteSummary(path),
    content: content ?? `# ${path}\n`,
  }
}

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>()

  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
  }
}

let container!: HTMLDivElement
let root: Root | null = null

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
const originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
const originalGetAnimations = Element.prototype.getAnimations

beforeEach(() => {
  const localStorageMock = createLocalStorageMock()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorageMock,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorageMock,
  })
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverMock,
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverMock,
  })
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: vi.fn(() => []),
  })

  notesApiMocks.fetchNoteTree.mockResolvedValue([
    {
      kind: 'file',
      ...createNoteSummary('first.md'),
    },
  ])
  notesApiMocks.fetchNote.mockImplementation(async (_wsUrl: string, path: string) =>
    createNoteDocument(path, path === 'first.md' ? '# First note\n' : `# ${path}\n`),
  )
  notesApiMocks.saveNote.mockImplementation(async (_wsUrl: string, path: string, content: string) => ({
    path,
    name: path.split('/').at(-1) ?? path,
    title: 'Saved note',
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
    sizeBytes: content.length,
    content,
  }))
  notesApiMocks.createFolder.mockResolvedValue({
    kind: 'folder',
    path: 'new-folder',
    name: 'new-folder',
    children: [],
  })
  notesApiMocks.renameNote.mockResolvedValue({
    path: 'first.md',
    name: 'first.md',
    title: 'First note',
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
    sizeBytes: 18,
    content: '# First note\n',
  })
  notesApiMocks.deleteNote.mockResolvedValue(undefined)
  notesApiMocks.deleteFolder.mockResolvedValue(undefined)

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
  vi.clearAllMocks()

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor)
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor)
  }

  if (originalResizeObserverDescriptor) {
    Object.defineProperty(window, 'ResizeObserver', originalResizeObserverDescriptor)
    Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserverDescriptor)
  } else {
    Reflect.deleteProperty(window, 'ResizeObserver')
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  }

  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: originalGetAnimations,
  })
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function renderNotesView() {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(NotesView, {
        wsUrl: 'ws://127.0.0.1:47187',
        onBack: vi.fn(),
        onToggleMobileSidebar: vi.fn(),
      }),
    )
  })
}

function dispatchShortcut(options: { metaKey?: boolean; ctrlKey?: boolean }) {
  fireEvent.keyDown(document, {
    key: 'p',
    bubbles: true,
    cancelable: true,
    metaKey: options.metaKey,
    ctrlKey: options.ctrlKey,
  })
}

describe('NotesView', () => {
  it('toggles the explorer from the header and persists collapse state', async () => {
    renderNotesView()

    await waitFor(() => {
      expect(getByText(container, 'first.md')).toBeTruthy()
    })

    const collapseButton = container.querySelector('button[aria-label="Collapse explorer"]')
    expect(collapseButton).toBeTruthy()
    expect(collapseButton?.getAttribute('aria-pressed')).toBe('true')

    click(collapseButton as HTMLButtonElement)

    await waitFor(() => {
      expect(window.localStorage.getItem(NOTES_EXPLORER_COLLAPSED_STORAGE_KEY)).toBe('true')
    })

    await waitFor(() => {
      expect(queryByText(container, 'first.md')).toBeNull()
      expect(container.querySelector('button[aria-label="Expand explorer"]')).toBeTruthy()
    })

    const expandButton = container.querySelector('button[aria-label="Expand explorer"]')
    expect(expandButton?.getAttribute('aria-pressed')).toBe('false')
  })

  it('starts collapsed when the saved preference is present', async () => {
    window.localStorage.setItem(NOTES_EXPLORER_COLLAPSED_STORAGE_KEY, 'true')

    renderNotesView()

    await waitFor(() => {
      expect(notesApiMocks.fetchNoteTree).toHaveBeenCalled()
    })

    const expandButton = container.querySelector('button[aria-label="Expand explorer"]')
    expect(expandButton).toBeTruthy()
    expect(expandButton?.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('button[aria-label="Collapse explorer"]')).toBeNull()
    expect(queryByText(container, 'first.md')).toBeNull()
  })

  it('opens the search palette from the keyboard shortcut and selects a matching note', async () => {
    notesApiMocks.fetchNoteTree.mockResolvedValue([
      {
        kind: 'folder',
        path: 'projects',
        name: 'projects',
        children: [
          {
            kind: 'file',
            ...createNoteSummary('projects/roadmap.md'),
          },
        ],
      },
      {
        kind: 'file',
        ...createNoteSummary('first.md'),
      },
    ])
    notesApiMocks.fetchNote.mockImplementation(async (_wsUrl: string, path: string) =>
      createNoteDocument(path, path === 'projects/roadmap.md' ? '# Roadmap\n' : '# First note\n'),
    )

    renderNotesView()

    await waitFor(() => {
      expect(getByText(container, 'first.md')).toBeTruthy()
    })

    dispatchShortcut({ ctrlKey: true })

    await waitFor(() => {
      expect(document.body.querySelector('input[aria-label="Search notes"]')).toBeTruthy()
    })

    const input = document.body.querySelector('input[aria-label="Search notes"]')
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Expected the note search input to be rendered.')
    }
    fireEvent.input(input, { target: { value: 'road' } })

    await waitFor(() => {
      expect(getByRole(document.body, 'button', { name: /projects\/roadmap/i })).toBeTruthy()
    })

    fireEvent.keyDown(input, { key: 'Enter', bubbles: true })

    await waitFor(() => {
      expect(notesApiMocks.fetchNote).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'projects/roadmap.md',
        expect.any(AbortSignal),
      )
    })

    await waitFor(() => {
      expect(container.querySelector('[data-testid="notes-editor"]')?.textContent).toBe('# Roadmap\n')
    })

    expect(getByText(container, 'projects')).toBeTruthy()
    expect(document.body.querySelector('input[aria-label="Search notes"]')).toBeNull()
  })

  it('opens the search palette from the explorer button and dismisses it with escape', async () => {
    renderNotesView()

    await waitFor(() => {
      expect(getByText(container, 'first.md')).toBeTruthy()
    })

    const searchButton = container.querySelector('button[aria-label="Search notes"]')
    expect(searchButton).toBeTruthy()

    click(searchButton as HTMLButtonElement)

    const input = document.body.querySelector('input[aria-label="Search notes"]')
    expect(input).toBeTruthy()
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Expected the note search input to be rendered.')
    }

    fireEvent.keyDown(input, { key: 'Escape', bubbles: true })

    await waitFor(() => {
      expect(document.body.querySelector('input[aria-label="Search notes"]')).toBeNull()
    })
  })
})
