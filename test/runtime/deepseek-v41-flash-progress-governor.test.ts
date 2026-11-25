import { describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_V41_FLASH_PROGRESS_PREFIX,
  installDeepSeekV41FlashOptimizations,
  installDeepSeekV41FlashProgressGovernor,
} from '../../src/host/runtime/deepseek-v41-flash/index.ts'

type Listener = (...args: unknown[]) => unknown
type Chunk = { type: string; text?: string }

function createHost() {
  const listeners = new Map<string, Listener[]>()
  const warnings: string[] = []
  const agents = new Map<string, unknown>()
  const ctx = {
    on(event: string, fn: Listener) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const cur = listeners.get(event) ?? []
        const idx = cur.indexOf(fn)
        if (idx >= 0) cur.splice(idx, 1)
      }
    },
    get(name: string) {
      return name === 'agents' ? agents : undefined
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }
  const waterfall = async <T>(event: string, args: unknown[], terminal: () => T): Promise<T> => {
    const list = [...(listeners.get(event) ?? [])]
    let idx = 0
    const next = (): unknown => (idx >= list.length ? terminal() : list[idx++]!(...args, next))
    return await (next() as Promise<T>)
  }
  const stream = async (request: Record<string, unknown>, chunks: Chunk[]): Promise<Chunk[]> => {
    const list = [...(listeners.get('llm/stream') ?? [])]
    let idx = 0
    const next = (): AsyncIterable<Chunk> => {
      if (idx >= list.length) return (async function* () { for (const chunk of chunks) yield chunk })()
      return list[idx++]!(request, next) as AsyncIterable<Chunk>
    }
    const out: Chunk[] = []
    for await (const chunk of next()) out.push(chunk)
    return out
  }
  return { ctx, listeners, warnings, agents, waterfall, stream }
}

function makeAgent(provider: string, model: string, sessionId: string) {
  return {
    id: sessionId,
    session: { header: { id: sessionId }, requestHeader: () => ({ config: { provider, model } }) },
    model: { current: () => ({ provider, model }) },
    options: { provider, model },
    cancel: vi.fn(),
    steer: vi.fn(),
  }
}

type Agent = ReturnType<typeof makeAgent>
type Decision = { kind: string; messages: Array<{ content?: Array<{ text?: string }> }> }

const FLASH = ['opendesign', 'deepseek-v4.1-flash-1017'] as const
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const reasoning = (chars: number, size = 50): Chunk[] => Array.from({ length: Math.ceil(chars / size) }, () => ({ type: 'reasoning-delta', text: 'x'.repeat(size) }))

function driver(host: ReturnType<typeof createHost>, agent: Agent) {
  const step = async (messages: unknown[] = []): Promise<Decision> => await host.waterfall<Decision>(
    'agent/pre-step',
    [{ agent, messages }],
    () => ({ kind: 'enter', messages: messages as Decision['messages'] }),
  )
  const tool = async (name: string, args: unknown, text = 'same output', isError = false, parent?: string) => await host.waterfall(
    'tools/post-execute',
    [{ name, arguments: args, agent, ...(parent === undefined ? {} : { parent }) }, { isError, content: [{ type: 'text', text }] }],
    () => ({ kind: 'accept' }),
  )
  const notices = (decision: Decision): string[] => decision.messages
    .map(message => message.content?.[0]?.text ?? '')
    .filter(text => text.startsWith(DEEPSEEK_V41_FLASH_PROGRESS_PREFIX))
  return { step, tool, notices }
}

