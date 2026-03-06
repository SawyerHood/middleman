import { chooseFallbackAgentId } from './agent-hierarchy'
import { WsRequestTracker } from './ws-request-tracker'
import {
  createInitialManagerWsState,
  type AgentActivityEntry,
  type ConversationHistoryEntry,
  type ManagerWsState,
} from './ws-state'
import {
  MANAGER_MODEL_PRESETS,
  type AgentDescriptor,
  type ClientCommand,
  type ConversationAttachment,
  type ConversationEntry,
  type ConversationMessageEvent,
  type DeliveryMode,
  type ManagerModelPreset,
  type ServerEvent,
  type UserTask,
} from '@middleman/protocol'

export type { ManagerWsState } from './ws-state'

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1200
const REQUEST_TIMEOUT_MS = 300_000
// Keep client-side activity retention aligned with backend history retention.
const MAX_CLIENT_CONVERSATION_HISTORY = 2000

export interface DirectoriesListedResult {
  path: string
  directories: string[]
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
}

type Listener = (state: ManagerWsState) => void

type WsRequestResultMap = {
  create_manager: AgentDescriptor
  delete_manager: { managerId: string }
  stop_all_agents: { managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }
  list_directories: DirectoriesListedResult
  validate_directory: DirectoryValidationResult
  pick_directory: string | null
  get_all_tasks: UserTask[]
  complete_task: UserTask
  update_task: UserTask
}

type WsRequestType = Extract<keyof WsRequestResultMap, string>
const WS_REQUEST_TYPES: WsRequestType[] = [
  'create_manager',
  'delete_manager',
  'stop_all_agents',
  'list_directories',
  'validate_directory',
  'pick_directory',
  'get_all_tasks',
  'complete_task',
  'update_task',
]

const WS_REQUEST_ERROR_HINTS: Array<{ requestType: WsRequestType; codeFragment: string }> = [
  { requestType: 'create_manager', codeFragment: 'create_manager' },
  { requestType: 'delete_manager', codeFragment: 'delete_manager' },
  { requestType: 'stop_all_agents', codeFragment: 'stop_all_agents' },
  { requestType: 'list_directories', codeFragment: 'list_directories' },
  { requestType: 'validate_directory', codeFragment: 'validate_directory' },
  { requestType: 'pick_directory', codeFragment: 'pick_directory' },
  { requestType: 'get_all_tasks', codeFragment: 'get_all_tasks' },
  { requestType: 'complete_task', codeFragment: 'complete_task' },
  { requestType: 'update_task', codeFragment: 'update_task' },
]

export class ManagerWsClient {
  private readonly url: string
  private desiredAgentId: string | null
  private desiredDetailAgentId: string | null = null

  private socket: WebSocket | null = null
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private destroyed = false
  private hasConnectedOnce = false
  private shouldReloadOnReconnect = false

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private requestCounter = 0
  private readonly requestTracker = new WsRequestTracker<WsRequestResultMap>(
    WS_REQUEST_TYPES,
    REQUEST_TIMEOUT_MS,
  )

