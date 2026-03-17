/* ------------------------------------------------------------------ */
/*  Shared types for settings components                              */
/* ------------------------------------------------------------------ */

export interface SettingsEnvVariable {
  name: string
  description?: string
  required: boolean
  helpUrl?: string
  skillName: string
  isSet: boolean
  maskedValue?: string
}

export type SettingsAuthProviderId = 'anthropic' | 'openai-codex'

export interface SettingsAuthProvider {
  provider: SettingsAuthProviderId
  configured: boolean
  authType?: 'api_key' | 'oauth' | 'unknown'
  maskedValue?: string
}

export type SettingsAuthOAuthFlowStatus =
  | 'idle'
  | 'starting'
  | 'waiting_for_auth'
  | 'waiting_for_code'
  | 'complete'
  | 'error'

export interface SettingsAuthOAuthFlowState {
  status: SettingsAuthOAuthFlowStatus
  authUrl?: string
  instructions?: string
  promptMessage?: string
  promptPlaceholder?: string
  progressMessage?: string
  errorMessage?: string
  codeValue: string
  isSubmittingCode: boolean
}
