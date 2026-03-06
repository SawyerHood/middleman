import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export const MESSAGE_DRAFTS_STORAGE_KEY = 'middleman-drafts'

export type MessageDrafts = Record<string, string>

function isMessageDrafts(value: unknown): value is MessageDrafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return Object.entries(value).every(([key, draft]) => {
    return typeof key === 'string' && key.length > 0 && typeof draft === 'string'
  })
}

const messageDraftStorage = {
  getItem(key: string, initialValue: MessageDrafts): MessageDrafts {
    if (typeof window === 'undefined') {
      return initialValue
    }

    try {
      const stored = window.localStorage.getItem(key)
      if (!stored) {
        return initialValue
      }

      const parsed = JSON.parse(stored)
      return isMessageDrafts(parsed) ? parsed : initialValue
    } catch {
      return initialValue
    }
  },
  setItem(key: string, value: MessageDrafts): void {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  },
  removeItem(key: string): void {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.removeItem(key)
    } catch {
      // Ignore localStorage removal failures in restricted environments.
    }
  },
}

export const messageDraftsAtom = atomWithStorage<MessageDrafts>(
  MESSAGE_DRAFTS_STORAGE_KEY,
  {},
  messageDraftStorage,
  { getOnInit: true },
)

export const pruneMessageDraftsAtom = atom(
  null,
  (get, set, activeAgentIds: string[]) => {
    const activeAgentIdSet = new Set(
      activeAgentIds.map((agentId) => agentId.trim()).filter((agentId) => agentId.length > 0),
    )
    const drafts = get(messageDraftsAtom)
    const nextDrafts: MessageDrafts = {}
    let hasChanges = false

    for (const [agentId, draft] of Object.entries(drafts)) {
      if (!activeAgentIdSet.has(agentId) || draft.length === 0) {
        hasChanges = true
        continue
      }

      nextDrafts[agentId] = draft
    }

    if (!hasChanges) {
      return
    }

    set(messageDraftsAtom, nextDrafts)
  },
)
