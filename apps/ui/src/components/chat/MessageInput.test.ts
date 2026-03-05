/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageInput } from './MessageInput'

let container: HTMLDivElement
let root: Root | null = null
let originalInnerHeightDescriptor: PropertyDescriptor | undefined
let originalVisualViewportDescriptor: PropertyDescriptor | undefined

function renderInput(onSend = vi.fn()): { onSend: ReturnType<typeof vi.fn>; textarea: HTMLTextAreaElement } {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(MessageInput, {
        onSend,
        isLoading: false,
      }),
    )
  })

  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('Expected message textarea to render')
  }

  return { onSend, textarea }
}

function setViewportState({ innerHeight, visualViewportHeight }: { innerHeight: number; visualViewportHeight: number }) {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: innerHeight,
  })

  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      height: visualViewportHeight,
      width: 1280,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as VisualViewport,
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  originalInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()

  if (originalInnerHeightDescriptor) {
    Object.defineProperty(window, 'innerHeight', originalInnerHeightDescriptor)
  }

  if (originalVisualViewportDescriptor) {
    Object.defineProperty(window, 'visualViewport', originalVisualViewportDescriptor)
  } else {
    Reflect.deleteProperty(window, 'visualViewport')
  }
})

describe('MessageInput keyboard submit behavior', () => {
  it('sends on Enter when virtual keyboard is not open', () => {
    setViewportState({ innerHeight: 900, visualViewportHeight: 900 })
    const { onSend, textarea } = renderInput()

    fireEvent.change(textarea, { target: { value: 'hello world' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('hello world', undefined)
  })

  it('does not send on Enter while virtual keyboard is open', () => {
    setViewportState({ innerHeight: 900, visualViewportHeight: 620 })
    const { onSend, textarea } = renderInput()

    fireEvent.change(textarea, { target: { value: 'hello world' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send on Enter while composing text', () => {
    setViewportState({ innerHeight: 900, visualViewportHeight: 900 })
    const { onSend, textarea } = renderInput()

    fireEvent.change(textarea, { target: { value: 'hello world' } })
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

    expect(onSend).not.toHaveBeenCalled()
  })
})
