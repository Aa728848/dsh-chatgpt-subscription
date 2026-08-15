import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildResponsesPayload } from '../src/host/responses-mapper.ts'

describe('Responses payload mapping', () => {
  it('maps system, images, tool calls and tool results without provider URLs', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', system: 'Be precise.',
      reasoningEffort: 'high',
      tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
      messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [
          { type: 'text', text: 'Inspect this' },
          { type: 'image', attachment: { attachmentId: 'img1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
        ] },
        { id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol' }, content: [
          { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        ] },
        { id: 'm3', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }] },
        ] },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, {
      readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3]) }),
    })
    expect(payload.instructions).toBe('Be precise.')
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
      ],
    })
    expect(payload.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' })
    expect(payload.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'done' })
    expect(payload).toMatchObject({ stream: true, store: false, tool_choice: 'auto', reasoning: { effort: 'high', summary: 'auto' } })
  })

  it('restores a tool call omitted by empty replay state before sending its result', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol', replayState: { outputItems: [] } },
          content: [{ type: 'tool-call', id: 'call_replayed', name: 'shell', arguments: '{"command":"pwd"}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_replayed' },
          content: [{ type: 'tool-result', toolCallId: 'call_replayed', content: [{ type: 'text', text: '/workspace' }] }],
        },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    expect(payload.input).toEqual([
      { type: 'function_call', call_id: 'call_replayed', name: 'shell', arguments: '{"command":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_replayed', output: '/workspace' },
    ])
  })

  it('does not duplicate replayed calls and degrades a genuinely orphaned result to text', async () => {
    const replayedCall = { type: 'function_call', call_id: 'call_known', name: 'read_file', arguments: '{"path":"a"}' }
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol', replayState: { outputItems: [replayedCall] } },
          content: [{ type: 'tool-call', id: 'call_known', name: 'read_file', arguments: '{"path":"a"}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_known' },
          content: [{ type: 'tool-result', toolCallId: 'call_known', content: [{ type: 'text', text: 'known' }] }],
        },
        {
          id: 'm3', role: 'user', source: { kind: 'tool', callId: 'call_orphan' },
          content: [{ type: 'tool-result', toolCallId: 'call_orphan', content: [{ type: 'text', text: 'orphaned' }], isError: true }],
        },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    expect(payload.input.filter((item) => item.type === 'function_call' && item.call_id === 'call_known')).toHaveLength(1)
    expect(payload.input).toContainEqual({ type: 'function_call_output', call_id: 'call_known', output: 'known' })
    expect(payload.input).not.toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_orphan' }))
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [{ type: 'input_text', text: 'Tool result for unavailable call call_orphan (error):\norphaned' }],
    })
  })

  it('hides sandbox escalation controls until a tool has actually been denied', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Check status' }] },
      ],
      tools: [pwshTool()],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    const tools = payload.tools as Array<Record<string, unknown>> | undefined
    expect(tools?.[0]?.description).toContain('command execution is stateless')
    const parameters = tools?.[0]?.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, unknown>
    expect(properties).not.toHaveProperty('sandbox_permissions')
    expect(properties).not.toHaveProperty('justification')
    expect((properties.command as Record<string, unknown>).description).toContain('fresh process')
    expect((properties.workdir as Record<string, unknown>).description).toContain('instead of embedding cd')
    expect(parameters.required).toEqual(['command', 'description'])
    expect(payload.instructions).toContain('Command tool compatibility rule (pwsh)')
    expect(payload.instructions).toContain('[auto-mode hard deny]')
    expect(payload.instructions).toContain('this is not a sandbox-escalation retry')
  })

  it('exposes sandbox escalation controls only after the matching tool was denied', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol' },
          content: [{ type: 'tool-call', id: 'call_denied', name: 'pwsh', arguments: '{"command":"git status","description":"Show status"}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_denied' },
          content: [{
            type: 'tool-result', toolCallId: 'call_denied', isError: true,
            content: [{ type: 'text', text: '[sandbox: file access denied under read-only mode]' }],
          }],
        },
      ],
      tools: [pwshTool()],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    const tools = payload.tools as Array<Record<string, unknown>> | undefined
    const parameters = tools?.[0]?.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, unknown>
    expect(properties).toHaveProperty('sandbox_permissions')
    expect(properties).toHaveProperty('justification')
    expect((properties.sandbox_permissions as Record<string, unknown>).description).toContain('hard-deny')
    expect(payload.instructions).toContain('retry the exact denied call for: pwsh')
  })

  it.each([
    '[auto-mode hard deny] dynamic deletion targeting the user home is not permitted',
    'sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "workspace-write" mode',
  ])('does not expose sandbox escalation controls for non-retriable policy errors: %s', async (error) => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol' },
          content: [{ type: 'tool-call', id: 'call_policy', name: 'pwsh', arguments: '{"command":"Remove-Item ...","description":"Clean files"}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_policy' },
          content: [{
            type: 'tool-result', toolCallId: 'call_policy', isError: true,
            content: [{ type: 'text', text: error }],
          }],
        },
      ],
      tools: [pwshTool()],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    const tools = payload.tools as Array<Record<string, unknown>> | undefined
    const parameters = tools?.[0]?.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, unknown>
    expect(properties).not.toHaveProperty('sandbox_permissions')
    expect(properties).not.toHaveProperty('justification')
    expect(payload.instructions).toContain('this is not a sandbox-escalation retry')
    expect(payload.instructions).toContain('policy denials as non-retriable')
  })

  it('adds Windows PowerShell guidance to run_code without mutating the DSH tool schema', async () => {
    const tool = runCodeTool()
    const originalParameters = structuredClone(tool.parameters)
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [], tools: [tool],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    const mappedTool = (payload.tools as Array<Record<string, unknown>>)[0]
    const parameters = mappedTool.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, Record<string, unknown>>

    expect(mappedTool.description).toContain('strict JavaScript/TypeScript')
    expect(properties.code.description).toContain('String.raw')
    expect(properties.code.description).toContain('${...}')
    expect(properties.code.description).toContain('backslashes')
    expect(payload.instructions).toContain('run_code compatibility rule')
    expect(payload.instructions).toContain('here-strings')
    expect(tool.parameters).toEqual(originalParameters)
  })

  it.each([
    'Legacy octal escape is not permitted in strict mode',
    "Unexpected token ':' Expected '}'",
    'Invalid or unexpected token near C:\\Users\\eddy',
    'Unterminated template literal after $env:TEMP',
  ])('adds a corrective hint for run_code parser errors: %s', async (error) => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol' },
          content: [{ type: 'tool-call', id: 'call_run_code', name: 'run_code', arguments: '{"code":"..."}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_run_code' },
          content: [{
            type: 'tool-result', toolCallId: 'call_run_code', isError: true,
            content: [{ type: 'text', text: error }],
          }],
        },
      ],
      tools: [runCodeTool()],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    const result = payload.input.find((item) => item.type === 'function_call_output')

    expect(result?.output).toContain(error)
    expect(result?.output).toContain('Compatibility hint: run_code failed while parsing')
    expect(result?.output).toContain('String.raw does not prevent ${...} interpolation')
  })

  it('does not append the run_code hint to unrelated execution errors', async () => {
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol' },
          content: [{ type: 'tool-call', id: 'call_run_code', name: 'run_code', arguments: '{"code":"..."}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_run_code' },
          content: [{
            type: 'tool-result', toolCallId: 'call_run_code', isError: true,
            content: [{ type: 'text', text: 'Nested pwsh command exited with code 1' }],
          }],
        },
      ],
      tools: [runCodeTool()],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())

    expect(payload.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_run_code',
      output: 'Nested pwsh command exited with code 1',
    })
  })
})

function unusedAttachments() {
  return { readImage: async () => { throw new Error('unused') } }
}

function pwshTool() {
  return {
    name: 'pwsh',
    description: 'Run PowerShell.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        workdir: { type: 'string' },
        timeoutMs: { type: 'number' },
        run_in_background: { type: 'boolean' },
        sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
        justification: { type: 'string' },
      },
      required: ['command', 'description', 'sandbox_permissions', 'justification'],
    },
  }
}

function runCodeTool() {
  return {
    name: 'run_code',
    description: 'Execute a TypeScript program.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Body of an async TypeScript function.' },
        description: { type: 'string' },
      },
      required: ['code', 'description'],
    },
  }
}
