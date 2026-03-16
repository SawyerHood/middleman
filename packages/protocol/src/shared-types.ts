export type AgentStatus =
  | 'created'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'interrupting'
  | 'stopping'
  | 'stopped'
  | 'errored'
  | 'terminated'

export const MANAGER_MODEL_PRESETS = ['pi-codex', 'pi-opus', 'codex-app', 'claude-code'] as const
export type ManagerModelPreset = (typeof MANAGER_MODEL_PRESETS)[number]

export interface AgentModelDescriptor {
  provider: string
  modelId: string
  thinkingLevel: string
}

export interface AgentContextUsage {
  tokens: number
  contextWindow: number
  percent: number
}

export interface AgentDescriptor {
  agentId: string
  managerId: string
  displayName: string
  role: 'manager' | 'worker'
  archetypeId?: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  cwd: string
  model: AgentModelDescriptor
  contextUsage?: AgentContextUsage
}

export interface NoteSummary {
  path: string
  name: string
  title: string
  createdAt: string
  updatedAt: string
  sizeBytes: number
}

export interface NoteDocument extends NoteSummary {
  content: string
}

export interface NoteTreeFile extends NoteSummary {
  kind: 'file'
}

export interface NoteFolder {
  kind: 'folder'
  path: string
  name: string
  children: NoteTreeNode[]
}

export type NoteTreeNode = NoteTreeFile | NoteFolder

export type DeliveryMode = 'auto' | 'followUp' | 'steer'
export type AcceptedDeliveryMode = 'prompt' | 'followUp' | 'steer'

export type MessageChannel = 'web' | 'slack' | 'telegram'

export interface MessageSourceContext {
  channel: MessageChannel
  channelId?: string
  userId?: string
  messageId?: string
  threadTs?: string
  integrationProfileId?: string
  channelType?: 'dm' | 'channel' | 'group' | 'mpim'
  teamId?: string
}

export type MessageTargetContext = Pick<
  MessageSourceContext,
  'channel' | 'channelId' | 'userId' | 'threadTs' | 'integrationProfileId'
>

export interface DirectoryItem {
  name: string
  path: string
}
