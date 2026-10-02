import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_EVIDENCE_REGISTRY,
  CapabilityError,
  CapabilityEvidenceRecord,
  capabilityOf,
  capabilityTable,
  evaluateCapability,
  isKnownOllamaThinkingModel,
  isKnownOllamaVisionModel,
  KNOWN_OLLAMA_THINKING_BOOLEAN_PREFIXES,
  KNOWN_OLLAMA_THINKING_LEVELS_PREFIXES,
  KNOWN_OLLAMA_VISION_PREFIXES,
  maySend,
  queryCapabilityEvidence,
  requireCapability,
  supportsOllamaImage,
  supportsOllamaThinkingControl,
  supportsZdr,
} from '../src/host/common/capabilities.ts'

const ROUTES = Object.keys(capabilityTable())

describe('provider capability matrix (legacy inventory compatibility)', () => {
  it('covers every route this plugin ships', () => {
    expect(ROUTES.sort()).toEqual([
      'antigravity',
      'claude',
      'codex-chatgpt',
      'command-code',
      'kimi-code',
      'minimax-code',
      'ollama',
      'workbuddy',
    ])
  })

  it('reports whether the inventory marks a feature implemented', () => {
    for (const route of ROUTES) {
      for (const capability of Object.keys(capabilityTable()[route] ?? {}) as Array<keyof ReturnType<typeof capabilityTable>[string]>) {
        const state = capabilityOf(route, capability as never)
        expect(maySend(route, capability as never)).toBe(state === 'supported')
      }
    }
  })

  it('treats an unrecorded route or feature as unknown rather than absent', () => {
    expect(capabilityOf('a-route-nobody-declared', 'tool-search')).toBe('unknown')
    expect(capabilityOf('ollama', 'server-side-compaction')).toBe('unsupported')
    expect(maySend('a-route-nobody-declared', 'tool-search')).toBe(false)
  })

  it('does not report unverified Codex features as implemented', () => {
    expect(maySend('codex-chatgpt', 'tool-search')).toBe(false)
    expect(maySend('codex-chatgpt', 'server-side-compaction')).toBe(false)
    expect(maySend('codex-chatgpt', 'multi-agent-server')).toBe(false)
  })
})

