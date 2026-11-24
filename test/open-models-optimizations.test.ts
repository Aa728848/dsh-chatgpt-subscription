import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import {
  DEFAULT_SKIP_PROVIDERS,
  shouldSkipPruningForSession,
} from '../src/entry-tool-result-pruner.ts'
import { cacheWarmupNavigationIntentOf } from '../src/host/cache-warmup/retrieval-intent.ts'
import {
  createReadOnlySpinTracker,
  createToolRunawayGuard,
  renderAbabActionCycleReminder,
  renderReadOnlySpinReminder,
} from '../src/host/common/tool-runaway.ts'
import {
  buildGlmAnthropicRequest,
  closeGlmAnthropicStream,
  createGlmAnthropicStreamState,
  processGlmAnthropicStreamLine,
} from '../src/host/glm-coding-plan/mapper-anthropic.ts'
import {
  installMinimaxRuntimeEnhancements,
  isMinimaxArgumentRepairSession,
  isMinimaxSession,
} from '../src/host/minimax-code/runtime-enhancements.ts'
import {
  OPEN_MODEL_ANCHOR_PREFIX,
  OPEN_MODEL_ANCHOR_SOURCE_KIND,
  OPEN_MODEL_GUARD_NOTICE_SOURCE_KIND,
  installOpenModelDiscipline,
  installOpenModelObservationGuard,
  installOpenModelStateAnchor,
  installOpenModelsOptimizations,
  isOpenModelCacheWarmupProtected,
  isOpenModelPrefixCacheProtected,
  matchOpenModelProfile,
  resolveOpenModelsOptimizationEnabled,
  stripEscAnsiSequences,
} from '../src/host/open-models/index.ts'
import {
  PTC_SDK_SECTION_NAME,
  installPtcSdkCacheGuard,
} from '../src/host/ptc-sdk-cache-guard.ts'
import {
  TIMELINE_SECTION,
  installTimelineCacheGuard,
} from '../src/host/timeline-cache-guard.ts'

type Listener = (...args: unknown[]) => unknown

function createFakeHost() {
  const listeners = new Map<string, Listener[]>()
  const guards: Array<(execution: unknown) => string | undefined> = []
  const agents = new Map<string, unknown>()
  const toolsRegistry = {
    guard: (fn: (execution: unknown) => string | undefined) => {
      guards.push(fn)
      return () => {
        const idx = guards.indexOf(fn)
        if (idx >= 0) guards.splice(idx, 1)
      }
    },
    get: (_name: string) => undefined as unknown,
    definitions: (_scope?: unknown, toolSet?: unknown) => (toolSet === undefined ? [{ name: 'a' }, { name: 'b' }] : [{ name: 'a' }]),
  }
  const ctx = {
    on(event: string, listener: Listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event)
        if (!current) return
        const idx = current.indexOf(listener)
        if (idx >= 0) current.splice(idx, 1)
      }
    },
    get(name: string) {
      if (name === 'agents') return { get: (id: unknown) => (typeof id === 'string' ? agents.get(id) : undefined) }
      if (name === 'tools') return toolsRegistry
      return undefined
    },
    tools: toolsRegistry,
    logger: { warn: vi.fn() },
  }

  const runWaterfall = async <T>(event: string, args: unknown[], terminal: () => Promise<T> | T): Promise<T> => {
    const chain = listeners.get(event) ?? []
    let index = 0
    const dispatch = (): Promise<T> | T => {
      if (index >= chain.length) return terminal()
      const fn = chain[index++]!
      return fn(...args, dispatch) as Promise<T> | T
    }
    return await dispatch()
  }

  const runStreamWaterfall = <T>(
    request: unknown,
    terminal: () => AsyncIterable<T>,
  ): AsyncIterable<T> => {
    const chain = listeners.get('llm/stream') ?? []
    let index = 0
    const dispatch = (): AsyncIterable<T> => {
      if (index >= chain.length) return terminal()
      const fn = chain[index++]!
      return fn(request, dispatch) as AsyncIterable<T>
    }
    return dispatch()
  }

  return { ctx, listeners, guards, agents, toolsRegistry, runWaterfall, runStreamWaterfall }
}

function createFakeAgent(options: {
  provider: string
  model: string
  sessionId?: string
  events?: Array<{ type: string; data: unknown }>
}) {
  const sessionId = options.sessionId ?? `sess-${options.provider}-${options.model}`
  return {
    id: sessionId,
    cancel: vi.fn(),
    steer: vi.fn(),
    model: {
      current: () => ({ provider: options.provider, model: options.model }),
    },
    session: {
      header: { id: sessionId },
      requestHeader: () => ({ config: { provider: options.provider, model: options.model } }),
      events: options.events ?? [],
    },
  }
}

