import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  type AllowedModelRoute,
  type AuthorizationAgent,
  type PolicySession,
  type SessionsResolver,
  installSubagentModelAuthorization,
} from '../src/host/subagent-model-authorization.ts'

/**
 * The PT C ("run_code") transport dispatches every tool the program calls back
 * through the same registry scheduler a direct call uses, so the authorization
 * guard must deny an unauthorized delegation reached from inside a program too.
 * These tests drive a real ToolRuntime in `ptc` mode with a fake code runtime
 * that calls the bound `subagent` function, which is the only way to prove the
 * nested path is covered rather than assuming it.
 */

/** Tool-presentation mode that routes direct calls through `run_code`. */
const CODE_MODE = 'ptc' as const

const GEMINI: AllowedModelRoute = { provider: 'antigravity', model: 'gemini-3.8-flash' }
const DEEPSEEK_OPTIONS = { provider: 'deepseek-official', model: 'deepseek-flash' }
const NO_SESSIONS: SessionsResolver = { get: () => undefined }

/**
 * Scriptable PTC runtime whose `run` drives the bound tool functions. The
 * resolver supplies the directory and deadline every `PtcRunSpec` requires;
 * the run itself only has to expose the `tools` binding namespace to the
 * program under test.
 */
class FakeRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (spec: PtcRunSpec) => Promise<PtcRunResult> =
    () => Promise.resolve({ logs: [] })

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? null }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> {
    return this.behavior(spec)
  }
}

/** Appended events observed on the fake Session, in order. */
let appended: { type: string; data: unknown }[] = []
const agentContexts: Context[] = []

/** Minimal Session double carrying one durable route-policy event. */
function session(routes: readonly AllowedModelRoute[]): PolicySession {
  const events = [{ type: 'subagent/model-selection-policy', data: { allowedModels: [...routes] } }]
  return {
    header: {},
    eventAt: (seq: number) => events[seq] as { type?: unknown; data?: unknown } | undefined,
    // The registry logs each sub-dispatch into the owning Session; the guard
    // decision itself never depends on these, so a recording no-op suffices.
    append: (type: string, data: unknown) => { appended.push({ type, data }) },
  } as PolicySession
}

/** Calling agent whose Session recorded the allowlist the delegation tool snapshots. */
function recordingAgent(routes: readonly AllowedModelRoute[]): Agent {
  const ctx = new Context()
  agentContexts.push(ctx)
  return {
    id: 'ptc-parent',
    ctx,
    options: DEEPSEEK_OPTIONS,
    session: session(routes),
  } as unknown as Agent
}

/**
 * Mount the real tool runtime in PTC mode plus the fake PTC runtime. The mode
 * that collapses direct calls into `run_code` is `ptc` in this harness line,
 * and mounted here through `ctx.ptcRuntime`.
 */
async function setup(): Promise<{ ctx: Context; runtime: FakeRuntime }> {
  const ctx = new Context()
  ctx.provide('workingDirectory', {
    ensure: () => Promise.resolve(process.cwd()),
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: CODE_MODE })
  await ctx.plugin(FakeRuntime)
  return { ctx, runtime: ctx.ptcRuntime as FakeRuntime }
}

/** Register the delegation tool the program is allowed to call. */
function registerSubagent(ctx: Context, calls: unknown[]): void {
  ctx.tools.register(defineTool({
    name: 'subagent',
    description: 'Delegate to a subagent.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve('started')
    },
  }))
}

/** Dispatch `run_code` the way the model would, then read what the program observed. */
function runCode(
  ctx: Context,
  agent: Agent,
  runtime: FakeRuntime,
  call: (tools: Record<string, (args: unknown) => Promise<unknown>>) => Promise<unknown>,
): Promise<{ result: ToolExecutionResult; observed: { isError?: boolean; message?: string } }> {
  let observed: { isError?: boolean; message?: string } = {}
  runtime.behavior = async (request) => {
    const tools = request.bindings[0]!.functions as unknown as Record<
      string, (args: unknown) => Promise<unknown>
    >
    try {
      observed = { message: String(await call(tools)) }
      return { logs: [], value: 'program finished' }
    } catch (error) {
      observed = { isError: true, message: String(error) }
      return { logs: [], value: 'program finished' }
    }
  }
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('code-call-1'),
    name: RUN_CODE_NAME,
    arguments: { code: 'program', description: 'Run the guard test program' },
    agent,
  }).then(result => ({ result, observed }))
}

