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

  it('maps the configured output verbosity to the Responses text control', async () => {
    const options = { provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments(), {}, 'high')
    expect(payload.text).toEqual({ verbosity: 'high' })
  })

  it('sets service_tier to priority when fast mode is enabled', async () => {
    const options = { provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments(), {}, null, true)
    expect(payload.service_tier).toBe('priority')
  })

  it('omits service_tier when fast mode is disabled', async () => {
    const options = { provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments(), {}, null, false)
    expect(payload).not.toHaveProperty('service_tier')
  })

  it('uses the provider default when output verbosity is not configured', async () => {
    const options = { provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    expect(payload).not.toHaveProperty('text')
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

  it('normalizes overlong replayed call ids and preserves matching outputs without collisions', async () => {
    const sharedPrefix = 'call_' + 'a'.repeat(77)
    const longCallIds = [`${sharedPrefix}x`, `${sharedPrefix}y`]
    const messages = longCallIds.flatMap((callId, index) => [
      {
        id: `assistant-${index}`, role: 'assistant',
        source: {
          kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol',
          replayState: {
            response: {
              outputItems: [{ type: 'function_call', call_id: callId, name: 'read_file', arguments: '{}' }],
            },
          },
        },
        content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }],
      },
      {
        id: `result-${index}`, role: 'user', source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `result-${index}` }] }],
      },
    ])
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages,
    } as unknown as GenerateOptions

    const payload = await buildResponsesPayload(options, unusedAttachments())
    const calls = payload.input.filter((item) => item.type === 'function_call')
    const outputs = payload.input.filter((item) => item.type === 'function_call_output')
    const normalizedIds = calls.map((item) => String(item.call_id))

    expect(normalizedIds).toHaveLength(2)
    expect(new Set(normalizedIds).size).toBe(2)
    expect(normalizedIds.every((callId) => callId.length <= 64)).toBe(true)
    expect(normalizedIds.every((callId) => /^dsh_[a-f0-9]{60}$/.test(callId))).toBe(true)
    expect(outputs.map((item) => item.call_id)).toEqual(normalizedIds)
  })

  it('normalizes an overlong tool call restored from empty replay state', async () => {
    const longCallId = 'call_' + 'z'.repeat(78)
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol', replayState: { outputItems: [] } },
          content: [{ type: 'tool-call', id: longCallId, name: 'shell', arguments: '{"command":"pwd"}' }],
        },
        {
          id: 'm2', role: 'user', source: { kind: 'tool', callId: longCallId },
          content: [{ type: 'tool-result', toolCallId: longCallId, content: [{ type: 'text', text: '/workspace' }] }],
        },
      ],
    } as unknown as GenerateOptions

    const payload = await buildResponsesPayload(options, unusedAttachments())
    const call = payload.input.find((item) => item.type === 'function_call')
    const output = payload.input.find((item) => item.type === 'function_call_output')

    expect(call?.call_id).toMatch(/^dsh_[a-f0-9]{60}$/)
    expect(String(call?.call_id)).toHaveLength(64)
    expect(output?.call_id).toBe(call?.call_id)
  })

  it('warns the model when a user message has only a local raw image markdown link', async () => {
    const text = '请看这张图\n![图片](/describe-image/raw/sha256:fb8625f2d563722a61b6bc791d665d758bd083bbd0b96f7a4693a3d2a1159eda)'
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())

    expect(payload.instructions).toContain('markdown image link to a local/raw session URL')
    expect(payload.instructions).toContain('Do not claim to see the image')
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
  })

  it('converts local raw markdown image links into provider image inputs when bytes are reachable', async () => {
    const url = '/describe-image/raw/sha256:fb8625f2d563722a61b6bc791d665d758bd083bbd0b96f7a4693a3d2a1159eda'
    const text = `请看这张图\n![图片](${url})\n描述一下`
    const fetched: string[] = []
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, imageAttachments(), {
      baseUrl: 'http://127.0.0.1:3080',
      fetchFn: async (input): Promise<Response> => {
        fetched.push(String(input))
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      },
    })

    expect(fetched).toEqual(['http://127.0.0.1:3080/describe-image/raw/sha256:fb8625f2d563722a61b6bc791d665d758bd083bbd0b96f7a4693a3d2a1159eda'])
    expect(payload.instructions ?? '').not.toContain('Do not claim to see the image')
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: '请看这张图\n' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
        { type: 'input_text', text: '\n描述一下' },
      ],
    })
  })

  it('leaves local raw markdown image links as text outside the gpt multimodal route', async () => {
    const text = '![图片](/describe-image/raw/sha256:fb8625f2d563722a61b6bc791d665d758bd083bbd0b96f7a4693a3d2a1159eda)'
    const options = {
      provider: 'other-provider', model: 'text-only', messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, imageAttachments(), {
      baseUrl: 'http://127.0.0.1:3080',
      fetchFn: async (): Promise<Response> => { throw new Error('should not fetch for non-gpt routes') },
    })

    expect(payload.instructions).toContain('markdown image link to a local/raw session URL')
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
  })

  it('omits reasoning summary and image expansion for Codex Spark', async () => {
    const text = '![图片](/describe-image/raw/sha256:fb8625f2d563722a61b6bc791d665d758bd083bbd0b96f7a4693a3d2a1159eda)'
    const options = {
      provider: 'codex-chatgpt',
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'high',
      messages: [
        { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, imageAttachments(), {
      baseUrl: 'http://127.0.0.1:3080',
      fetchFn: async (): Promise<Response> => { throw new Error('should not fetch for spark') },
    })

    expect(payload.reasoning).toEqual({ effort: 'high' })
    expect(payload.input).toContainEqual({
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
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

  it('correctly unpacks replayState wrapped in a ReplayEnvelope response object', async () => {
    const replayedCall = { type: 'function_call', call_id: 'call_wrapped', name: 'read_file', arguments: '{"path":"b"}' }
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [
        {
          id: 'm1', role: 'assistant',
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-5.6-sol', replayState: { response: { outputItems: [replayedCall] } } },
          content: [{ type: 'tool-call', id: 'call_wrapped', name: 'read_file', arguments: '{"path":"b"}' }],
        },
      ],
    } as unknown as GenerateOptions
    const payload = await buildResponsesPayload(options, unusedAttachments())
    expect(payload.input.filter((item) => item.type === 'function_call' && item.call_id === 'call_wrapped')).toHaveLength(1)
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

  it.each([
    ['bash', 'Use Bash syntax and native POSIX paths.', 'For bash, use native POSIX paths'],
    ['sh', 'Use portable POSIX syntax and native POSIX paths', 'avoid Bash-only arrays'],
  ])('adds Linux command guidance for %s without mutating its schema', async (name, descriptionText, instructionText) => {
    const tool = commandTool(name)
    const originalParameters = structuredClone(tool.parameters)
    const options = {
      provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [], tools: [tool],
    } as unknown as GenerateOptions

    const payload = await buildResponsesPayload(options, unusedAttachments())
    const mapped = (payload.tools as Array<Record<string, unknown>>)[0]!
    expect(mapped.description).toContain(descriptionText)
    expect(payload.instructions).toContain(`Command tool compatibility rule (${name})`)
    expect(payload.instructions).toContain(instructionText)
    expect(payload.instructions).not.toContain('native Windows paths')
    expect(tool.parameters).toEqual(originalParameters)
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

function imageAttachments() {
  return {
    imageLimits: {
      maxImageBytes: 10_000,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 100_000,
      maxImagePixels: 10_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
    },
    readImage: async () => { throw new Error('unused') },
  }
}

function pwshTool() {
  return commandTool('pwsh', 'Run PowerShell.')
}

function commandTool(name: string, description = `Run ${name}.`) {
  return {
    name,
    description,
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