describe('开源模型精准识别与隔离矩阵', () => {
  it('按物理架构准确归类全部主力开源模型，跨线路生效', () => {
    // Kimi K3 与 K3.1 精准分家族（短别名仅在 kimi-code 线路匹配）
    expect(matchOpenModelProfile('k3', 'kimi-code')?.family).toBe('kimi-k3')
    expect(matchOpenModelProfile('k3-256k', 'kimi-code')?.family).toBe('kimi-k3')
    expect(matchOpenModelProfile('kimi-for-coding', 'kimi-code')?.family).toBe('kimi-k3')
    expect(matchOpenModelProfile('k3.1-pro', 'kimi-code')?.family).toBe('kimi-k31')
    expect(matchOpenModelProfile('k3.1-pro-highspeed', 'kimi-code')?.family).toBe('kimi-k31')
    expect(matchOpenModelProfile('moonshotai/Kimi-K3.1-Pro', 'command-code')?.family).toBe('kimi-k31')
    expect(matchOpenModelProfile('kimi-k3-1', 'workbuddy-subscription')?.family).toBe('kimi-k31')

    // GLM-5.x
    expect(matchOpenModelProfile('GLM-5.3', 'glm-coding-plan')?.family).toBe('glm-5')
    expect(matchOpenModelProfile('GLM-5.3-Flash', 'glm-coding-plan')?.family).toBe('glm-5')
    expect(matchOpenModelProfile('z-ai/glm-5.3-flashx', 'command-code')?.family).toBe('glm-5')
    expect(matchOpenModelProfile('zai-org/GLM-5.2', 'command-code')?.family).toBe('glm-5')
    expect(matchOpenModelProfile('GLM-5-Turbo', 'glm-coding-plan')?.family).toBe('glm-5')

    // DeepSeek-V4 Pro / V4 Flash（非 V4.1 Flash）
    expect(matchOpenModelProfile('deepseek/deepseek-v4-pro', 'command-code')?.family).toBe('deepseek-v4')
    expect(matchOpenModelProfile('deepseek-v4-pro-0813', 'deepseek')?.family).toBe('deepseek-v4')
    expect(matchOpenModelProfile('deepseek-v4-flash-0731', 'qianwen-token-plan')?.family).toBe('deepseek-v4')

    // MiniMax M3 / M3.1 / M2.7
    expect(matchOpenModelProfile('MiniMax-M3', 'minimax-code')?.family).toBe('minimax-m3')
    expect(matchOpenModelProfile('minimax/minimax-m3.1-flash:free', 'command-code')?.family).toBe('minimax-m3')
    expect(matchOpenModelProfile('MiniMax-M2.7', 'workbuddy-subscription')?.family).toBe('minimax-m3')

    // Qwen 3/3.6/3.8/4 / QwQ
    expect(matchOpenModelProfile('qwen4-max', 'qianwen-token-plan')?.family).toBe('qwen-open')
    expect(matchOpenModelProfile('Qwen/Qwen3.8-27B', 'command-code')?.family).toBe('qwen-open')
    expect(matchOpenModelProfile('qwen3:32b', 'ollama')?.family).toBe('qwen-open')
    expect(matchOpenModelProfile('qwq:32b', 'ollama')?.family).toBe('qwen-open')

    // Step 3.5 / 3.7 / 5 与 step-code 运行时发现模型
    expect(matchOpenModelProfile('stepfun/Step-5-Preview', 'command-code')?.family).toBe('step-open')
    expect(matchOpenModelProfile('stepfun/Step-3.7-Flash', 'command-code')?.family).toBe('step-open')
    expect(matchOpenModelProfile('step-next-custom', 'step-code')?.family).toBe('step-open')

    // MiMo / Ling / Hy4 / LongCat / Ollama 本地推理
    expect(matchOpenModelProfile('xiaomi/mimo-v2.6-pro', 'command-code')?.family).toBe('mimo-open')
    expect(matchOpenModelProfile('inclusionai/ling-3.1-flash-1019', 'command-code')?.family).toBe('long-sparse-open')
    expect(matchOpenModelProfile('tencent/hy4-preview', 'command-code')?.family).toBe('long-sparse-open')
    expect(matchOpenModelProfile('hy4flash', 'workbuddy-subscription')?.family).toBe('long-sparse-open')
    expect(matchOpenModelProfile('meituan/LongCat-2.0', 'command-code')?.family).toBe('long-sparse-open')
    expect(matchOpenModelProfile('deepseek-r1:70b', 'ollama')?.family).toBe('long-sparse-open')
    expect(matchOpenModelProfile('gpt-oss:120b', 'ollama')?.family).toBe('long-sparse-open')
  })

  it('绝不重叠 DeepSeek V4.1 Flash，且 100% 放行全部闭源模型', () => {
    // DeepSeek V4.1 Flash 由专属模块处理，绝不双重命中
    expect(matchOpenModelProfile('deepseek-v4.1-flash', 'opendesign')).toBeUndefined()
    expect(matchOpenModelProfile('deepseek/deepseek-v4.1-flash-1017', 'command-code')).toBeUndefined()
    expect(matchOpenModelProfile('deepseek-flash', 'deepseek-official')).toBeUndefined()

    // 闭源模型一律放行
    for (const closed of [
      ['claude-opus-5-5', 'claude'],
      ['claude-sonnet-5-5', 'command-code'],
      ['gpt-6-astra', 'codex-chatgpt'],
      ['gpt-5.4', 'command-code'],
      ['o3', 'opendesign'],
      ['google/gemini-4-argon', 'antigravity-acp'],
      ['xai/grok-4.7', 'command-code'],
      // 短别名 `k3` 仅在 kimi-code 线路有效，不误伤非 Kimi 线路的同名占位符
      ['k3', 'claude'],
    ] as const) {
      expect(matchOpenModelProfile(closed[0], closed[1])).toBeUndefined()
    }
  })
})

