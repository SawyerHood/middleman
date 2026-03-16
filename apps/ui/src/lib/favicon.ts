import type { AgentDescriptor, AgentStatus } from '@middleman/protocol'
import { isWorkingAgentStatus } from './agent-status'

export const DEFAULT_FAVICON_EMOJI = '👔'
export const ACTIVE_FAVICON_EMOJI = '👨‍💻'

type AgentLiveStatuses = Record<
  string,
  { status: AgentStatus; pendingCount: number }
>

interface FaviconDescriptor {
  href: string
  type: string
}

const FAVICON_SIZE = 64
const FAVICON_FONT_SIZE = Math.round(FAVICON_SIZE * 0.85)
const FAVICON_LINK_SELECTOR = 'link[rel="icon"][data-middleman-favicon], link[rel="icon"]'
const faviconCache = new Map<string, FaviconDescriptor>()

export function createEmojiSvgFaviconHref(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50%" y="50%" dy=".08em" text-anchor="middle" dominant-baseline="middle" font-size="90">${emoji}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function createEmojiCanvasFavicon(emoji: string): FaviconDescriptor {
  if (typeof document === 'undefined') {
    return {
      href: createEmojiSvgFaviconHref(emoji),
      type: 'image/svg+xml',
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = FAVICON_SIZE
  canvas.height = FAVICON_SIZE

  const context = canvas.getContext('2d')
  if (!context) {
    return {
      href: createEmojiSvgFaviconHref(emoji),
      type: 'image/svg+xml',
    }
  }

  context.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE)
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `${FAVICON_FONT_SIZE}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
  context.fillText(emoji, FAVICON_SIZE / 2, FAVICON_SIZE / 2 + 2)

  return {
    href: canvas.toDataURL('image/png'),
    type: 'image/png',
  }
}

function resolveEmojiCanvasFavicon(emoji: string): FaviconDescriptor {
  const cached = faviconCache.get(emoji)
  if (cached) {
    return cached
  }

  const next = createEmojiCanvasFavicon(emoji)
  faviconCache.set(emoji, next)
  return next
}

function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: AgentLiveStatuses,
): AgentStatus {
  return statuses[agent.agentId]?.status ?? agent.status
}

export function hasStreamingAgentInManagerScope(
  managerId: string | null,
  agents: AgentDescriptor[],
  statuses: AgentLiveStatuses,
): boolean {
  if (!managerId) {
    return false
  }

  return agents.some((agent) => {
    if (agent.agentId !== managerId && agent.managerId !== managerId) {
      return false
    }

    return isWorkingAgentStatus(getAgentLiveStatus(agent, statuses))
  })
}

export function resolveManagerFaviconEmoji(
  _managerId: string | null,
  agents: AgentDescriptor[],
  statuses: AgentLiveStatuses,
): string {
  const anyStreaming = agents.some(
    (agent) => isWorkingAgentStatus(getAgentLiveStatus(agent, statuses)),
  )
  return anyStreaming ? ACTIVE_FAVICON_EMOJI : DEFAULT_FAVICON_EMOJI
}

export function setDocumentFavicon(emoji: string): void {
  if (typeof document === 'undefined') {
    return
  }

  const favicon = resolveEmojiCanvasFavicon(emoji)
  const existingLink = document.head.querySelector(FAVICON_LINK_SELECTOR)
  const link = existingLink instanceof HTMLLinkElement
    ? existingLink
    : document.createElement('link')

  link.rel = 'icon'
  link.type = favicon.type
  link.href = favicon.href
  link.dataset.middlemanFavicon = 'true'

  if (!existingLink) {
    document.head.append(link)
  }
}
