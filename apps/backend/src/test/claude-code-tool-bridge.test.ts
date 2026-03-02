import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import {
  buildClaudeCodeMcpServer,
  CLAUDE_CODE_MCP_SERVER_NAME,
  getClaudeCodeAllowedToolNames,
} from '../swarm/claude-code-tool-bridge.js'

function toolDefinition(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'name'>): ToolDefinition {
  return {
    name: overrides.name,
    label: overrides.label ?? overrides.name,
    description: overrides.description ?? `Run ${overrides.name}`,
    parameters: overrides.parameters ?? {},
    execute:
      overrides.execute ??
      (async () => ({
        content: [
          {
            type: 'text',
            text: `${overrides.name} ok`,
          },
        ],
      })),
  } as unknown as ToolDefinition
}

describe('buildClaudeCodeMcpServer', () => {
  it('registers swarm tools and emits correctly formatted allowed tool names', () => {
    const server = buildClaudeCodeMcpServer([
      toolDefinition({ name: 'list_agents' }),
      toolDefinition({ name: 'send_message_to_agent' }),
      toolDefinition({ name: 'spawn_agent' }),
      toolDefinition({ name: 'kill_agent' }),
      toolDefinition({ name: 'speak_to_user' }),
    ])

    expect(server.type).toBe('sdk')
    expect(server.name).toBe(CLAUDE_CODE_MCP_SERVER_NAME)

    const registeredTools = (server.instance as any)._registeredTools
    expect(Object.keys(registeredTools).sort()).toEqual([
      'kill_agent',
      'list_agents',
      'send_message_to_agent',
      'spawn_agent',
      'speak_to_user',
    ])

    const allowedTools = getClaudeCodeAllowedToolNames([
      { name: 'list_agents' } as Pick<ToolDefinition, 'name'>,
      { name: 'send_message_to_agent' } as Pick<ToolDefinition, 'name'>,
    ])

    expect(allowedTools).toEqual([
      'mcp__middleman-swarm__list_agents',
      'mcp__middleman-swarm__send_message_to_agent',
    ])
  })

  it('invokes swarm tool handlers and maps content responses', async () => {
    const execute = vi.fn(async (_toolCallId: string, args: Record<string, unknown>) => ({
      content: [
        {
          type: 'text',
          text: `queued ${String(args.targetAgentId)}:${String(args.message)}`,
        },
      ],
      details: {
        acceptedMode: 'prompt',
      },
    }))

    const server = buildClaudeCodeMcpServer([
      toolDefinition({
        name: 'send_message_to_agent',
        execute: execute as ToolDefinition['execute'],
      }),
    ])

    const registeredTools = (server.instance as any)._registeredTools
    const result = await registeredTools.send_message_to_agent.handler(
      {
        targetAgentId: 'worker-1',
        message: 'hello',
      },
      {},
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      'sdk-call',
      {
        targetAgentId: 'worker-1',
        message: 'hello',
      },
      undefined,
      undefined,
      undefined,
    )

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'queued worker-1:hello',
        },
      ],
    })
  })

  it('maps non-content and error tool responses into MCP-safe text payloads', async () => {
    const server = buildClaudeCodeMcpServer([
      toolDefinition({
        name: 'list_agents',
        execute: (async () => ({
          agents: [{ agentId: 'manager' }],
        })) as unknown as ToolDefinition['execute'],
      }),
      toolDefinition({
        name: 'kill_agent',
        execute: (async () => {
          throw new Error('blocked')
        }) as ToolDefinition['execute'],
      }),
    ])

    const registeredTools = (server.instance as any)._registeredTools

    const listAgentsResult = await registeredTools.list_agents.handler({}, {})
    expect(listAgentsResult.content[0].text).toContain('"agentId": "manager"')

    const killAgentResult = await registeredTools.kill_agent.handler(
      {
        targetAgentId: 'worker-1',
      },
      {},
    )

    expect(killAgentResult.isError).toBe(true)
    expect(killAgentResult.content[0].text).toContain('Tool kill_agent failed: blocked')
  })
})