describe('静态尾部纪律注入（零破缓存、末尾追加、差异化规则）', () => {
  it('追加在系统提示词末尾并逐字节恒定；Kimi 含 JS/路径/ANSI 规则，DeepSeek-V4 Pro 不加 V4.1-Flash 强排版约束', async () => {
    const host = createFakeHost()
    const dispose = installOpenModelDiscipline(host.ctx)

    const kimiAgent = createFakeAgent({ provider: 'command-code', model: 'moonshotai/Kimi-K3.1-Pro' })
    const kimi1 = await host.runWaterfall('system-prompt/assemble', [{}, { scope: kimiAgent }], () => ({
      sections: [
        { name: 'persona', text: 'P' },
        { name: 'tools:sdk', text: 'SDK' },
      ] as Array<{ name: string; text: string; interpolate?: boolean }>,
    }))
    const kimi2 = await host.runWaterfall('system-prompt/assemble', [{}, { scope: kimiAgent }], () => ({
      sections: [
        { name: 'persona', text: 'P' },
        { name: 'tools:sdk', text: 'SDK' },
      ] as Array<{ name: string; text: string; interpolate?: boolean }>,
    }))
    expect(kimi1.sections).toHaveLength(3)
    expect(kimi1.sections[0]?.name).toBe('persona')
    expect(kimi1.sections[1]?.name).toBe('tools:sdk')
    expect(kimi1.sections[2]?.name).toBe('plugin:open-model-discipline:kimi-k31')
    expect(kimi1.sections[2]?.interpolate).toBe(false)
    expect(kimi1.sections[2]?.text).toBe(kimi2.sections[2]?.text)
    expect(String(kimi1.sections[2]?.text)).toContain('plain valid JavaScript')
    expect(String(kimi1.sections[2]?.text)).toContain('[0m')
    expect(String(kimi1.sections[2]?.text)).toContain('hardcoding expected outputs')
    expect(String(kimi1.sections[2]?.text)).toContain('suspected prompt injection')

    // 普通 Kimi K3：保留公共纪律，但不混入 K3.1 Pro 专属条款
    const k3OnlyAgent = createFakeAgent({ provider: 'kimi-code', model: 'k3' })
    const k3Only = await host.runWaterfall('system-prompt/assemble', [{}, { scope: k3OnlyAgent }], () => ({
      sections: [{ name: 'persona', text: 'P' }],
    }))
    expect(k3Only.sections).toHaveLength(2)
    expect(k3Only.sections[1]?.name).toBe('plugin:open-model-discipline:kimi-k3')
    expect(String(k3Only.sections[1]?.text)).toContain('plain valid JavaScript')
    expect(String(k3Only.sections[1]?.text)).not.toContain('hardcoding expected outputs')

    // DeepSeek-V4 Pro：有轻量执行纪律，但没有 V4.1-Flash 的强输出排版段
    const v4ProAgent = createFakeAgent({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    const v4Pro = await host.runWaterfall('system-prompt/assemble', [{}, { scope: v4ProAgent }], () => ({
      sections: [{ name: 'persona', text: 'P' }],
    }))
    expect(v4Pro.sections).toHaveLength(2)
    expect(String(v4Pro.sections[1]?.text)).toContain('DeepSeek V4 Execution Guidance')
    expect(String(v4Pro.sections[1]?.text)).not.toContain('Readable final responses')

    // 闭源模型与 V4.1 Flash 原引用透传
    const baseline = { sections: [{ name: 'persona', text: 'P' }] }
    const claudeAgent = createFakeAgent({ provider: 'claude', model: 'claude-opus-5-5' })
    const claudeRes = await host.runWaterfall('system-prompt/assemble', [{}, { scope: claudeAgent }], () => baseline)
    expect(claudeRes).toBe(baseline)

    const v41Agent = createFakeAgent({ provider: 'opendesign', model: 'deepseek-v4.1-flash' })
    const v41Res = await host.runWaterfall('system-prompt/assemble', [{}, { scope: v41Agent }], () => baseline)
    expect(v41Res).toBe(baseline)

    dispose()
  })
})

describe('零改前缀尾部 State Anchor（适配 SWA 短窗与 1M 稀疏/线性模型）', () => {
  it('Step / MiMo 短窗按 8 步周期触发，Kimi K3.1 按水位与连败触发，且不干扰导航意图判定', async () => {
    const host = createFakeHost()
    let currentTokens = 20_000
    const dispose = installOpenModelStateAnchor(host.ctx, {
      estimateContextTokens: () => currentTokens,
    })

    // 1) MiMo SWA-128：8 步触发周期锚点
    const mimoAgent = createFakeAgent({ provider: 'command-code', model: 'xiaomi/mimo-v2.6-pro', sessionId: 'mimo-1' })
    await host.runWaterfall(
      'agent/pre-step',
      [{ agent: mimoAgent, messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix parser edge case in auth.ts' }] }] }],
      () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix parser edge case in auth.ts' }] }] }),
    )
    await host.runWaterfall(
      'tools/post-execute',
      [{ name: 'read', arguments: { file_path: 'src/auth.ts' }, agent: mimoAgent }, { isError: false }],
      () => ({ kind: 'accept' }),
    )

    let anchored: { messages?: Array<{ source?: { kind?: string }; content?: Array<{ text?: string }> }> } | undefined
    for (let step = 1; step <= 8; step += 1) {
      const res = await host.runWaterfall(
        'agent/pre-step',
        [{ agent: mimoAgent, messages: [] }],
        () => ({ kind: 'enter', messages: [] }),
      ) as { messages?: Array<{ source?: { kind?: string }; content?: Array<{ text?: string }> }> }
      if (step < 8) {
        expect(res.messages).toHaveLength(0)
      } else {
        anchored = res
      }
    }
    expect(anchored?.messages).toHaveLength(1)
    expect(anchored?.messages?.[0]?.source?.kind).toBe(OPEN_MODEL_ANCHOR_SOURCE_KIND)
    const anchorText = anchored?.messages?.[0]?.content?.[0]?.text ?? ''
    expect(anchorText).toContain(`${OPEN_MODEL_ANCHOR_PREFIX} | model=MiMo | step=8`)
    expect(anchorText).toContain('GOAL: Fix parser edge case in auth.ts')
    expect(anchorText).toContain('FILES: src/auth.ts')

    // 2) Kimi K3.1：跨越 160K 水位线触发水位锚点
    const kimiAgent = createFakeAgent({ provider: 'kimi-code', model: 'k3.1-pro', sessionId: 'kimi-1' })
    await host.runWaterfall(
      'agent/pre-step',
      [{ agent: kimiAgent, messages: [{ role: 'user', content: [{ type: 'text', text: 'Implement cache guard' }] }] }],
      () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'Implement cache guard' }] }] }),
    )
    currentTokens = 170_000
    const watermarkRes = await host.runWaterfall(
      'agent/pre-step',
      [{ agent: kimiAgent, messages: [] }],
      () => ({ kind: 'enter', messages: [] }),
    ) as { messages?: Array<{ content?: Array<{ text?: string }> }> }
    expect(watermarkRes.messages).toHaveLength(1)
    expect(watermarkRes.messages?.[0]?.content?.[0]?.text).toContain('model=Kimi-K3.1')
    expect(watermarkRes.messages?.[0]?.content?.[0]?.text).toContain('trigger=watermark')

    // 3) 检索意图分类器必须跳过 `[Open-Model State Anchor]`
    const navAgent = createFakeAgent({
      provider: 'kimi-code',
      model: 'k3.1-pro',
      events: [
        { type: 'user/message', data: { text: 'Locate all route definitions' } },
        { type: 'user/message', data: { text: `${OPEN_MODEL_ANCHOR_PREFIX} | model=Kimi-K3 | step=10]\nGOAL: Fix edit bug` } },
      ],
    })
    expect(cacheWarmupNavigationIntentOf(navAgent)).toBe(true)

    dispose()
  })
})

