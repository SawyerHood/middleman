/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  resolveDialogInitialFocus,
} from './dialog'

let container: HTMLDivElement
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
})

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
}

async function renderOpenDialog(): Promise<void> {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(
        Dialog,
        {
          open: true,
          onOpenChange: () => undefined,
        },
        createElement(
          DialogContent,
          { showCloseButton: false },
          createElement(DialogTitle, null, 'Test dialog'),
          createElement('input', {
            id: 'dialog-test-input',
          }),
        ),
      ),
    )
  })

  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

describe('DialogContent', () => {
  it('does not autofocus form fields on narrow mobile viewports', async () => {
    setViewportWidth(390)

    await renderOpenDialog()

    expect(document.activeElement?.id).not.toBe('dialog-test-input')
  })

  it('keeps autofocus enabled for desktop mouse opens', () => {
    setViewportWidth(1280)

    expect(resolveDialogInitialFocus('mouse')).toBe(true)
  })
})
