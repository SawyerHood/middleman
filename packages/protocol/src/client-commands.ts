import type { ConversationAttachment } from "#attachments";
import type { CreateManagerModelPreset, DeliveryMode } from "#shared-types";

export type ClientCommand =
  | { type: "subscribe"; agentId?: string }
  | { type: "subscribe_agent_detail"; agentId: string }
  | { type: "unsubscribe_agent_detail"; agentId: string }
  | { type: "load_older_history"; agentId: string; before: string }
  | { type: "reorder_managers"; managerIds: string[]; requestId?: string }
  | {
      type: "user_message";
      text: string;
      attachments?: ConversationAttachment[];
      agentId?: string;
      delivery?: DeliveryMode;
    }
  | { type: "kill_agent"; agentId: string }
  | { type: "interrupt_agent"; agentId: string; requestId?: string }
  | { type: "compact_agent"; agentId: string; requestId?: string }
  | { type: "stop_all_agents"; managerId: string; requestId?: string }
  | {
      type: "create_manager";
      name: string;
      cwd: string;
      model?: CreateManagerModelPreset;
      requestId?: string;
    }
  | { type: "delete_manager"; managerId: string; requestId?: string }
  | { type: "list_directories"; path?: string; requestId?: string }
  | { type: "validate_directory"; path: string; requestId?: string }
  | { type: "pick_directory"; defaultPath?: string; requestId?: string };