describe('DeepSeek V4.1 Flash progress governor', () => {
  it('stays silent while each step adds new evidence, edits, or completed tasks', async () => {
    const host = createHost()
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx)
    const agent = makeAgent(...FLASH, 'healthy')
    const { step, tool, notices } = driver(host, agent)
    await step([user('Refactor the parser')])
    for (let i = 0; i < 30; i += 1) {
      expect(notices(await step())).toEqual([])
      if (i % 3 === 0) await tool('read', { file_path: `src/f${i}.ts` }, `body ${i}`)
      else if (i % 3 === 1) await tool('edit', { file_path: `src/f${i}.ts` })
      else await tool('todo_write', { todos: [{ content: `task ${i}`, status: 'completed' }] })
    }
    dispose()
  })

  it('escalates verify, replan, then ask-the-user when evidence keeps repeating', async () => {
    const host = createHost()
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx)
    const agent = makeAgent(...FLASH, 'stalled')
    const { step, tool, notices } = driver(host, agent)
    await step([user('Fix the flaky test')])
    const seen: string[] = []
    for (let i = 0; i < 24; i += 1) {
      seen.push(...notices(await step()))
      await tool('read', { file_path: 'src/flaky.ts' })
      await tool('bash', { command: 'npm test' }, 'still failing', true)
    }
    expect(seen).toHaveLength(3)
    expect(seen[0]).toContain('level=1 | steps=6')
    expect(seen[0]).toContain('minimal tool call')
    expect(seen[1]).toContain('level=2')
    expect(seen[1]).toContain('single next action')
    expect(seen[2]).toContain('level=3')
    expect(seen[2]).toContain('ask_user_question')
    expect(seen[2]).toContain('Do not claim the task is complete')
    dispose()
  })

  it('escalates on accumulated reasoning without progress, and progress clears it', async () => {
    const host = createHost()
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx, {
      stepThresholds: [50, 60, 70],
      reasoningCharThresholds: [100, 200, 300],
    })
    const agent = makeAgent(...FLASH, 'thinker')
    host.agents.set('thinker', agent)
    const { step, tool, notices } = driver(host, agent)
    const request = { provider: FLASH[0], model: FLASH[1], sessionId: 'thinker' }
    await step([user('Design the cache layer')])
    await host.stream(request, reasoning(150))
    const first = notices(await step())
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('level=1')
    await tool('edit', { file_path: 'src/cache.ts' })
    await host.stream(request, reasoning(90, 30))
    expect(notices(await step())).toEqual([])
    dispose()
  })

  it('never cuts fresh reasoning, but cuts an already-stalled attempt and resumes one level higher', async () => {
    const host = createHost()
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx, {
      stepThresholds: [2, 40, 50],
      reasoningCharThresholds: [1_000_000, 2_000_000, 3_000_000],
      streamCutChars: 100,
    })
    const agent = makeAgent(...FLASH, 'cutter')
    host.agents.set('cutter', agent)
    const { step, notices } = driver(host, agent)
    const request = { provider: FLASH[0], model: FLASH[1], sessionId: 'cutter' }
    await step([user('Investigate the deadlock')])

    // 未停滞：再长的推理也完整放行。
    expect(await host.stream(request, reasoning(1000))).toHaveLength(20)
    expect(agent.cancel).not.toHaveBeenCalled()

    await step()
    expect(notices(await step())[0]).toContain('level=1')

    const cut = await host.stream(request, reasoning(1000))
    expect(cut.length).toBeLessThan(20)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'deepseek-v41-flash-progress-governor' }, { keepInbox: true })
    await Promise.resolve()
    const resumed = agent.steer.mock.calls[0]?.[0] as { content: Array<{ text: string }>; source: { form?: string } }
    expect(resumed.content[0]!.text).toContain('level=2')
    expect(resumed.content[0]!.text).toContain('interrupted')
    expect(resumed.source.form).toBe('notice')

    await host.stream(request, reasoning(1000))
    await Promise.resolve()
    expect((agent.steer.mock.calls[1]?.[0] as { content: Array<{ text: string }> }).content[0]!.text).toContain('level=3')

    // 每次请求最多截断两次。
    expect(await host.stream(request, reasoning(1000))).toHaveLength(20)
    expect(agent.cancel).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('treats a user answer or a new user message as progress and re-arms the budget', async () => {
    const host = createHost()
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx, { stepThresholds: [1, 2, 3] })
    const agent = makeAgent(...FLASH, 'asker')
    const { step, tool, notices } = driver(host, agent)
    await step([user('Ship the release')])
    const levels: string[] = []
    for (let i = 0; i < 3; i += 1) levels.push(...notices(await step()))
    expect(levels.at(-1)).toContain('level=3')
    await tool('ask_user_question', { questions: [] }, 'answer: use the beta channel')
    expect(notices(await step())[0]).toContain('level=1 | steps=1')
    await step([user('Also bump the changelog')])
    expect(notices(await step())[0]).toContain('level=1 | steps=1')
    dispose()
  })

  it('leaves other models, disabled installs, and non-conversation calls untouched', async () => {
    for (const [provider, model] of [['deepseek-official', 'deepseek-v4-pro'], ['kimi-code', 'k3.1-pro']] as const) {
      const host = createHost()
      const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx, { stepThresholds: [1, 2, 3] })
      const agent = makeAgent(provider, model, `other-${model}`)
      for (let i = 0; i < 5; i += 1) {
        const decision = { kind: 'enter', messages: [] }
        expect(await host.waterfall('agent/pre-step', [{ agent, messages: [] }], () => decision)).toBe(decision)
      }
      dispose()
    }

    const host = createHost()
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx, { enabled: () => false, stepThresholds: [1, 2, 3] })
    const agent = makeAgent(...FLASH, 'off')
    host.agents.set('off', agent)
    for (let i = 0; i < 5; i += 1) {
      const decision = { kind: 'enter', messages: [] }
      expect(await host.waterfall('agent/pre-step', [{ agent, messages: [] }], () => decision)).toBe(decision)
    }
    dispose()

    const live = createHost()
    const disposeLive = installDeepSeekV41FlashProgressGovernor(live.ctx, { stepThresholds: [1, 2, 3], streamCutChars: 10 })
    const liveAgent = makeAgent(...FLASH, 'aux')
    live.agents.set('aux', liveAgent)
    await driver(live, liveAgent).step()
    const chunks = await live.stream({ provider: FLASH[0], model: FLASH[1], sessionId: 'aux', purpose: 'compaction' }, reasoning(500))
    expect(chunks).toHaveLength(10)
    expect(liveAgent.cancel).not.toHaveBeenCalled()
    disposeLive()
  })

  it('rejects invalid thresholds and releases every listener on dispose', () => {
    const host = createHost()
    expect(() => installDeepSeekV41FlashProgressGovernor(host.ctx, { stepThresholds: [5, 5, 9] })).toThrow(/strictly increasing/)
    const dispose = installDeepSeekV41FlashProgressGovernor(host.ctx)
    expect(host.listeners.get('llm/stream')).toHaveLength(1)
    dispose()
    dispose()
    for (const list of host.listeners.values()) expect(list).toHaveLength(0)
  })

  it('is wired into the DeepSeek V4.1 Flash optimization bundle', async () => {
    const host = createHost()
    const handle = installDeepSeekV41FlashOptimizations(host.ctx, {
      skipCollapseGuard: true,
      progressGovernorOptions: { stepThresholds: [2, 3, 4] },
    })
    const agent = makeAgent(...FLASH, 'bundle')
    const { step, notices } = driver(host, agent)
    await step([user('Migrate the settings store')])
    await step()
    expect(notices(await step())[0]).toContain('level=1')
    handle.dispose()
    for (const list of host.listeners.values()) expect(list).toHaveLength(0)
  })
})
