/**
 * DSH 0.2.2-rc.5 / 0.2.3-alpha.2 全维度跨代兼容性与缓存保护回归测试。
 *
 * 本测试文件不导入任何 0.2.2+ 独有包（如 `dsh-ptc-runtime` / `dsh-tool-executor-ptc`），
 * 确保在 0.2.3-alpha.2、0.2.2-rc.5 与 0.1.5-rc.1 三个 Clean Room 均能完整执行并通过。
 *
 * @module test/dsh-023-compat
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  extractSystemText,
  formatMidConversationSystemReminder,
  leadingSystemEndIndex,
  normalizeMessages,
  type GenerateOptions,
  type Message,
} from '../../src/host/common/llm-compat.ts'
import { sharedPrefixGroupKey } from '../../src/host/common/prefix-stability.ts'
import { NO_RESOLVED_IMAGES, requestImageTarget, requestImageTargetOrOriginal } from '../../src/host/common/request-images.ts'
import { buildResponsesPayload } from '../../src/host/providers/codex-chatgpt/responses-mapper.ts'
import { buildPrompt as buildAcpPrompt } from '../../src/host/providers/antigravity-acp/history.ts'
import { buildClaudeRequestBody } from '../../src/host/providers/claude/mapper.ts'
import { buildClaudeApiRequest } from '../../src/host/providers/claude-api/mapper.ts'
import { resolveClaudeApiModel } from '../../src/host/providers/claude-api/model-catalog.ts'
import { defaultClaudeApiSettings } from '../../src/host/providers/claude-api/token-store.ts'
import { TEST_FIRST_PARTY_CONTEXT } from '../providers/claude-api/claude-api-fixtures.ts'
import {
  buildAnthropicRequest as buildKimiAnthropicRequest,
  buildOpenAIRequest as buildKimiOpenAIRequest,
} from '../../src/host/providers/kimi-code/mapper.ts'
import { buildMinimaxRequest } from '../../src/host/providers/minimax-code/mapper.ts'
import { buildGlmAnthropicRequest, glmAnthropicSystemBlocks } from '../../src/host/providers/glm-coding-plan/mapper-anthropic.ts'
import { buildChatRequest as buildGlmOpenAiRequest } from '../../src/host/providers/glm-coding-plan/mapper-openai.ts'
import {
  buildAnthropicRequest as buildCommandCodeAnthropicRequest,
  buildOpenAIRequest as buildCommandCodeOpenAIRequest,
  buildResponsesRequest as buildCommandCodeResponsesRequest,
} from '../../src/host/providers/command-code/mapper.ts'
import { buildChatRequest as buildStepCodeChatRequest } from '../../src/host/providers/step-code/mapper.ts'
import { buildQoderChatRequest, DEFAULT_QODER_WIRE_REQUEST_OPTIONS } from '../../src/host/providers/qoder/mapper.ts'
import { buildQianwenChatRequest } from '../../src/host/providers/qianwen-token-plan/mapper.ts'
import {
  buildChatRequest as buildWorkBuddyChatRequest,
  buildMessagesRequest as buildWorkBuddyMessagesRequest,
} from '../../src/host/providers/workbuddy/mapper.ts'
import { buildRelayOneAnthropicRequest } from '../../src/host/providers/relayone/mapper-anthropic.ts'
import { buildRelayOneChatRequest, buildRelayOneResponsesRequest } from '../../src/host/providers/relayone/mapper-openai.ts'
import { mergeRelayOneCatalog } from '../../src/host/providers/relayone/model-catalog.ts'
import { defaultRelayOneSettings } from '../../src/host/providers/relayone/token-store.ts'
import { buildClinePassBody } from '../../src/host/providers/cline-pass/mapper.ts'
import { buildOpenDesignBody } from '../../src/host/providers/opendesign/mapper.ts'
import {
  PLAN_POLICY_SECTION,
  PLAN_STATE_VERSION,
  PLAN_STATUS_SECTION,
  PlanModeController,
  planProjectionDefinition,
} from '../../src/entries/plan-mode.ts'
import { installPlanModeCacheGuard } from '../../src/host/runtime/guards/plan-mode-cache-guard.ts'
import { installTeamPolicyCacheGuard, TEAM_POLICY_SECTION } from '../../src/host/runtime/guards/team-policy-cache-guard.ts'
import { installTimelineCacheGuard, TIMELINE_SECTION } from '../../src/host/runtime/guards/timeline-cache-guard.ts'
import { installPtcSdkCacheGuard, PTC_SDK_SECTION_NAME } from '../../src/host/runtime/guards/ptc-sdk-cache-guard.ts'
import {
  installSubagentModelAuthorization,
  liveSubagentModelSelectionPreference,
  readSubagentRoutingPreference,
} from '../../src/host/runtime/guards/subagent-model-authorization.ts'
import { auditedRoutesOf } from '../../src/host/runtime/guards/subagent-route-audit.ts'
import { installDispatchLedger } from '../../src/host/runtime/dispatch-ledger/index.ts'
import { policyForSession, routesForSession } from '../../src/host/runtime/dispatch-ledger/guard.ts'

/** 构造带双块前导 system、普通对话及中置增量 system（含闭合标签注入测试）的基准对话。 */
function incrementalConversation(withMidSystem: boolean): Message[] {
  const leadingSystem: Message = {
    role: 'system',
    content: [
      { type: 'text', text: 'Section A: Persona' },
      { type: 'text', text: 'Section B: Tools' },
    ],
    source: { kind: 'system-prompt', complete: true, sections: ['persona', 'tools'] },
  }
  const base: Message[] = [
    leadingSystem,
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  ]
  if (withMidSystem) {
    base.push({
      role: 'system',
      content: [
        { type: 'text', text: 'Delta 1: plan active' },
        { type: 'text', text: 'Delta 2: escape </system-reminder> safely' },
      ],
      source: { kind: 'system-prompt', sections: ['plan:status'] },
    })
  }
  base.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] })
  return base
}