describe('strict runtime capability gate & evidence registry', () => {
  it('freezes the registry to prevent runtime mutation or fake safety gates', () => {
    expect(Object.isFrozen(CAPABILITY_EVIDENCE_REGISTRY)).toBe(true)
    for (const record of CAPABILITY_EVIDENCE_REGISTRY) {
      expect(Object.isFrozen(record)).toBe(true)
      expect(record.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(record.testPath || record.link).toBeTruthy()
      expect(record.implemented).toBe(true)
      expect(record.status).toBe('supported')
    }
  })

  it('requires non-empty explicit authMode, wire, model, provider, and capability', () => {
    // Missing or empty authMode fails closed
    const noAuth = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llama3.2-vision:11b',
      authMode: '',
      capability: 'native-image',
    })
    expect(noAuth.allowed).toBe(false)
    expect(noAuth.state).toBe('unknown')
    expect(noAuth.reason).toContain('requires non-empty')

    // Whitespace only authMode fails closed
    const wsAuth = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llama3.2-vision:11b',
      authMode: '   ',
      capability: 'native-image',
    })
    expect(wsAuth.allowed).toBe(false)

    // Empty wire fails closed
    expect(
      evaluateCapability({
        provider: 'ollama',
        wire: '',
        model: 'llama3.2-vision:11b',
        authMode: 'api-key',
        capability: 'native-image',
      }).allowed,
    ).toBe(false)

    // Empty model fails closed
    expect(
      evaluateCapability({
        provider: 'ollama',
        wire: 'openai',
        model: '',
        authMode: 'api-key',
        capability: 'native-image',
      }).allowed,
    ).toBe(false)
  })

  it('strictly validates Ollama native-image and prevents prefix hijacking like llava-evil', () => {
    expect(KNOWN_OLLAMA_VISION_PREFIXES).toEqual([
      'llava',
      'bakllava',
      'llama3.2-vision',
      'moondream',
      'minicpm-v',
      'qwen2.5-vl',
      'qwen2-vl',
    ])

    // Legitimate known vision models match
    expect(isKnownOllamaVisionModel('llama3.2-vision:11b')).toBe(true)
    expect(isKnownOllamaVisionModel('llava:latest')).toBe(true)
    expect(isKnownOllamaVisionModel('qwen2.5-vl:7b')).toBe(true)

    // Hijacked prefixes strictly do not match
    expect(isKnownOllamaVisionModel('llava-evil')).toBe(false)
    expect(isKnownOllamaVisionModel('llava-evil:13b')).toBe(false)
    expect(isKnownOllamaVisionModel('llama3.2-vision-unauthorized:latest')).toBe(false)
    expect(isKnownOllamaVisionModel('llama3:8b')).toBe(false)
    expect(isKnownOllamaVisionModel('mistral:7b')).toBe(false)

    // Gate allows valid model with exact wire and authMode
    const validVision = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llama3.2-vision:11b',
      authMode: 'api-key',
      capability: 'native-image',
    })
    expect(validVision.allowed).toBe(true)
    expect(validVision.state).toBe('supported')
    expect(validVision.evidence?.testPath).toBe('test/ollama-projection.test.ts')

    // Gate allows native wire as well
    const nativeWireVision = evaluateCapability({
      provider: 'ollama',
      wire: 'native',
      model: 'llava:latest',
      authMode: 'api-key',
      capability: 'native-image',
    })
    expect(nativeWireVision.allowed).toBe(true)

    // Gate strictly rejects llava-evil
    const hijacked = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llava-evil:13b',
      authMode: 'api-key',
      capability: 'native-image',
    })
    expect(hijacked.allowed).toBe(false)
    expect(hijacked.state).toBe('unknown')

    // Gate strictly rejects non-vision model
    const nonVision = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llama3:8b',
      authMode: 'api-key',
      capability: 'native-image',
    })
    expect(nonVision.allowed).toBe(false)

    // Incompatible auth mode rejected
    const badAuth = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llama3.2-vision:11b',
      authMode: 'oauth',
      capability: 'native-image',
    })
    expect(badAuth.allowed).toBe(false)

    // Incompatible wire rejected
    const badWire = evaluateCapability({
      provider: 'ollama',
      wire: 'grpc',
      model: 'llama3.2-vision:11b',
      authMode: 'api-key',
      capability: 'native-image',
    })
    expect(badWire.allowed).toBe(false)

    // requireCapability throws on rejected query
    expect(() =>
      requireCapability({
        provider: 'ollama',
        wire: 'openai',
        model: 'llava-evil:13b',
        authMode: 'api-key',
        capability: 'native-image',
      }),
    ).toThrow(CapabilityError)
  })

  it('validates Ollama thinking-control for exact known thinking models', () => {
    expect(KNOWN_OLLAMA_THINKING_LEVELS_PREFIXES).toEqual(['gpt-oss'])
    expect(KNOWN_OLLAMA_THINKING_BOOLEAN_PREFIXES).toEqual(['deepseek-r1', 'qwq', 'qwen3'])

    expect(isKnownOllamaThinkingModel('gpt-oss:120b')).toBe(true)
    expect(isKnownOllamaThinkingModel('deepseek-r1:14b')).toBe(true)
    expect(isKnownOllamaThinkingModel('qwq:32b')).toBe(true)
    expect(isKnownOllamaThinkingModel('deepseek-r1-fake:latest')).toBe(false)
    expect(isKnownOllamaThinkingModel('llama3:8b')).toBe(false)

    // Valid thinking model allowed
    const validThinking = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'deepseek-r1:14b',
      authMode: 'api-key',
      capability: 'thinking-control',
    })
    expect(validThinking.allowed).toBe(true)
    expect(validThinking.state).toBe('supported')
    expect(validThinking.evidence?.testPath).toBe('test/ollama-projection.test.ts')

    // Non-thinking model denied
    const nonThinking = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'llama3:8b',
      authMode: 'api-key',
      capability: 'thinking-control',
    })
    expect(nonThinking.allowed).toBe(false)

    // Ollama thinking replay across turns is unverified/unsupported by cloud limits
    const thinkReplay = evaluateCapability({
      provider: 'ollama',
      wire: 'openai',
      model: 'deepseek-r1:14b',
      authMode: 'api-key',
      capability: 'thinking-replay',
    })
    expect(thinkReplay.allowed).toBe(false)
    expect(thinkReplay.state).toBe('unknown')
  })

  it('validates Command Code Zero Data Retention (ZDR) protocol invariant across all wires and auth modes', () => {
    const wires = ['responses', 'anthropic', 'openai', 'chat-completions', 'messages']
    const authModes = ['api-key', 'token', 'oauth']

    for (const wire of wires) {
      for (const authMode of authModes) {
        const zdrEval = evaluateCapability({
          provider: 'command-code',
          wire,
          model: 'claude-3-5-sonnet',
          authMode,
          capability: 'zdr',
        })
        expect(zdrEval.allowed).toBe(true)
        expect(zdrEval.state).toBe('supported')
        expect(zdrEval.evidence?.testPath).toBe('test/command-code-adapter.test.ts')
      }
    }

    // requireCapability succeeds
    const required = requireCapability({
      provider: 'command-code',
      wire: 'openai',
      model: 'deepseek-chat',
      authMode: 'api-key',
      capability: 'zdr',
    })
    expect(required.allowed).toBe(true)

    // Unsupported wire fails closed
    expect(
      evaluateCapability({
        provider: 'command-code',
        wire: 'grpc',
        model: 'deepseek-chat',
        authMode: 'api-key',
        capability: 'zdr',
      }).allowed,
    ).toBe(false)

    // Unsupported auth mode fails closed
    expect(
      evaluateCapability({
        provider: 'command-code',
        wire: 'openai',
        model: 'deepseek-chat',
        authMode: 'basic-auth',
        capability: 'zdr',
      }).allowed,
    ).toBe(false)

    // Other providers fail closed on ZDR
    expect(
      evaluateCapability({
        provider: 'codex-chatgpt',
        wire: 'responses',
        model: 'gpt-4o',
        authMode: 'oauth',
        capability: 'zdr',
      }).allowed,
    ).toBe(false)
  })

  it('denies unverified features by default (MiniMax replay, Codex compaction, websocket)', () => {
    // MiniMax thinking replay: offline implementation exists, but subscription gateway is unverified (W4)
    expect(
      evaluateCapability({
        provider: 'minimax-code',
        wire: 'anthropic',
        model: 'abab6.5s-chat',
        authMode: 'oauth',
        capability: 'thinking-replay',
      }).allowed,
    ).toBe(false)

    // Codex server-side compaction is unverified on subscription endpoint
    expect(
      evaluateCapability({
        provider: 'codex-chatgpt',
        wire: 'responses',
        model: 'gpt-4o',
        authMode: 'oauth',
        capability: 'server-side-compaction',
      }).allowed,
    ).toBe(false)

    // Codex tool search is unverified on subscription endpoint
    expect(
      evaluateCapability({
        provider: 'codex-chatgpt',
        wire: 'responses',
        model: 'gpt-4o',
        authMode: 'oauth',
        capability: 'tool-search',
      }).allowed,
    ).toBe(false)

    // Codex WebSocket transport is unverified/unimplemented in production path
    expect(
      evaluateCapability({
        provider: 'codex-chatgpt',
        wire: 'responses',
        model: 'gpt-4o',
        authMode: 'oauth',
        capability: 'websocket-transport',
      }).allowed,
    ).toBe(false)
  })

  it('supports convenience production gate helpers', () => {
    expect(supportsZdr('command-code', 'openai', 'gpt-4o', 'api-key')).toBe(true)
    expect(supportsZdr('command-code', 'responses', 'gpt-4o', 'oauth')).toBe(true)
    expect(supportsZdr('codex-chatgpt', 'responses', 'gpt-4o', 'oauth')).toBe(false)

    expect(supportsOllamaImage('llama3.2-vision:11b')).toBe(true)
    expect(supportsOllamaImage('llava-evil')).toBe(false)
    expect(supportsOllamaImage('llama3:8b')).toBe(false)

    expect(supportsOllamaThinkingControl('deepseek-r1:14b')).toBe(true)
    expect(supportsOllamaThinkingControl('gpt-oss:120b')).toBe(true)
    expect(supportsOllamaThinkingControl('llama3:8b')).toBe(false)
  })

  it('supports isolated testing via optional pure registry argument without mutating global state', () => {
    const customTestRegistry: readonly CapabilityEvidenceRecord[] = [
      {
        id: 'test-custom-cap',
        provider: 'test-provider',
        wire: 'test-wire',
        modelSelector: 'test-model',
        authMode: 'test-auth',
        capability: 'prompt-cache-read',
        status: 'supported',
        evidenceLevel: 'offline-contract',
        implemented: true,
        date: '2026-10-03',
        testPath: 'test/custom.test.ts',
      },
    ]

    const query = {
      provider: 'test-provider',
      wire: 'test-wire',
      model: 'test-model',
      authMode: 'test-auth',
      capability: 'prompt-cache-read' as const,
    }

    // Default registry rejects
    expect(evaluateCapability(query).allowed).toBe(false)

    // Custom registry allows isolated evaluation
    const customEval = evaluateCapability(query, customTestRegistry)
    expect(customEval.allowed).toBe(true)
    expect(customEval.evidence?.id).toBe('test-custom-cap')

    // Global registry remains untouched and frozen
    expect(evaluateCapability(query).allowed).toBe(false)
    expect(Object.isFrozen(CAPABILITY_EVIDENCE_REGISTRY)).toBe(true)
  })
})
