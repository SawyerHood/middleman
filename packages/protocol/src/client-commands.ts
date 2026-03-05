import type { ConversationAttachment } from './attachments.js'
import type { DeliveryMode, ManagerModelPreset } from './shared-types.js'

export type ClientCommand =
  | { type: 'subscribe'; agentId?: string }
  | { type: 'subscribe_agent_detail'; agentId: string }
  | { type: 'unsubscribe_agent_detail'; agentId: string }
  | {
      type: 'user_message'
      text: string
      attachments?: ConversationAttachment[]
      agentId?: string
      delivery?: DeliveryMode
    }
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_all_agents'; managerId: string; requestId?: string }
  | { type: 'create_manager'; name: string; cwd: string; model?: ManagerModelPreset; requestId?: string }
  | { type: 'delete_manager'; managerId: string; requestId?: string }
  | { type: 'list_directories'; path?: string; requestId?: string }
  | { type: 'validate_directory'; path: string; requestId?: string }
  | { type: 'pick_directory'; defaultPath?: string; requestId?: string }
  | { type: 'ping' }