describe('Kimi K3/K3.1 专属防线（只读空转、ESC ANSI 清洗、入库前观测头）与官方 V4 Pro 失控提醒', () => {
  it('Kimi K3.1 连续变参只读空转在高上下文（>=200K）第 6 步提醒；写操作归零；纯导航任务不误触', async () => {
    const host = createFakeHost()
    const dispose = installOpenModelObservationGuard(host.ctx, {
      estimateContextTokens: () => 220_000,
    })

    // 编辑型任务：前 5 次不提醒，第 6 次不同文件的只读调用触发温和提醒，第 7 次不再重复
    const editAgent = createFakeAgent({
      provider: 'command-code',
      model: 'moonshotai/Kimi-K3.1-Pro',
      sessionId: 'kimi-spin-edit',
      events: [{ type: 'user/message', data: { text: '修复登录路由的错误处理并更新测试' } }],
    })
    for (let i = 1; i <= 5; i += 1) {
      const res = await host.runWaterfall(
        'tools/post-execute',
        [{ name: i % 2 === 0 ? 'grep' : 'read', arguments: { file_path: `src/f${i}.ts` }, agent: editAgent }, { content: [{ type: 'text', text: 'short' }], isError: false }],
        () => ({ kind: 'accept' }),
      ) as { additionalContexts?: unknown[] }
      expect(res.additionalContexts).toBeUndefined()
    }
    const sixth = await host.runWaterfall(
      'tools/post-execute',
      [{ name: 'read', arguments: { file_path: 'src/f6.ts' }, agent: editAgent }, { content: [{ type: 'text', text: 'short' }], isError: false }],
      () => ({ kind: 'accept' }),
    ) as { additionalContexts?: Array<{ source?: { kind?: string }; content?: Array<{ text?: string }> }> }
    expect(sixth.additionalContexts).toHaveLength(1)
    expect(sixth.additionalContexts?.[0]?.source?.kind).toBe(OPEN_MODEL_GUARD_NOTICE_SOURCE_KIND)
    expect(sixth.additionalContexts?.[0]?.content?.[0]?.text).toContain('6 consecutive read-only')

    // 导航/调研型任务不误触只读空转提醒
    const navAgent = createFakeAgent({
      provider: 'kimi-code',
      model: 'k3.1-pro',
      sessionId: 'kimi-spin-nav',
      events: [{ type: 'user/message', data: { text: '查找并列出项目里所有 provider 路由在哪里' } }],
    })
    for (let i = 1; i <= 10; i += 1) {
      const res = await host.runWaterfall(
        'tools/post-execute',
        [{ name: 'read', arguments: { file_path: `src/nav${i}.ts` }, agent: navAgent }, { content: [{ type: 'text', text: 'short' }], isError: false }],
        () => ({ kind: 'accept' }),
      ) as { additionalContexts?: unknown[] }
      expect(res.additionalContexts).toBeUndefined()
    }

    // ReadOnlySpinTracker 写操作归零与协调工具豁免
    const tracker = createReadOnlySpinTracker()
    expect(tracker.observe('read')).toBe(1)
    expect(tracker.observe('progress_update')).toBe(1)
    expect(tracker.observe('grep')).toBe(2)
    expect(tracker.observe('edit')).toBe(0)
    expect(renderReadOnlySpinReminder(6)).toContain('6 consecutive read-only')

    dispose()
  })

  it('Kimi K3/K3.1 无损清除真实 ESC ANSI 控制码，不误删普通代码 [0m，不触碰非 Kimi 流', async () => {
    expect(stripEscAnsiSequences('hello \u001b[1;31mworld\u001b[0m and literal [0m')).toBe('hello world and literal [0m')

    const host = createFakeHost()
    const dispose = installOpenModelObservationGuard(host.ctx)

    const chunks: Array<{ type: string; text?: string; block?: { type: string; text: string } }> = []
    const kimiStream = host.runStreamWaterfall(
      { provider: 'kimi-code', model: 'k3.1-pro', sessionId: 's1' },
      async function* () {
        yield { type: 'text-delta', text: 'Done \u001b[0m\u001b[1mok [0m' }
        yield { type: 'block-end', block: { type: 'text', text: 'Done \u001b[0mok' } }
      },
    )
    for await (const chunk of kimiStream) chunks.push(chunk as never)
    expect(chunks[0]?.text).toBe('Done ok [0m')
    expect(chunks[1]?.block?.text).toBe('Done ok')

    // Claude 流原样透传
    const claudeChunks: Array<{ type: string; text?: string }> = []
    const claudeStream = host.runStreamWaterfall(
      { provider: 'claude', model: 'claude-opus-5-5', sessionId: 's2' },
      async function* () {
        yield { type: 'text-delta', text: '\u001b[32mraw\u001b[0m' }
      },
    )
    for await (const chunk of claudeStream) claudeChunks.push(chunk as never)
    expect(claudeChunks[0]?.text).toBe('\u001b[32mraw\u001b[0m')

    dispose()
  })

  it('大块根级观测前置 [OBS] 头（不动嵌套子调用或 decision.value），官方 DeepSeek-V4 Pro 触发 A-B-A-B 循环提醒', async () => {
    const host = createFakeHost()
    const dispose = installOpenModelObservationGuard(host.ctx, { minChars: 50 })

    const glmAgent = createFakeAgent({ provider: 'glm-coding-plan', model: 'GLM-5.3', sessionId: 'glm-obs' })
    const longText = 'x'.repeat(120)
    const tagged = await host.runWaterfall(
      'tools/post-execute',
      [{ name: 'read', arguments: { file_path: 'src\\foo.ts' }, agent: glmAgent }, { content: [{ type: 'text', text: longText }], isError: false }],
      () => ({ kind: 'accept', content: [{ type: 'text', text: longText }] }),
    ) as { content?: Array<{ text?: string }> }
    expect(tagged.content?.[0]?.text).toMatch(/^\[OBS \| tool=read \| target=src\/foo\.ts \| status=ok\]\n/)

    // decision.value 存在时不改写
    const structured = { kind: 'accept', value: { lines: [1, 2] } }
    const untouched = await host.runWaterfall(
      'tools/post-execute',
      [{ name: 'read', arguments: { file_path: 'src/foo.ts' }, agent: glmAgent }, { content: [{ type: 'text', text: longText }], isError: false }],
      () => structured,
    )
    expect(untouched).toBe(structured)

    // 官方 DeepSeek-V4 Pro 触发 A-B-A-B 交替循环提醒
    const v4Agent = createFakeAgent({ provider: 'deepseek', model: 'deepseek-v4-pro', sessionId: 'v4-abab' })
    const calls = [
      ['grep', { pattern: 'foo' }],
      ['read', { file_path: 'a.ts' }],
      ['grep', { pattern: 'foo' }],
      ['read', { file_path: 'a.ts' }],
    ] as const
    let lastDecision: { additionalContexts?: Array<{ content?: Array<{ text?: string }> }> } | undefined
    for (const [name, args] of calls) {
      lastDecision = await host.runWaterfall(
        'tools/post-execute',
        [{ name, arguments: args, agent: v4Agent }, { content: [{ type: 'text', text: 'ok' }], isError: false }],
        () => ({ kind: 'accept' }),
      ) as { additionalContexts?: Array<{ content?: Array<{ text?: string }> }> }
    }
    expect(lastDecision?.additionalContexts).toHaveLength(1)
    expect(lastDecision?.additionalContexts?.[0]?.content?.[0]?.text).toContain('A-B-A-B tool loop')
    expect(renderAbabActionCycleReminder(2)).toContain('A-B-A-B')

    const ababGuard = createToolRunawayGuard({ remindOnAbabCycle: true })
    expect(ababGuard.observe({ toolName: 'a', arguments: { x: 1 } })).toBeUndefined()
    expect(ababGuard.observe({ toolName: 'b', arguments: { x: 2 } })).toBeUndefined()
    expect(ababGuard.observe({ toolName: 'a', arguments: { x: 1 } })).toBeUndefined()
    expect(ababGuard.observe({ toolName: 'b', arguments: { x: 2 } })?.kind).toBe('abab_action_cycle')

    dispose()
  })
})