  constructor(url: string, initialAgentId?: string | null) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.url = url
    this.desiredAgentId = normalizedInitialAgentId
    this.state = createInitialManagerWsState(normalizedInitialAgentId)
  }

  getState(): ManagerWsState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') {
      return
    }

    this.started = true
    this.scheduleConnect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.destroyed = true
    this.started = false

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }

    this.rejectAllPendingRequests('Client destroyed before request completed.')

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }

  subscribeToAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    this.desiredAgentId = trimmed
    this.updateState({
      targetAgentId: trimmed,
      messages: [],
      activityMessages: [],
      lastError: null,
    })

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.send({
      type: 'subscribe',
      agentId: trimmed,
    })
  }

  subscribeToAgentDetail(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) {
      return
    }

    if (this.desiredDetailAgentId === trimmed) {
      return
    }

    const previousDetailAgentId = this.desiredDetailAgentId
    this.desiredDetailAgentId = trimmed

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    if (previousDetailAgentId && previousDetailAgentId !== trimmed) {
      this.send({
        type: 'unsubscribe_agent_detail',
        agentId: previousDetailAgentId,
      })
    }

    this.send({
      type: 'subscribe_agent_detail',
      agentId: trimmed,
    })
  }

  unsubscribeFromAgentDetail(agentId?: string): void {
    const normalizedAgentId = normalizeAgentId(agentId) ?? this.desiredDetailAgentId
    if (!normalizedAgentId) {
      return
    }

    if (this.desiredDetailAgentId === normalizedAgentId) {
      this.desiredDetailAgentId = null
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.send({
      type: 'unsubscribe_agent_detail',
      agentId: normalizedAgentId,
    })
  }

  sendUserMessage(
    text: string,
    options?: { agentId?: string; delivery?: DeliveryMode; attachments?: ConversationAttachment[] },
  ): void {
    const trimmed = text.trim()
    const attachments = normalizeConversationAttachments(options?.attachments)
    if (!trimmed && attachments.length === 0) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    const agentId =
      options?.agentId ?? this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId

    if (!agentId) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      !options?.agentId &&
      !this.state.targetAgentId &&
      !this.state.subscribedAgentId &&
      this.state.agents.length === 0
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (this.state.agents.length > 0 && !this.state.agents.some((agent) => agent.agentId === agentId)) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    this.send({
      type: 'user_message',
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      agentId,
      delivery: options?.delivery,
    })
  }

  deleteAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    this.send({
      type: 'kill_agent',
      agentId: trimmed,
    })
  }

  async stopAllAgents(
    managerId: string,
  ): Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('stop_all_agents', (requestId) => ({
      type: 'stop_all_agents',
      managerId: trimmed,
      requestId,
    }))
  }

  async createManager(input: { name: string; cwd: string; model: ManagerModelPreset }): Promise<AgentDescriptor> {
    const name = input.name.trim()
    const cwd = input.cwd.trim()
    const model = input.model

    if (!name) {
      throw new Error('Manager name is required.')
    }

    if (!cwd) {
      throw new Error('Manager working directory is required.')
    }

    if (!MANAGER_MODEL_PRESETS.includes(model)) {
      throw new Error('Manager model is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('create_manager', (requestId) => ({
        type: 'create_manager',
        name,
        cwd,
        model,
        requestId,
      }))
  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager',
        managerId: trimmed,
        requestId,
      }))
  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories',
        path: path?.trim() || undefined,
        requestId,
      }))
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    const trimmed = path.trim()
    if (!trimmed) {
      throw new Error('Directory path is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('validate_directory', (requestId) => ({
        type: 'validate_directory',
        path: trimmed,
        requestId,
      }))
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('pick_directory', (requestId) => ({
        type: 'pick_directory',
        defaultPath: defaultPath?.trim() || undefined,
        requestId,
      }))
  }

  async getAllTasks(): Promise<UserTask[]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    return this.enqueueRequest('get_all_tasks', (requestId) => ({
      type: 'get_all_tasks',
      requestId,
    }))
  }

  async completeTask(taskId: string, comment?: string): Promise<UserTask> {
    const trimmedTaskId = taskId.trim()
    if (!trimmedTaskId) {
      throw new Error('Task id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const trimmedComment = comment?.trim()

    return this.enqueueRequest('complete_task', (requestId) => ({
      type: 'complete_task',
      taskId: trimmedTaskId,
      comment: trimmedComment && trimmedComment.length > 0 ? trimmedComment : undefined,
      requestId,
    }))
  }

  async updateTask(input: { taskId: string; title?: string; description?: string }): Promise<UserTask> {
    const trimmedTaskId = input.taskId.trim()
    if (!trimmedTaskId) {
      throw new Error('Task id is required.')
    }

    if (input.title === undefined && input.description === undefined) {
      throw new Error('Task updates must include a title or description.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const trimmedTitle = input.title?.trim()
    if (input.title !== undefined && !trimmedTitle) {
      throw new Error('Task title must be a non-empty string.')
    }

    return this.enqueueRequest('update_task', (requestId) => ({
      type: 'update_task',
      taskId: trimmedTaskId,
      title: trimmedTitle,
      description: input.description !== undefined ? input.description.trim() : undefined,
      requestId,
    }))
  }

  private connect(): void {
    if (this.destroyed) return

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.addEventListener('open', () => {
      const shouldReload = this.shouldReloadOnReconnect
      this.hasConnectedOnce = true
      this.shouldReloadOnReconnect = false

      this.updateState({
        connected: true,
        lastError: null,
      })

      this.send({
        type: 'subscribe',
        agentId: this.desiredAgentId ?? undefined,
      })

      if (this.desiredDetailAgentId) {
        this.send({
          type: 'subscribe_agent_detail',
          agentId: this.desiredDetailAgentId,
        })
      }

      if (shouldReload && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
        window.location.reload()
      }
    })

    socket.addEventListener('message', (event) => {
      this.handleServerEvent(event.data)
    })

    socket.addEventListener('close', () => {
      if (!this.destroyed && this.hasConnectedOnce) {
        this.shouldReloadOnReconnect = true
      }

      this.updateState({
        connected: false,
        subscribedAgentId: null,
      })

      this.rejectAllPendingRequests('WebSocket disconnected before request completed.')
      this.scheduleConnect(RECONNECT_MS)
    })

    socket.addEventListener('error', () => {
      this.updateState({
        connected: false,
        lastError: 'WebSocket connection error',
      })
    })
  }

  private scheduleConnect(delayMs: number): void {
    if (this.destroyed || !this.started || this.connectTimer) {
      return
    }

    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (!this.destroyed && this.started) {
        this.connect()
      }
    }, delayMs)
  }

  private handleServerEvent(raw: unknown): void {
    let event: ServerEvent
    try {
      event = JSON.parse(String(raw)) as ServerEvent
    } catch {
      this.pushSystemMessage('Received invalid JSON event from backend.')
      return
    }

    switch (event.type) {
      case 'ready':
        this.updateState({
          connected: true,
          targetAgentId: event.subscribedAgentId,
          subscribedAgentId: event.subscribedAgentId,
          lastError: null,
        })
        void this.getAllTasks().catch(() => undefined)
        break

      case 'conversation_message':
      case 'conversation_log': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const messages = [...this.state.messages, event]
        this.updateState({ messages })
        break
      }

      case 'agent_message':
      case 'agent_tool_call': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const activityMessages = clampConversationHistory([...this.state.activityMessages, event])
        this.updateState({ activityMessages })
        break
      }

      case 'conversation_history':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        {
          const { messages, activityMessages } = splitConversationHistory(event.messages)
          this.updateState({
            messages,
            activityMessages: clampConversationHistory(activityMessages),
          })
        }
        break

      case 'conversation_reset':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        this.updateState({
          messages: [],
          activityMessages: [],
          lastError: null,
        })
        break

      case 'agent_status': {
        const statuses = {
          ...this.state.statuses,
          [event.agentId]: {
            status: event.status,
            pendingCount: event.pendingCount,
            contextUsage: event.contextUsage,
          },
        }
        this.updateState({ statuses })
        break
      }

      case 'agents_snapshot':
        this.applyAgentsSnapshot(event.agents)
        break

      case 'manager_created': {
        this.applyManagerCreated(event.manager)
        this.requestTracker.resolve('create_manager', event.requestId, event.manager)
        break
      }

      case 'manager_deleted': {
        this.applyManagerDeleted(event.managerId)
        this.requestTracker.resolve('delete_manager', event.requestId, {
          managerId: event.managerId,
        })
        break
      }

      case 'stop_all_agents_result': {
        const stoppedWorkerIds = event.stoppedWorkerIds ?? event.terminatedWorkerIds ?? []
        const managerStopped = event.managerStopped ?? event.managerTerminated ?? false

        this.requestTracker.resolve('stop_all_agents', event.requestId, {
          managerId: event.managerId,
          stoppedWorkerIds,
          managerStopped,
        })
        break
      }

      case 'directories_listed': {
        this.requestTracker.resolve('list_directories', event.requestId, {
          path: event.path,
          directories: event.directories,
        })
        break
      }

      case 'directory_validated': {
        this.requestTracker.resolve('validate_directory', event.requestId, {
          path: event.path,
          valid: event.valid,
          message: event.message ?? null,
        })
        break
      }

      case 'directory_picked': {
        this.requestTracker.resolve('pick_directory', event.requestId, event.path ?? null)
        break
      }

      case 'tasks_snapshot': {
        this.updateState({ tasks: sortTasks(event.tasks) })
        this.requestTracker.resolve('get_all_tasks', event.requestId, sortTasks(event.tasks))
        break
      }

      case 'task_created':
      case 'task_updated': {
        this.updateState({
          tasks: upsertTask(this.state.tasks, event.task),
        })
        break
      }

      case 'tasks_deleted': {
        const deletedTaskIds = new Set(event.taskIds)
        this.updateState({
          tasks: this.state.tasks.filter((task) => !deletedTaskIds.has(task.id)),
        })
        break
      }

      case 'task_completion_result': {
        this.requestTracker.resolve('complete_task', event.requestId, event.task)
        break
      }

      case 'task_update_result': {
        this.requestTracker.resolve('update_task', event.requestId, event.task)
        break
      }

      case 'slack_status':
        this.updateState({ slackStatus: event })
        break

      case 'telegram_status':
        this.updateState({ telegramStatus: event })
        break

      case 'error':
        this.updateState({ lastError: event.message })
        this.pushSystemMessage(`${event.code}: ${event.message}`)
        this.rejectPendingFromError(event.code, event.message, event.requestId)
        break
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    const liveAgentIds = new Set(agents.map((agent) => agent.agentId))
    if (this.desiredDetailAgentId && !liveAgentIds.has(this.desiredDetailAgentId)) {
      this.desiredDetailAgentId = null
    }

    const statuses = Object.fromEntries(
      agents.map((agent) => {
        const previous = this.state.statuses[agent.agentId]
        const status = agent.status
        return [
          agent.agentId,
          {
            status,
            pendingCount: previous && previous.status === status ? previous.pendingCount : 0,
            contextUsage: agent.contextUsage,
          },
        ]
      }),
    )

    const fallbackTarget = chooseFallbackAgentId(
      agents,
      this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId ?? undefined,
    )
    const targetChanged = fallbackTarget !== this.state.targetAgentId
    const nextSubscribedAgentId =
      this.state.subscribedAgentId && liveAgentIds.has(this.state.subscribedAgentId)
        ? this.state.subscribedAgentId
        : fallbackTarget ?? null

    const patch: Partial<ManagerWsState> = {
      agents,
      statuses,
      hasReceivedAgentsSnapshot: true,
    }

    if (targetChanged) {
      patch.targetAgentId = fallbackTarget
      patch.messages = []
      patch.activityMessages = []
    }

    if (nextSubscribedAgentId !== this.state.subscribedAgentId) {
      patch.subscribedAgentId = nextSubscribedAgentId
    }

    this.desiredAgentId = fallbackTarget ?? null

    this.updateState(patch)

    if (targetChanged && fallbackTarget && this.socket?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'subscribe',
        agentId: fallbackTarget,
      })
    }
  }

  private applyManagerCreated(manager: AgentDescriptor): void {
    const nextAgents = [
      ...this.state.agents.filter((agent) => agent.agentId !== manager.agentId),
      manager,
    ]
    this.applyAgentsSnapshot(nextAgents)
  }

  private applyManagerDeleted(managerId: string): void {
    const nextAgents = this.state.agents.filter(
      (agent) => agent.agentId !== managerId && agent.managerId !== managerId,
    )
    this.applyAgentsSnapshot(nextAgents)
  }

  private pushSystemMessage(text: string): void {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: (this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId) || 'system',
      role: 'system',
      text,
      timestamp: new Date().toISOString(),
      source: 'system',
    }

    const messages = [...this.state.messages, message]
    this.updateState({ messages })
  }

  private send(command: ClientCommand): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(command))
    return true
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1
    return `${prefix}-${Date.now()}-${this.requestCounter}`
  }

  private enqueueRequest<RequestType extends WsRequestType>(
    requestType: RequestType,
    buildCommand: (requestId: string) => ClientCommand,
  ): Promise<WsRequestResultMap[RequestType]> {
    const requestId = this.nextRequestId(requestType)

    return new Promise<WsRequestResultMap[RequestType]>((resolve, reject) => {
      this.requestTracker.track(requestType, requestId, resolve, reject)

      const sent = this.send(buildCommand(requestId))
      if (!sent) {
        this.requestTracker.reject(
          requestType,
          requestId,
          new Error('WebSocket is disconnected. Reconnecting...'),
        )
      }
    })
  }

  private rejectPendingFromError(code: string, message: string, requestId?: string): void {
    const fullError = new Error(`${code}: ${message}`)

    if (requestId && this.requestTracker.rejectByRequestId(requestId, fullError)) {
      return
    }

    const loweredCode = code.toLowerCase()

    for (const hint of WS_REQUEST_ERROR_HINTS) {
      if (!loweredCode.includes(hint.codeFragment)) {
        continue
      }

      if (this.requestTracker.rejectOldest(hint.requestType, fullError)) {
        return
      }
    }

    this.requestTracker.rejectOnlyPending(fullError)
  }

  private rejectAllPendingRequests(reason: string): void {
    this.requestTracker.rejectAll(new Error(reason))
  }
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined,
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return []
  }

  const normalized: ConversationAttachment[] = []

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      continue
    }

    const maybe = attachment as {
      type?: unknown
      mimeType?: unknown
      data?: unknown
      text?: unknown
      fileName?: unknown
    }

    const attachmentType = typeof maybe.type === 'string' ? maybe.type.trim() : ''
    const mimeType = typeof maybe.mimeType === 'string' ? maybe.mimeType.trim() : ''
    const fileName = typeof maybe.fileName === 'string' ? maybe.fileName.trim() : ''

    if (attachmentType === 'text') {
      const text = typeof maybe.text === 'string' ? maybe.text : ''
      if (!mimeType || text.trim().length === 0) {
        continue
      }

      normalized.push({
        type: 'text',
        mimeType,
        text,
        fileName: fileName || undefined,
      })
      continue
    }

    if (attachmentType === 'binary') {
      const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
      if (!mimeType || data.length === 0) {
        continue
      }

      normalized.push({
        type: 'binary',
        mimeType,
        data,
        fileName: fileName || undefined,
      })
      continue
    }

    const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
    if (!mimeType || !mimeType.startsWith('image/') || !data) {
      continue
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
    })
  }

  return normalized
}

