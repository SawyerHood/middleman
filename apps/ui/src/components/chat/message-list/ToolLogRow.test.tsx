import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolLogRow } from './ToolLogRow'

describe('ToolLogRow', () => {
  it('renders runtime errors defensively when text is not a string', () => {
    const html = renderToStaticMarkup(
      createElement(ToolLogRow, {
        type: 'runtime_error_log',
        entry: {
          type: 'conversation_log',
          agentId: 'pi-worker-2',
          timestamp: '2026-03-14T19:12:48.149Z',
          source: 'runtime_log',
          kind: 'message_end',
          text: {
            code: 'WORKER_ERROR',
            message: 'Worker exited before ready.',
          },
          isError: true,
        } as never,
      }),
    )

    expect(html).toContain('Runtime error')
    expect(html).toContain('WORKER_ERROR')
    expect(html).toContain('Worker exited before ready.')
  })
})