describe('前缀缓存三件套（glm-coding-plan / step-code / ollama + 跨线路开源模型）', () => {
  it('默认跳过名单含 glm-coding-plan / step-code / ollama，且跨线路开源模型免修剪、冻结 SDK 与 Timeline，闭源模型不误伤', async () => {
    expect(DEFAULT_SKIP_PROVIDERS).toContain('glm-coding-plan')
    expect(DEFAULT_SKIP_PROVIDERS).toContain('step-code')
    expect(DEFAULT_SKIP_PROVIDERS).toContain('ollama')

    const sessionOf = (provider: string, model: string) => ({
      requestHeader: () => ({ config: { provider, model } }),
    })

    // 跨线路开源模型跳过修剪
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'moonshotai/Kimi-K3.1-Pro'))).toBe(true)
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'zai-org/GLM-5.3'))).toBe(true)
    expect(shouldSkipPruningForSession(sessionOf('workbuddy-subscription', 'minimax-m3.1-flash'))).toBe(true)
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'stepfun/Step-5-Preview'))).toBe(true)
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'xiaomi/mimo-v2.6-pro'))).toBe(true)
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'inclusionai/ling-3.1-flash'))).toBe(true)
    expect(shouldSkipPruningForSession(sessionOf('deepseek', 'deepseek-v4-pro'))).toBe(true)

    // 聚合线路上的闭源模型不跳过
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'claude-opus-5-5'))).toBe(false)
    expect(shouldSkipPruningForSession(sessionOf('command-code', 'gpt-6-astra'))).toBe(false)

    // PTC SDK 与 Timeline 冻结：glm-coding-plan / step-code / 跨线路 K3.1 冻结，command-code/gpt-6 不冻结
    const host = createFakeHost()
    const ptcGuard = installPtcSdkCacheGuard(host.ctx)
    const timelineGuard = installTimelineCacheGuard(host.ctx)

    const k3Scope = createFakeAgent({ provider: 'command-code', model: 'moonshotai/Kimi-K3.1-Pro' })
    const gptScope = createFakeAgent({ provider: 'command-code', model: 'gpt-6-astra' })
    expect(isOpenModelPrefixCacheProtected(k3Scope)).toBe(true)
    expect(isOpenModelPrefixCacheProtected(gptScope)).toBe(false)
    expect(isOpenModelCacheWarmupProtected('deepseek-v4-pro', 'deepseek')).toBe(true)
    expect(isOpenModelCacheWarmupProtected('gpt-6-astra', 'command-code')).toBe(false)

    await host.runWaterfall('system-prompt/assemble', [{}, { scope: k3Scope }], () => ({
      sections: [
        { name: PTC_SDK_SECTION_NAME, text: 'SDK-1' },
        { name: TIMELINE_SECTION, text: 'TL-1' },
      ],
    }))
    const k3Second = await host.runWaterfall('system-prompt/assemble', [{}, { scope: k3Scope }], () => ({
      sections: [
        { name: PTC_SDK_SECTION_NAME, text: 'SDK-2' },
        { name: TIMELINE_SECTION, text: 'TL-2' },
      ],
    })) as { sections: Array<{ name: string; text: string }> }
    expect(k3Second.sections.find(s => s.name === PTC_SDK_SECTION_NAME)?.text).toBe('SDK-1')
    expect(k3Second.sections.find(s => s.name === TIMELINE_SECTION)?.text).toBe('TL-1')

    await host.runWaterfall('system-prompt/assemble', [{}, { scope: gptScope }], () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-1' }],
    }))
    const gptSecond = await host.runWaterfall('system-prompt/assemble', [{}, { scope: gptScope }], () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-2' }],
    })) as { sections: Array<{ name: string; text: string }> }
    expect(gptSecond.sections.find(s => s.name === PTC_SDK_SECTION_NAME)?.text).toBe('SDK-2')

    ptcGuard.dispose()
    timelineGuard.dispose()
  })
})

