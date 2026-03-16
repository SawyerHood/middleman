/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_INTERNAL_CHATTER_STORAGE_KEY,
  readStoredShowInternalChatter,
  writeStoredShowInternalChatter,
} from './chat-view-preferences'

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')

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
      return store.has(key) ? store.get(key) ?? null : null
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
})

afterEach(() => {
  window.localStorage.clear()

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor)
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor)
  }
})

describe('chat-view-preferences', () => {
  it('defaults internal chatter visibility to enabled', () => {
    expect(readStoredShowInternalChatter()).toBe(true)
  })

  it('persists disabled internal chatter visibility', () => {
    writeStoredShowInternalChatter(false)

    expect(window.localStorage.getItem(CHAT_INTERNAL_CHATTER_STORAGE_KEY)).toBe('false')
    expect(readStoredShowInternalChatter()).toBe(false)
  })

  it('removes the stored preference when internal chatter is enabled again', () => {
    window.localStorage.setItem(CHAT_INTERNAL_CHATTER_STORAGE_KEY, 'false')

    writeStoredShowInternalChatter(true)

    expect(window.localStorage.getItem(CHAT_INTERNAL_CHATTER_STORAGE_KEY)).toBeNull()
    expect(readStoredShowInternalChatter()).toBe(true)
  })
})
