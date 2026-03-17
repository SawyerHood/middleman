/* ------------------------------------------------------------------ */
/*  Shared API helpers for settings components                        */
/* ------------------------------------------------------------------ */

import type {
  SettingsEnvVariable,
  SettingsAuthProviderId,
  SettingsAuthProvider,
  SettingsAuthOAuthFlowState,
} from './settings-types'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const SETTINGS_AUTH_PROVIDER_META: Record<
  SettingsAuthProviderId,
  { label: string; description: string; placeholder: string; helpUrl: string }
> = {
  anthropic: {
    label: 'Anthropic API key',
    description: 'Used by pi-opus and Anthropic-backed managers/workers.',
    placeholder: 'sk-ant-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  'openai-codex': {
    label: 'OpenAI API key',
    description: 'Used for Codex runtime sessions.',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
}

export const SETTINGS_AUTH_PROVIDER_ORDER: SettingsAuthProviderId[] = ['anthropic', 'openai-codex']

export const DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE: SettingsAuthOAuthFlowState = {
  status: 'idle',
  codeValue: '',
  isSubmittingCode: false,
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}

export function createIdleSettingsAuthOAuthFlowState(): SettingsAuthOAuthFlowState {
  return { ...DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE }
}

function normalizeSettingsAuthProviderId(value: unknown): SettingsAuthProviderId | undefined {
  if (value === 'anthropic') return 'anthropic'
  if (value === 'openai-codex') return 'openai-codex'
  return undefined
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch { /* ignore */ }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch { /* ignore */ }
  return `Request failed (${response.status})`
}

/* ------------------------------------------------------------------ */
/*  Type guards                                                       */
/* ------------------------------------------------------------------ */

function isSettingsEnvVariable(value: unknown): value is SettingsEnvVariable {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SettingsEnvVariable>
  return (
    typeof v.name === 'string' && v.name.trim().length > 0 &&
    typeof v.skillName === 'string' && v.skillName.trim().length > 0 &&
    typeof v.required === 'boolean' &&
    typeof v.isSet === 'boolean'
  )
}

function parseSettingsAuthProvider(value: unknown): SettingsAuthProvider | null {
  if (!value || typeof value !== 'object') return null
  const provider = value as { provider?: unknown; configured?: unknown; authType?: unknown; maskedValue?: unknown }
  const providerId = normalizeSettingsAuthProviderId(provider.provider)
  if (!providerId || typeof provider.configured !== 'boolean') return null
  if (provider.authType !== undefined && provider.authType !== 'api_key' && provider.authType !== 'oauth' && provider.authType !== 'unknown') return null
  return {
    provider: providerId,
    configured: provider.configured,
    authType: provider.authType,
    maskedValue: typeof provider.maskedValue === 'string' ? provider.maskedValue : undefined,
  }
}

/* ------------------------------------------------------------------ */
/*  OAuth SSE parsing                                                 */
/* ------------------------------------------------------------------ */

interface SettingsAuthOAuthStreamHandlers {
  onAuthUrl: (event: { url: string; instructions?: string }) => void
  onPrompt: (event: { message: string; placeholder?: string }) => void
  onProgress: (event: { message: string }) => void
  onComplete: (event: { provider: SettingsAuthProviderId; status: 'connected' }) => void
  onError: (message: string) => void
}

function parseSettingsAuthOAuthEventData(rawData: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(rawData) } catch { throw new Error('Invalid OAuth event payload.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid OAuth event payload.')
  return parsed as Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  Env variables API                                                 */
/* ------------------------------------------------------------------ */

export async function fetchSettingsEnvVariables(wsUrl: string): Promise<SettingsEnvVariable[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { variables?: unknown }
  if (!payload || !Array.isArray(payload.variables)) return []
  return payload.variables.filter(isSettingsEnvVariable)
}

export async function updateSettingsEnvVariables(wsUrl: string, values: Record<string, string>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function deleteSettingsEnvVariable(wsUrl: string, variableName: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/env/${encodeURIComponent(variableName)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

/* ------------------------------------------------------------------ */
/*  Auth providers API                                                */
/* ------------------------------------------------------------------ */

export async function fetchSettingsAuthProviders(wsUrl: string): Promise<SettingsAuthProvider[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/auth')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { providers?: unknown }
  if (!payload || !Array.isArray(payload.providers)) return []
  const parsed = payload.providers.map((v) => parseSettingsAuthProvider(v)).filter((v): v is SettingsAuthProvider => v !== null)
  const configuredByProvider = new Map(parsed.map((entry) => [entry.provider, entry]))
  return SETTINGS_AUTH_PROVIDER_ORDER.map((provider) => configuredByProvider.get(provider) ?? { provider, configured: false })
}

export async function updateSettingsAuthProviders(wsUrl: string, values: Partial<Record<SettingsAuthProviderId, string>>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/auth')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function deleteSettingsAuthProvider(wsUrl: string, provider: SettingsAuthProviderId): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/${encodeURIComponent(provider)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function startSettingsAuthOAuthLoginStream(
  wsUrl: string,
  provider: SettingsAuthProviderId,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/login/${encodeURIComponent(provider)}`)
  const response = await fetch(endpoint, { method: 'POST', signal })
  if (!response.ok) throw new Error(await readApiError(response))
  if (!response.body) throw new Error('OAuth login stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let eventName = 'message'
  let eventDataLines: string[] = []

  const flushEvent = (): void => {
    if (eventDataLines.length === 0) { eventName = 'message'; return }
    const rawData = eventDataLines.join('\n')
    eventDataLines = []

    if (eventName === 'auth_url') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.url !== 'string' || !payload.url.trim()) throw new Error('OAuth auth_url event is missing a URL.')
      handlers.onAuthUrl({ url: payload.url, instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined })
    } else if (eventName === 'prompt') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('OAuth prompt event is missing a message.')
      handlers.onPrompt({ message: payload.message, placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined })
    } else if (eventName === 'progress') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message === 'string' && payload.message.trim()) handlers.onProgress({ message: payload.message })
    } else if (eventName === 'complete') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const providerId = normalizeSettingsAuthProviderId(payload.provider)
      if (!providerId || payload.status !== 'connected') throw new Error('OAuth complete event payload is invalid.')
      handlers.onComplete({ provider: providerId, status: 'connected' })
    } else if (eventName === 'error') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message : 'OAuth login failed.'
      handlers.onError(message)
    }
    eventName = 'message'
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuffer += decoder.decode(value, { stream: true })
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) flushEvent()
      else if (line.startsWith(':')) { /* comment */ }
      else if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) eventDataLines.push(line.slice('data:'.length).trimStart())
      newlineIndex = lineBuffer.indexOf('\n')
    }
  }
  flushEvent()
}

export async function submitSettingsAuthOAuthPrompt(wsUrl: string, provider: SettingsAuthProviderId, value: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/login/${encodeURIComponent(provider)}/respond`)
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
  if (!response.ok) throw new Error(await readApiError(response))
}