describe('MiniMax 跨线路参数修复泛化', () => {
  it('command-code / workbuddy 跑 MiniMax-M3 时自动修复 edits JSON 字符串与数字字符串，但不触发 minimax-code 专属直调提醒', async () => {
    const host = createFakeHost()
    const dispose = installMinimaxRuntimeEnhancements(host.ctx as never)

    const crossMinimax = createFakeAgent({ provider: 'command-code', model: 'MiniMaxAI/MiniMax-M3' })
    const crossClaude = createFakeAgent({ provider: 'command-code', model: 'claude-sonnet-5-5' })
    expect(isMinimaxSession(crossMinimax)).toBe(false)
    expect(isMinimaxArgumentRepairSession(crossMinimax)).toBe(true)
    expect(isMinimaxArgumentRepairSession(crossClaude)).toBe(false)

    const execMinimax = {
      name: 'edit',
      agent: crossMinimax,
      arguments: { edits: '[{"old":"a","new":"b"}]', offset: '12', replace_all: 'true' },
    }
    await host.runWaterfall('tools/pre-execute', [execMinimax], () => undefined)
    expect(execMinimax.arguments.edits).toEqual([{ old: 'a', new: 'b' }])
    expect(execMinimax.arguments.offset).toBe(12)
    expect(execMinimax.arguments.replace_all).toBe(true)

    const execClaude = {
      name: 'edit',
      agent: crossClaude,
      arguments: { edits: '[{"old":"a","new":"b"}]', offset: '12' },
    }
    await host.runWaterfall('tools/pre-execute', [execClaude], () => undefined)
    expect(execClaude.arguments.edits).toBe('[{"old":"a","new":"b"}]')
    expect(execClaude.arguments.offset).toBe('12')

    dispose()
  })
})