function upsertTask(tasks: UserTask[], nextTask: UserTask): UserTask[] {
  const nextTasks = [...tasks.filter((task) => task.id !== nextTask.id), nextTask]
  return sortTasks(nextTasks)
}

function sortTasks(tasks: UserTask[]): UserTask[] {
  return [...tasks].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'pending' ? -1 : 1
    }

    if (left.createdAt !== right.createdAt) {
      return right.createdAt.localeCompare(left.createdAt)
    }

    return right.id.localeCompare(left.id)
  })
}

function splitConversationHistory(
  messages: ConversationEntry[],
): { messages: ConversationHistoryEntry[]; activityMessages: AgentActivityEntry[] } {
  const conversationMessages: ConversationHistoryEntry[] = []
  const activityMessages: AgentActivityEntry[] = []

  for (const entry of messages) {
    if (entry.type === 'agent_message' || entry.type === 'agent_tool_call') {
      activityMessages.push(entry)
      continue
    }

    conversationMessages.push(entry)
  }

  return {
    messages: conversationMessages,
    activityMessages,
  }
}

function clampConversationHistory(messages: AgentActivityEntry[]): AgentActivityEntry[] {
  if (messages.length <= MAX_CLIENT_CONVERSATION_HISTORY) {
    return messages
  }

  return messages.slice(-MAX_CLIENT_CONVERSATION_HISTORY)
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim()
  return trimmed ? trimmed : null
}