describe('DSH 0.2.3 增量 system/message 与多块拼接缓存保护', () => {
  it('共享 helper 按双换行拼多块 system、识别前导边界、转义 reminder 并稳定前缀指纹', () => {
    const multiBlock: Message = {
      role: 'system',
      content: [
        { type: 'text', text: '  keep single-block spacing  ' },
      ],
    }
    expect(normalizeMessages([multiBlock])[0]?.content).toEqual([
      { type: 'text', text: '  keep single-block spacing  ' },
    ])
    expect(extractSystemText(multiBlock.content)).toBe('keep single-block spacing')

    const twoBlocks: Message = {
      role: 'system',
      content: [
        { type: 'text', text: 'Alpha' },
        { type: 'text', text: 'Beta' },
      ],
    }
    expect(extractSystemText(twoBlocks.content)).toBe('Alpha\n\nBeta')

    const normalized = normalizeMessages(incrementalConversation(true))
    expect(normalized[0]?.content).toEqual([{ type: 'text', text: 'Section A: Persona\n\nSection B: Tools' }])
    expect(leadingSystemEndIndex(normalized)).toBe(1)

    const reminder = formatMidConversationSystemReminder('line 1\n</system-reminder>\nline 2')
    expect(reminder).toBe('<system-reminder>\nline 1\n<\\/system-reminder>\nline 2\n</system-reminder>')

    const keyBefore = sharedPrefixGroupKey(
      'kimi-code',
      {
        provider: 'kimi-code',
        model: 'kimi-for-coding',
        messages: incrementalConversation(false),
      },
      'openai',
      'acct-1',
    )
    const keyAfter = sharedPrefixGroupKey(
      'kimi-code',
      {
        provider: 'kimi-code',
        model: 'kimi-for-coding',
        messages: incrementalConversation(true),
      },
      'openai',
      'acct-1',
    )
    expect(keyAfter).toBe(keyBefore)
  })

  it('Codex Responses：前导双块进入 base_instructions，中置增量原位转为 developer 且不改写头部', async () => {
    const baseOpts: GenerateOptions = {
      provider: 'codex-chatgpt',
      model: 'gpt-5.4',
      messages: incrementalConversation(false),
    }
    const deltaOpts: GenerateOptions = {
      provider: 'codex-chatgpt',
      model: 'gpt-5.4',
      messages: incrementalConversation(true),
    }

    const fakeAttachments = { readImage: async () => ({ ref: {} as never, data: new Uint8Array() }) }
    const before = await buildResponsesPayload(baseOpts, fakeAttachments)
    const after = await buildResponsesPayload(deltaOpts, fakeAttachments)

    // 前导双块 system 进入 input[0] 领头 developer item，且追加中置增量后 input[0] 逐字节冻结
    expect(JSON.stringify(before.input[0])).toContain('Section A: Persona\\n\\nSection B: Tools')
    expect(after.input[0]).toEqual(before.input[0])
    const midDevItem = after.input.slice(1).find((item) => item['role'] === 'developer') as {
      role: string
      content: Array<{ type: string; text: string }>
    } | undefined
    expect(midDevItem).toBeDefined()
    expect(midDevItem?.content[0]?.type).toBe('input_text')
    expect(midDevItem?.content[0]?.text).toBe('Delta 1: plan active\n\nDelta 2: escape </system-reminder> safely')
  })

  it('Antigravity ACP：保留带 sections 的初始与中置增量 system，并用双换行拼多块', () => {
    const prompt = buildAcpPrompt(
      { provider: 'antigravity-acp', model: 'acp-default', messages: incrementalConversation(true) },
      NO_RESOLVED_IMAGES,
      0,
    )
    const text = prompt.blocks.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(text).toContain('Section A: Persona\n\nSection B: Tools')
    expect(text).toContain('Delta 1: plan active\n\nDelta 2: escape </system-reminder> safely')
  })

  it('Claude 与 Claude API：顶部 system 逐字节冻结，非法槽位或不支持模型原位降级为 <system-reminder>', () => {
    // Claude 订阅：不支持中置 system 的旧模型（claude-sonnet-4-6）必须原位转 user reminder 且顶部 system 恒定
    const claudeBefore = buildClaudeRequestBody({
      provider: 'claude-subscription',
      model: 'claude-sonnet-4-6',
      messages: incrementalConversation(false),
    })
    const claudeAfter = buildClaudeRequestBody({
      provider: 'claude-subscription',
      model: 'claude-sonnet-4-6',
      messages: incrementalConversation(true),
    })
    expect(claudeAfter['system']).toEqual(claudeBefore['system'])
    expect(JSON.stringify(claudeAfter['system'])).toContain('Section A: Persona\\n\\nSection B: Tools')
    expect(JSON.stringify(claudeAfter['system'])).not.toContain('Delta 1: plan active')
    const claudeWireMsgs = claudeAfter['messages'] as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(claudeWireMsgs)).toContain('<system-reminder>')
    expect(JSON.stringify(claudeWireMsgs)).toContain('<\\\\/system-reminder>')

    // Claude API：连续两条中置 system 在非单合法槽位（或不支持中置 system）同样不改写顶部 system
    const apiContext = {
      entry: resolveClaudeApiModel('claude-sonnet-4-6'),
      settings: defaultClaudeApiSettings(),
      version: '2.1.330',
      deviceId: 'a'.repeat(64),
      sessionUuid: '11111111-2222-4333-8444-555555555555',
      firstParty: TEST_FIRST_PARTY_CONTEXT,
    }
    const apiBefore = buildClaudeApiRequest(
      { provider: 'claude-api', model: 'claude-sonnet-4-6', messages: incrementalConversation(false) },
      NO_RESOLVED_IMAGES,
      apiContext,
    )
    const apiAfter = buildClaudeApiRequest(
      { provider: 'claude-api', model: 'claude-sonnet-4-6', messages: incrementalConversation(true) },
      NO_RESOLVED_IMAGES,
      apiContext,
    )
    expect(apiAfter['system']).toEqual(apiBefore['system'])
    expect(JSON.stringify(apiAfter['system'])).toContain('Section A: Persona\\n\\nSection B: Tools')
    expect(JSON.stringify(apiAfter['system'])).not.toContain('Delta 1: plan active')
    expect(JSON.stringify(apiAfter['messages'])).toContain('<system-reminder>')
    expect(JSON.stringify(apiAfter['messages'])).toContain('<\\\\/system-reminder>')
  })

  it('Kimi / MiniMax / GLM / CommandCode / Step / Qoder / Qianwen / WorkBuddy / RelayOne / Cline / OpenDesign 全部保持头部 system 稳定并原位透传中置增量', () => {
    const beforeMsgs = incrementalConversation(false)
    const afterMsgs = incrementalConversation(true)
    const expectLeading = 'Section A: Persona\n\nSection B: Tools'
    const expectEscapedDelta = '<system-reminder>\nDelta 1: plan active\n\nDelta 2: escape <\\/system-reminder> safely\n</system-reminder>'

    // 1. Kimi Code (OpenAI + Anthropic + declarationSlots)
    const kimiOpenAiBefore = buildKimiOpenAIRequest({ provider: 'kimi-code', model: 'kimi-for-coding', messages: beforeMsgs })
    const kimiOpenAiAfter = buildKimiOpenAIRequest({ provider: 'kimi-code', model: 'kimi-for-coding', messages: afterMsgs })
    const kimiMsgsBefore = kimiOpenAiBefore['messages'] as Array<{ role: string; content: unknown }>
    const kimiMsgsAfter = kimiOpenAiAfter['messages'] as Array<{ role: string; content: unknown }>
    expect(kimiMsgsBefore[0]).toEqual(kimiMsgsAfter[0])
    expect(String(kimiMsgsAfter[0]?.content)).toContain(expectLeading)
    expect(String(kimiMsgsAfter[0]?.content)).not.toContain('Delta 1')
    expect(JSON.stringify(kimiMsgsAfter.slice(1))).toContain('<system-reminder>')
    expect(JSON.stringify(kimiMsgsAfter.slice(1))).toContain('<\\\\/system-reminder>')

    const kimiAnthBefore = buildKimiAnthropicRequest({ provider: 'kimi-code', model: 'kimi-for-coding', messages: beforeMsgs })
    const kimiAnthAfter = buildKimiAnthropicRequest({ provider: 'kimi-code', model: 'kimi-for-coding', messages: afterMsgs })
    expect(kimiAnthAfter['system']).toEqual(kimiAnthBefore['system'])
    expect(JSON.stringify(kimiAnthAfter['messages'])).toContain('<system-reminder>')

    // 2. MiniMax Code
    const minimaxBefore = buildMinimaxRequest({ provider: 'minimax-code', model: 'MiniMax-M2.7', messages: beforeMsgs })
    const minimaxAfter = buildMinimaxRequest({ provider: 'minimax-code', model: 'MiniMax-M2.7', messages: afterMsgs })
    expect(minimaxAfter['system']).toEqual(minimaxBefore['system'])
    expect(JSON.stringify(minimaxAfter['system'])).toContain('Section A: Persona\\n\\nSection B: Tools')
    expect(JSON.stringify(minimaxAfter['messages'])).toContain('<system-reminder>')

    // 3. GLM Coding Plan (Anthropic + OpenAI)
    expect(glmAnthropicSystemBlocks({ provider: 'glm-coding-plan', model: 'glm-5', messages: afterMsgs }))
      .toEqual(glmAnthropicSystemBlocks({ provider: 'glm-coding-plan', model: 'glm-5', messages: beforeMsgs }))
    const glmAnthAfter = buildGlmAnthropicRequest({ provider: 'glm-coding-plan', model: 'glm-5', messages: afterMsgs })
    expect(JSON.stringify(glmAnthAfter['messages'])).toContain('<system-reminder>')

    const glmOpenBefore = buildGlmOpenAiRequest({ provider: 'glm-coding-plan', model: 'glm-5', messages: beforeMsgs })
    const glmOpenAfter = buildGlmOpenAiRequest({ provider: 'glm-coding-plan', model: 'glm-5', messages: afterMsgs })
    expect((glmOpenAfter['messages'] as unknown[])[0]).toEqual((glmOpenBefore['messages'] as unknown[])[0])
    expect(JSON.stringify((glmOpenAfter['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    // 4. Command Code (OpenAI + Anthropic + Responses)
    const cmdOpenBefore = buildCommandCodeOpenAIRequest({ provider: 'command-code', model: 'gpt-5', messages: beforeMsgs })
    const cmdOpenAfter = buildCommandCodeOpenAIRequest({ provider: 'command-code', model: 'gpt-5', messages: afterMsgs })
    expect((cmdOpenAfter['messages'] as unknown[])[0]).toEqual((cmdOpenBefore['messages'] as unknown[])[0])
    expect(JSON.stringify((cmdOpenAfter['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    const cmdAnthBefore = buildCommandCodeAnthropicRequest({ provider: 'command-code', model: 'claude-sonnet', messages: beforeMsgs })
    const cmdAnthAfter = buildCommandCodeAnthropicRequest({ provider: 'command-code', model: 'claude-sonnet', messages: afterMsgs })
    expect(cmdAnthAfter['system']).toEqual(cmdAnthBefore['system'])
    expect(JSON.stringify(cmdAnthAfter['messages'])).toContain('<system-reminder>')

    const cmdRespBefore = buildCommandCodeResponsesRequest({ provider: 'command-code', model: 'gpt-5', messages: beforeMsgs })
    const cmdRespAfter = buildCommandCodeResponsesRequest({ provider: 'command-code', model: 'gpt-5', messages: afterMsgs })
    expect(cmdRespAfter['instructions']).toEqual(cmdRespBefore['instructions'])
    expect(JSON.stringify(cmdRespAfter['input'])).toContain('<system-reminder>')

    // 5. Step Code
    const stepBefore = buildStepCodeChatRequest({ provider: 'step-code', model: 'step-3.5-flash', messages: beforeMsgs })
    const stepAfter = buildStepCodeChatRequest({ provider: 'step-code', model: 'step-3.5-flash', messages: afterMsgs })
    expect((stepAfter['messages'] as unknown[])[0]).toEqual((stepBefore['messages'] as unknown[])[0])
    expect(JSON.stringify((stepAfter['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    // 6. Qoder
    const qoderCtx = { uid: 'u1', modelKey: 'qoder-test', entry: undefined, cosyVersion: '1.1.72' } as const
    const qoderBefore = buildQoderChatRequest(
      { provider: 'qoder', model: 'qoder-test', messages: beforeMsgs },
      NO_RESOLVED_IMAGES,
      DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
      qoderCtx,
    )
    const qoderAfter = buildQoderChatRequest(
      { provider: 'qoder', model: 'qoder-test', messages: afterMsgs },
      NO_RESOLVED_IMAGES,
      DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
      qoderCtx,
    )
    expect((qoderAfter['messages'] as unknown[])[0]).toEqual((qoderBefore['messages'] as unknown[])[0])
    expect(JSON.stringify((qoderAfter['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    // 7. Qianwen Token Plan
    const qwBefore = buildQianwenChatRequest({ provider: 'qianwen-token-plan', model: 'qwen3-coder-plus', messages: beforeMsgs })
    const qwAfter = buildQianwenChatRequest({ provider: 'qianwen-token-plan', model: 'qwen3-coder-plus', messages: afterMsgs })
    expect((qwAfter.body['messages'] as unknown[])[0]).toEqual((qwBefore.body['messages'] as unknown[])[0])
    expect(JSON.stringify((qwAfter.body['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    // 8. WorkBuddy (Chat + Messages)
    const wbChatBefore = buildWorkBuddyChatRequest({ provider: 'workbuddy-subscription', model: 'gpt-5', messages: beforeMsgs })
    const wbChatAfter = buildWorkBuddyChatRequest({ provider: 'workbuddy-subscription', model: 'gpt-5', messages: afterMsgs })
    expect((wbChatAfter['messages'] as unknown[])[0]).toEqual((wbChatBefore['messages'] as unknown[])[0])
    expect(JSON.stringify((wbChatAfter['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    const wbMsgBefore = buildWorkBuddyMessagesRequest({ provider: 'workbuddy-subscription', model: 'claude-sonnet', messages: beforeMsgs })
    const wbMsgAfter = buildWorkBuddyMessagesRequest({ provider: 'workbuddy-subscription', model: 'claude-sonnet', messages: afterMsgs })
    expect(wbMsgAfter['system']).toEqual(wbMsgBefore['system'])
    expect(JSON.stringify(wbMsgAfter['messages'])).toContain('<system-reminder>')

    // 9. RelayOne (Anthropic + Chat + Responses)
    const r1Catalog = mergeRelayOneCatalog(
      {
        object: 'list',
        data: [
          { id: 'claude-opus-5-5', owned_by: 'anthropic', supported_endpoint_types: ['anthropic'] },
          { id: 'gpt-6-astra', owned_by: 'openai', supported_endpoint_types: ['openai'] },
        ],
      },
      { data: [], vendors: [] },
    )
    const claudeEntry = r1Catalog.find((e) => e.id === 'claude-opus-5-5')!
    const gptEntry = r1Catalog.find((e) => e.id === 'gpt-6-astra')!
    const r1Settings = defaultRelayOneSettings()

    const r1AnthBefore = buildRelayOneAnthropicRequest(
      { provider: 'relayone', model: claudeEntry.id, messages: beforeMsgs },
      NO_RESOLVED_IMAGES,
      claudeEntry,
      r1Settings,
    )
    const r1AnthAfter = buildRelayOneAnthropicRequest(
      { provider: 'relayone', model: claudeEntry.id, messages: afterMsgs },
      NO_RESOLVED_IMAGES,
      claudeEntry,
      r1Settings,
    )
    expect(r1AnthAfter['system']).toEqual(r1AnthBefore['system'])
    expect(JSON.stringify(r1AnthAfter['messages'])).toContain('<system-reminder>')

    const r1ChatBefore = buildRelayOneChatRequest(
      { provider: 'relayone', model: gptEntry.id, messages: beforeMsgs },
      NO_RESOLVED_IMAGES,
      gptEntry,
      r1Settings,
    )
    const r1ChatAfter = buildRelayOneChatRequest(
      { provider: 'relayone', model: gptEntry.id, messages: afterMsgs },
      NO_RESOLVED_IMAGES,
      gptEntry,
      r1Settings,
    )
    expect((r1ChatAfter['messages'] as unknown[])[0]).toEqual((r1ChatBefore['messages'] as unknown[])[0])
    expect(JSON.stringify((r1ChatAfter['messages'] as unknown[]).slice(1))).toContain('<system-reminder>')

    const r1RespBefore = buildRelayOneResponsesRequest(
      { provider: 'relayone', model: gptEntry.id, messages: beforeMsgs },
      NO_RESOLVED_IMAGES,
      gptEntry,
      r1Settings,
    )
    const r1RespAfter = buildRelayOneResponsesRequest(
      { provider: 'relayone', model: gptEntry.id, messages: afterMsgs },
      NO_RESOLVED_IMAGES,
      gptEntry,
      r1Settings,
    )
    expect(r1RespAfter['instructions']).toEqual(r1RespBefore['instructions'])
    expect(
      (r1RespAfter['input'] as Array<{ role?: string; content?: unknown }>).some(
        (item) => item.role === 'developer' && JSON.stringify(item.content).includes('Delta 1: plan active'),
      ),
    ).toBe(true)

    // 10. Cline Pass & OpenDesign（多块 system 按双换行拼接，且保留中置 system 原位）
    const clineBody = buildClinePassBody(
      { provider: 'cline-pass', model: 'gpt-5', messages: afterMsgs },
      { maxTokens: 4096 },
      NO_RESOLVED_IMAGES,
    )
    expect(clineBody.messages[0]).toEqual({ role: 'system', content: expectLeading })
    expect(clineBody.messages.some((m) => m.role === 'system' && m.content === 'Delta 1: plan active\n\nDelta 2: escape </system-reminder> safely')).toBe(true)

    const odBody = buildOpenDesignBody(
      { provider: 'opendesign', model: 'gpt-5', messages: afterMsgs },
      { maxTokens: 4096 },
      NO_RESOLVED_IMAGES,
    )
    expect(odBody.messages[0]).toEqual({ role: 'system', content: expectLeading })
    expect(odBody.messages.some((m) => m.role === 'system' && m.content === 'Delta 1: plan active\n\nDelta 2: escape </system-reminder> safely')).toBe(true)

    // 顺手确认精确转义格式出现在 reminder 用户消息里
    expect(JSON.stringify(stepAfter['messages'])).toContain(JSON.stringify(expectEscapedDelta))
  })
})

describe('DSH 0.2.3 计划模式 (plan:status + stateVersion 5) 与四大守卫 retire 退役段', () => {
  type HostListener = (...args: never[]) => unknown

  function createFakeEventHost() {
    const listeners = new Map<string, HostListener>()
    const ctx: Record<string, unknown> = {
      on(event: string, listener: HostListener): () => void {
        listeners.set(event, listener)
        return () => {
          listeners.delete(event)
        }
      },
      logger: { warn: () => undefined },
    }
    return { ctx, listeners }
  }

  it('plan-mode-cache-guard：识别 plan:status 与常驻 plan:policy，退出后绝不误投，且忽略 retire 退役段', async () => {
    const { ctx, listeners } = createFakeEventHost()
    const guard = installPlanModeCacheGuard(ctx)
    const scope = { session: { id: 'sess-plan-023' } }
    const assemble = listeners.get('system-prompt/assemble')!
    const preStep = listeners.get('agent/pre-step')!

    const runStep = async (sections: Array<{ name: string; text: string; retire?: boolean }>) => {
      const assembled = await (assemble as (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<{ sections: Array<{ name: string; text: string }> }>)(
        { sections },
        { scope },
        async () => ({ sections }),
      )
      const decision = await (preStep as (payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages: unknown[] }>)(
        { agent: scope },
        async () => ({ kind: 'enter', messages: [] }),
      )
      return { assembled, decision }
    }

    // 1. 初始未进入计划模式：0.2.3 下 plan:policy 常驻非空，plan:status 为 inactive -> 摘除两段且不投递
    const step1 = await runStep([
      { name: 'persona', text: 'base' },
      { name: PLAN_POLICY_SECTION, text: 'Always plan carefully.' },
      { name: PLAN_STATUS_SECTION, text: 'Plan mode is currently inactive.' },
    ])
    expect(step1.assembled.sections.map((s) => s.name)).toEqual(['persona'])
    expect(step1.decision.messages).toHaveLength(0)

    // 2. 进入计划模式：plan:status 变为 active -> 投递一次 guidance
    const step2 = await runStep([
      { name: 'persona', text: 'base' },
      { name: PLAN_POLICY_SECTION, text: 'Always plan carefully.' },
      { name: PLAN_STATUS_SECTION, text: 'Plan mode is active.' },
    ])
    expect(step2.assembled.sections.map((s) => s.name)).toEqual(['persona'])
    expect(step2.decision.messages).toHaveLength(1)
    expect(JSON.stringify(step2.decision.messages[0])).toContain('Always plan carefully.')

    // 3. 退出计划模式：plan:policy 依然常驻非空，但 plan:status 回到 inactive -> 绝不可误投
    const step3 = await runStep([
      { name: 'persona', text: 'base' },
      { name: PLAN_POLICY_SECTION, text: 'Always plan carefully.' },
      { name: PLAN_STATUS_SECTION, text: 'Plan mode is currently inactive.' },
    ])
    expect(step3.assembled.sections.map((s) => s.name)).toEqual(['persona'])
    expect(step3.decision.messages).toHaveLength(0)

    // 4. 退役段（retire: true）绝不可误当成新策略投递
    const step4 = await runStep([
      { name: 'persona', text: 'base' },
      { name: PLAN_POLICY_SECTION, text: 'Plan policy retired.', retire: true },
      { name: PLAN_STATUS_SECTION, text: 'Plan status retired.', retire: true },
    ])
    expect(step4.assembled.sections.map((s) => s.name)).toEqual(['persona'])
    expect(step4.decision.messages).toHaveLength(0)

    // 5. 二次进入计划模式 -> 再次投递一次
    const step5 = await runStep([
      { name: 'persona', text: 'base' },
      { name: PLAN_POLICY_SECTION, text: 'Always plan carefully.' },
      { name: PLAN_STATUS_SECTION, text: 'Plan mode is active.' },
    ])
    expect(step5.decision.messages).toHaveLength(1)

    guard.dispose()
  })

  it('entry-plan-mode：stateVersion 升级为 5，兼容无 activeAtLastHeader 的缓存行且支持版本冲突自动协商', async () => {
    expect(PLAN_STATE_VERSION).toBe(5)
    expect(PLAN_STATUS_SECTION).toBe('plan:status')
    expect(planProjectionDefinition.stateVersion).toBe(5)

    // stateSchema 接受省略 activeAtLastHeader 的 0.2.3 v5 持久化行并补 default null
    const parsedV5 = (planProjectionDefinition.stateSchema as { parse(v: unknown): { activeAtLastHeader: unknown } }).parse({
      active: true,
      wanted: null,
      running: null,
      entered: true,
    })
    expect(parsedV5.activeAtLastHeader).toBeNull()

    // 模拟宿主已先按 stateVersion 4 注册 plan 投影，PlanModeController 自动协商重试成功
    const registeredVersions: number[] = []
    const ctx = new Context()
    ctx.provide('sessionProjections', {
      register(def: { stateVersion: number }) {
        registeredVersions.push(def.stateVersion)
        if (def.stateVersion === 5) {
          throw new Error('projection "plan" already registered at stateVersion 4')
        }
        return () => undefined
      },
    } as never)
    ctx.provide('tools', { register: () => () => undefined } as never)
    try {
      const controller = new PlanModeController(ctx, { section: 'Plan carefully.' })
      const init = (controller as unknown as Record<symbol, () => Promise<void>>)[Service.init]
      await init.call(controller)
      expect(registeredVersions).toEqual([5, 4])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('team-policy / timeline / ptc-sdk 三大守卫正确放行或撤销 retire: true 退役段', async () => {
    // 1. team-policy-cache-guard：开启后收到 retire: true -> 走关闭撤销路径而非重复投递开启策略
    const teamHost = createFakeEventHost()
    const teamGuard = installTeamPolicyCacheGuard(teamHost.ctx, { enabled: () => true })
    const teamScope = { session: { id: 'sess-team-retire' } }
    const teamAssemble = teamHost.listeners.get('system-prompt/assemble') as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<{ sections: Array<{ name: string; text: string }> }>
    const teamPreStep = teamHost.listeners.get('agent/pre-step') as (p: unknown, n: () => Promise<unknown>) => Promise<{ messages: unknown[] }>

    await teamAssemble({}, { scope: teamScope }, async () => ({
      sections: [{ name: TEAM_POLICY_SECTION, text: 'Team policy active instructions' }],
    }))
    const opened = await teamPreStep({ agent: teamScope }, async () => ({ kind: 'enter', messages: [] }))
    expect(opened.messages).toHaveLength(1)
    expect(JSON.stringify(opened.messages[0])).toContain('Team policy active instructions')

    await teamAssemble({}, { scope: teamScope }, async () => ({
      sections: [{ name: TEAM_POLICY_SECTION, text: 'Team policy retired', retire: true }],
    }))
    const retired = await teamPreStep({ agent: teamScope }, async () => ({ kind: 'enter', messages: [] }))
    expect(retired.messages).toHaveLength(1)
    expect(JSON.stringify(retired.messages[0])).not.toContain('Team policy retired')
    expect(JSON.stringify(retired.messages[0])).toContain('turned off')
    teamGuard.dispose()

    // 2. timeline-cache-guard：先冻结文本，再遇到 retire: true 时直接放行退役文本而不拿旧冻结副本覆盖
    const timelineHost = createFakeEventHost()
    const timelineGuard = installTimelineCacheGuard(timelineHost.ctx, { enabled: () => true })
    const timelineScope = {
      session: { id: 'sess-tl-retire' },
      model: { current: () => ({ provider: 'kimi-code', model: 'kimi-for-coding' }) },
    }
    const tlAssemble = timelineHost.listeners.get('system-prompt/assemble') as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<{ sections: Array<{ name: string; text: string; retire?: boolean }> }>
    const firstTl = await tlAssemble({}, { scope: timelineScope }, async () => ({
      sections: [{ name: TIMELINE_SECTION, text: 'Frozen timeline v1' }],
    }))
    expect(firstTl.sections[0]?.text).toBe('Frozen timeline v1')

    const retiredTl = await tlAssemble({}, { scope: timelineScope }, async () => ({
      sections: [{ name: TIMELINE_SECTION, text: 'Timeline section retired.', retire: true }],
    }))
    expect(retiredTl.sections[0]?.text).toBe('Timeline section retired.')
    expect(retiredTl.sections[0]?.retire).toBe(true)
    timelineGuard.dispose()

    // 3. ptc-sdk-cache-guard：先冻结 tools:sdk，再遇到 retire: true 时直接放行退役文本并清空缓存
    const ptcHost = createFakeEventHost()
    const ptcGuard = installPtcSdkCacheGuard(ptcHost.ctx)
    const ptcScope = {
      session: { id: 'sess-ptc-retire' },
      model: { current: () => ({ provider: 'kimi-code', model: 'kimi-for-coding' }) },
    }
    const ptcAssemble = ptcHost.listeners.get('system-prompt/assemble') as (a: unknown, c: unknown, n: () => Promise<unknown>) => Promise<{ sections: Array<{ name: string; text: string; retire?: boolean }> }>
    const firstPtc = await ptcAssemble({}, { scope: ptcScope }, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'Frozen SDK v1' }],
    }))
    expect(firstPtc.sections[0]?.text).toBe('Frozen SDK v1')

    const retiredPtc = await ptcAssemble({}, { scope: ptcScope }, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK retired.', retire: true }],
    }))
    expect(retiredPtc.sections[0]?.text).toBe('SDK retired.')
    expect(retiredPtc.sections[0]?.retire).toBe(true)
    ptcGuard.dispose()
  })
})

describe('DSH 0.2.3 子代理实时模型授权 (ctx.subagentModelSelection) 与路由审计', () => {
  it('无历史录制事件时读取实时 subagentModelSelection，动态更新立即生效且异常安全降级', () => {
    let liveRoutes: Array<{ provider: string; model: string }> | undefined = [
      { provider: 'kimi-code', model: 'kimi-for-coding' },
    ]
    let shouldThrow = false
    const modelSelectionService = {
      allowedRoutes() {
        if (shouldThrow) {
          const err = new Error('broken config') as Error & { code?: string }
          err.code = 'INVALID_MODEL_SELECTION_SETTINGS'
          throw err
        }
        return liveRoutes
      },
    }

    const guards: Array<(execution: unknown) => string | undefined> = []
    const fakeCtx = {
      get(name: string) {
        if (name === 'subagentModelSelection') return modelSelectionService
        return undefined
      },
      tools: {
        guard(fn: (execution: unknown) => string | undefined) {
          guards.push(fn)
          return () => undefined
        },
        definitions: () => [],
      },
      on: () => () => undefined,
      effect: (fn: () => (() => void) | void) => { fn() },
    }

    // 1. liveSubagentModelSelectionPreference 直接返回 liveService=true
    const pref = liveSubagentModelSelectionPreference(fakeCtx)
    expect(pref?.liveService).toBe(true)
    expect(pref?.allowedModels).toEqual([{ provider: 'kimi-code', model: 'kimi-for-coding' }])

    // 2. 安装默认 scope: 'session' 授权守卫（无任何历史 subagent/model-selection-policy 事件）
    const dispose = installSubagentModelAuthorization(fakeCtx as never, { get: () => undefined }, {
      scope: 'session',
    })
    expect(guards.length).toBeGreaterThan(0)
    const runGuard = (args: Record<string, unknown>) =>
      guards.map((g) => g({
        name: 'subagent',
        arguments: args,
        agent: { session: { id: 'sess-live', eventAt: () => undefined } },
      })).find((reason) => reason !== undefined)

    // 越权路由被拦截，授权路由放行
    expect(runGuard({ provider: 'codex-chatgpt', model: 'gpt-5.4' })).toBeDefined()
    expect(runGuard({ provider: 'kimi-code', model: 'kimi-for-coding' })).toBeUndefined()

    // 3. 运行时修改实时设置 -> 同一会话下一次调用立刻生效
    liveRoutes = [{ provider: 'codex-chatgpt', model: 'gpt-5.4' }]
    expect(runGuard({ provider: 'codex-chatgpt', model: 'gpt-5.4' })).toBeUndefined()
    expect(runGuard({ provider: 'kimi-code', model: 'kimi-for-coding' })).toBeDefined()

    // 4. 运行时关闭限制（allowedRoutes 返回 undefined）-> 立即放行所有路由
    liveRoutes = undefined
    expect(runGuard({ provider: 'kimi-code', model: 'kimi-for-coding' })).toBeUndefined()

    // 5. allowedRoutes 抛出 INVALID_MODEL_SELECTION_SETTINGS -> 安全降级（交由原生工具报配置错，不崩溃）
    shouldThrow = true
    expect(liveSubagentModelSelectionPreference(fakeCtx)).toEqual({
      enabled: true,
      allowedModels: [],
      liveService: true,
    })
    expect(readSubagentRoutingPreference({ modelSelection: fakeCtx })?.allowedModels).toEqual([])
    expect(() => runGuard({ provider: 'kimi-code', model: 'kimi-for-coding' })).not.toThrow()

    dispose()
  })

  it('auditedRoutesOf 与 dispatch-ledger 在无录制事件时正确使用实时 subagentModelSelection 回退', () => {
    const emptySession = { id: 'sess-empty', events: [] as const }
    const fallback = [{ provider: 'codex-chatgpt', model: 'gpt-5.4' }]

    expect(auditedRoutesOf(emptySession)).toBeUndefined()
    expect(auditedRoutesOf(emptySession, fallback)).toEqual(fallback)

    expect(routesForSession(emptySession, undefined, fallback)).toEqual(fallback)
    const policyWithoutFallback = policyForSession(emptySession, undefined)
    const policyWithFallback = policyForSession(emptySession, undefined, undefined, fallback)
    expect(policyWithFallback.sha256).not.toBe(policyWithoutFallback.sha256)

    // installDispatchLedger 自动探测宿主 ctx.subagentModelSelection
    let registeredTool: { execute: (args: unknown, exec: unknown) => Promise<{ policy?: { sha256: string } }> } | undefined
    const ledgerCtx = {
      get(name: string) {
        if (name === 'subagentModelSelection') {
          return { allowedRoutes: () => fallback }
        }
        return undefined
      },
      tools: {
        register(def: typeof registeredTool) {
          registeredTool = def
          return () => undefined
        },
        guard: () => () => undefined,
      },
    }
    const dispose = installDispatchLedger(ledgerCtx, { enabled: () => true })
    expect(registeredTool).toBeDefined()
    dispose()
  })
})

describe('DSH 0.2.3 ImageRequestTarget 双代契约', () => {
  it('同时暴露 maxBytes (0.2.3+) 与 maxImageBytes / imageTargetBytes (<=0.2.2) 且数值一致', () => {
    const largeRef = {
      attachmentId: 'sha256:large' as never,
      mediaType: 'image/png' as const,
      width: 3200,
      height: 2400,
      bytes: 500_000,
    }
    const smallRef = {
      attachmentId: 'sha256:small' as never,
      mediaType: 'image/png' as const,
      width: 800,
      height: 600,
      bytes: 100_000,
    }

    const target = requestImageTarget(largeRef, 1568)
    expect(target).toBeDefined()
    expect(target?.width).toBe(1568)
    expect(target?.maxBytes).toBe(target?.maxImageBytes)
    expect(target?.imageTargetBytes).toBe(target?.maxBytes)

    const original = requestImageTargetOrOriginal(smallRef, 1568)
    expect(original.width).toBe(800)
    expect(original.height).toBe(600)
    expect(original.maxBytes).toBe(100_000)
    expect(original.maxImageBytes).toBe(100_000)
    expect(original.imageTargetBytes).toBe(100_000)

    const resized = requestImageTargetOrOriginal(largeRef, 1568)
    expect(resized.width).toBe(1568)
    expect(resized.maxPixels).toBeGreaterThan(0)
    expect(resized.maxBytes).toBe(resized.maxImageBytes)
    expect(resized.imageTargetBytes).toBe(resized.maxBytes)
  })
})