describe('GLM Anthropic 兼容面安全签名思考回放（Provenance-Verified Signed Thinking Replay）', () => {
  it('仅回放带有效 signature / redacted_thinking 且来源与内容指纹匹配的思考块，无签名块与跨模型块绝不回放', () => {
    const state = createGlmAnthropicStreamState({
      provider: 'glm-coding-plan',
      route: 'glm-coding-plan',
      model: 'GLM-5.3',
    })
    const sseLines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step 1 check."}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_glm_valid_123"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checked."}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
      'data: {"type":"message_stop"}',
    ]
    const emitted = sseLines.flatMap(line => processGlmAnthropicStreamLine(line, state))
    emitted.push(...closeGlmAnthropicStream(state))
    const finish = emitted.find(chunk => chunk.type === 'finish') as { replayState?: unknown } | undefined
    expect(finish?.replayState).toBeDefined()

    // 1) 同模型 + 同内容：原样回放带 signature 的 thinking 块
    const reqSame = buildGlmAnthropicRequest({
      model: 'GLM-5.3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'check' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Step 1 check.' },
            { type: 'text', text: 'Checked.' },
          ],
          source: { kind: 'assistant', provider: 'glm-coding-plan', model: 'GLM-5.3', replayState: finish?.replayState },
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    } as unknown as GenerateOptions, { ladder: ['low', 'high', 'max'] })

    const assistantMsg = (reqSame.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[1]!
    expect(assistantMsg.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Step 1 check.',
      signature: 'sig_glm_valid_123',
    })

    // 2) 切换模型（GLM-5.3 -> GLM-5.3-Flash）：拒绝回放旧模型签名块
    const reqDifferentModel = buildGlmAnthropicRequest({
      model: 'GLM-5.3-Flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'check' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Step 1 check.' },
            { type: 'text', text: 'Checked.' },
          ],
          source: { kind: 'assistant', provider: 'glm-coding-plan', model: 'GLM-5.3', replayState: finish?.replayState },
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    } as unknown as GenerateOptions, { ladder: ['low', 'high', 'max'] })
    const diffAssistant = (reqDifferentModel.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[1]!
    expect(diffAssistant.content).toEqual([{ type: 'text', text: 'Checked.' }])

    // 3) 无签名思考流：不产出 replayState，也不回放无签名 thinking 块
    const unsignedState = createGlmAnthropicStreamState({
      provider: 'glm-coding-plan',
      route: 'glm-coding-plan',
      model: 'GLM-5.3',
    })
    const unsignedLines = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"raw unsigned"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_stop"}',
    ]
    const unsignedEmitted = unsignedLines.flatMap(line => processGlmAnthropicStreamLine(line, unsignedState))
    unsignedEmitted.push(...closeGlmAnthropicStream(unsignedState))
    const unsignedFinish = unsignedEmitted.find(chunk => chunk.type === 'finish') as { replayState?: unknown } | undefined
    expect(unsignedFinish?.replayState).toBeUndefined()
  })
})