describe('subagent authorization covers the run_code transport', () => {
  beforeEach(() => { appended = [] })
  afterEach(async () => {
    await Promise.all(agentContexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('denies a delegation dispatched from inside a program when the route is missing', async () => {
    const { ctx, runtime } = await setup()
    const calls: unknown[] = []
    registerSubagent(ctx, calls)
    const agent = recordingAgent([GEMINI])
    installSubagentModelAuthorization(ctx as never, NO_SESSIONS, { toolNames: ['subagent'] })

    const { result, observed } = await runCode(ctx, agent, runtime, tools =>
      tools['subagent']!({ description: 'nested', prompt: 'do it' }))

    expect(result.isError).toBe(false)
    expect(observed.isError).toBe(true)
    expect(observed.message).toContain('requires an explicit child model')
    expect(calls).toEqual([])
  })

  it('allows a delegation dispatched from inside a program when the route is authorized', async () => {
    const { ctx, runtime } = await setup()
    const calls: unknown[] = []
    registerSubagent(ctx, calls)
    const agent = recordingAgent([GEMINI])
    installSubagentModelAuthorization(ctx as never, NO_SESSIONS, { toolNames: ['subagent'] })

    const { observed } = await runCode(ctx, agent, runtime, tools =>
      tools['subagent']!({
        description: 'nested',
        prompt: 'do it',
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
      }))

    expect(observed.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('denies a delegation from inside a program when the route is outside the allowlist', async () => {
    const { ctx, runtime } = await setup()
    const calls: unknown[] = []
    registerSubagent(ctx, calls)
    const agent = recordingAgent([GEMINI])
    installSubagentModelAuthorization(ctx as never, NO_SESSIONS, { toolNames: ['subagent'] })

    const { observed } = await runCode(ctx, agent, runtime, tools =>
      tools['subagent']!({
        description: 'nested',
        prompt: 'do it',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
      }))

    expect(observed.isError).toBe(true)
    expect(observed.message).toContain('is not on the Session allowlist')
    expect(calls).toEqual([])
  })

  it('enriches list_subagent_models inside run_code and rewrites the rendered tools:sdk section', async () => {
    const { ctx, runtime } = await setup()
    ctx.tools.register(defineTool({
      name: 'list_subagent_models',
      description:
        'Discover LLM routes for subagents without changing the current Agent. '
        + 'Catalog membership is advisory: an adapter may accept an unlisted model id.',
      parameters: {
        provider: { type: 'string', description: 'Registered LLM provider id. Omit to list providers.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute() {
        return Promise.resolve('antigravity — Antigravity')
      },
    }))
    ctx.tools.register(defineTool({
      name: 'subagent',
      description:
        'Delegate a self-contained task to a subagent. '
        + 'Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent.',
      parameters: {
        description: { type: 'string', required: true },
        prompt: { type: 'string', required: true },
        provider: {
          type: 'string',
          description: 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route.',
        },
        model: {
          type: 'string',
          description: 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute() {
        return Promise.resolve('started')
      },
    }))
    const agent = recordingAgent([GEMINI])
    installSubagentModelAuthorization(ctx as never, NO_SESSIONS, { toolNames: ['subagent'] })

    const { observed } = await runCode(ctx, agent, runtime, tools =>
      tools['list_subagent_models']!({}))

    expect(observed.isError).toBeUndefined()
    expect(observed.message).toContain('antigravity — Antigravity')
    expect(observed.message).toContain('Authorized child routes for this Session')
    expect(observed.message).toContain('- antigravity/gemini-3.8-flash -> provider: "antigravity", model: "gemini-3.8-flash"')

    const assembled = await ctx.systemPrompt.assemble({ scope: agent })
    const sdkSection = assembled.sections.find(section => section.name === 'tools:sdk')
    expect(sdkSection?.text).toContain("Output is already filtered to this Session's allowlist (antigravity/gemini-3.8-flash)")
    expect(sdkSection?.text).toContain('Child LLM selection is required in this Session')
    expect(sdkSection?.text).not.toContain('Catalog membership is advisory')
    expect(sdkSection?.text).not.toContain('Child LLM selection is optional')
  })
})