describe('开源模型总成开关与推理坍塌守卫按模型隔离', () => {
  it('openModelsOptimization 活引用开关即时生效，且推理坍塌守卫仅看开源模型不误伤闭源模型', async () => {
    expect(resolveOpenModelsOptimizationEnabled(undefined)).toBe(true)
    expect(resolveOpenModelsOptimizationEnabled({ openModelsOptimization: false })).toBe(false)
    expect(resolveOpenModelsOptimizationEnabled({ openModelsOptimization: { get: () => false } })).toBe(false)

    let active = true
    const host = createFakeHost()
    const glmAgent = createFakeAgent({ provider: 'glm-coding-plan', model: 'GLM-5.3', sessionId: 'glm-collapse' })
    const claudeAgent = createFakeAgent({ provider: 'claude', model: 'claude-opus-5-5', sessionId: 'claude-safe' })
    host.agents.set('glm-collapse', glmAgent)
    host.agents.set('claude-safe', claudeAgent)

    const handle = installOpenModelsOptimizations(host.ctx, {
      enabled: () => active,
      collapseGuardOptions: {
        windowChars: 2000,
        minWindowChars: 400,
        semanticMinChars: 200,
        semanticMinSentences: 6,
        semanticConfirmations: 2,
      },
    })

    const degenerateText = 'Wait, let me verify the same line again. '.repeat(40)
    const glmStream = host.runStreamWaterfall(
      { provider: 'glm-coding-plan', model: 'GLM-5.3', sessionId: 'glm-collapse', signal: new AbortController().signal },
      async function* () {
        for (let i = 0; i < 6; i += 1) {
          yield { type: 'reasoning-delta', text: degenerateText }
        }
      },
    )
    const glmSeen: unknown[] = []
    for await (const chunk of glmStream) glmSeen.push(chunk)
    expect(glmSeen.length).toBeLessThan(6)

    // 闭源 Claude 同样文本不会被开源模型坍塌守卫截断
    const claudeStream = host.runStreamWaterfall(
      { provider: 'claude', model: 'claude-opus-5-5', sessionId: 'claude-safe', signal: new AbortController().signal },
      async function* () {
        for (let i = 0; i < 6; i += 1) {
          yield { type: 'reasoning-delta', text: degenerateText }
        }
      },
    )
    const claudeSeen: unknown[] = []
    for await (const chunk of claudeStream) claudeSeen.push(chunk)
    expect(claudeSeen).toHaveLength(6)

    // 活引用关掉后立刻旁路
    active = false
    const baseline = { sections: [{ name: 'persona', text: 'P' }] }
    const bypassed = await host.runWaterfall('system-prompt/assemble', [{}, { scope: glmAgent }], () => baseline)
    expect(bypassed).toBe(baseline)

    handle.dispose()
  })
})
