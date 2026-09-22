/**
 * Isolation tests for the plugin-wide modality widening.
 *
 * `ModelModalityMap`/`ContentBlockMap` are merged module-wide the moment any
 * file in this package augments them, and this package ships four provider
 * routes. These tests pin the two ways that could go wrong: a sibling route
 * starting to advertise video, and a video block reaching a sibling mapper
 * that has no case for it.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { buildRequest as buildCommandCodeRequest } from '../src/host/command-code/mapper.ts'
import { buildRequest as buildKimiCodeRequest } from '../src/host/kimi-code/mapper.ts'
import { inputModalitiesFor as commandCodeModalities } from '../src/host/command-code/types.ts'
import { inputModalitiesFor as kimiCodeModalities } from '../src/host/kimi-code/types.ts'
import { kimiCodeModelDef } from '../src/host/kimi-code/model-catalog.ts'

function videoMessage(): Message {
  return {
    role: 'user',
    content: [{ type: 'video', attachment: { attachmentId: 'v1', mediaType: 'video/mp4', bytes: 8 } }],
  } as unknown as Message
}

describe('the widening does not leak video into sibling routes', () => {
  it('keeps every Command Code model free of the video modality', () => {
    // Command Code's registry predates the widening; if the augmentation ever
    // became a runtime value rather than a type, these would start reporting
    // video and DSH would hand the adapter bytes it cannot send.
    for (const id of ['claude-sonnet-4-6', 'gpt-5', 'deepseek-v4.1-flash']) {
      expect(commandCodeModalities(id)).not.toContain('video')
    }
  })

  it('reports video only for the Kimi models documented to accept it', () => {
    // Matches the official Kimi Code table: k3 and kimi-for-coding are
    // "Image, video"; k3-256k is "Image only".
    expect(kimiCodeModalities('k3')).toContain('video')
    expect(kimiCodeModalities('kimi-for-coding')).toContain('video')
    expect(kimiCodeModalities('kimi-for-coding-highspeed')).toContain('video')
    expect(kimiCodeModalities('k3-256k')).not.toContain('video')
  })

  it('matches the capability list the official client ships, model by model', () => {
    // Transcribed from the managed model table in the official Kimi Code CLI
    // config (capabilities = [...] per model). Note the asymmetry: video is on
    // three models, dynamically loaded tools on three DIFFERENT ones -- the
    // HighSpeed model has video but not dynamic tools.
    const table: Record<string, { video: boolean; dynamic: boolean }> = {
      'k3': { video: true, dynamic: true },
      'k3-256k': { video: false, dynamic: true },
      'kimi-for-coding': { video: true, dynamic: true },
      'kimi-for-coding-highspeed': { video: true, dynamic: false },
    }
    for (const [id, expected] of Object.entries(table)) {
      expect(kimiCodeModalities(id).includes('video'), id + ' video').toBe(expected.video)
      expect(kimiCodeModelDef(id)?.supportsDynamicTools, id + ' dynamic tools').toBe(expected.dynamic)
    }
  })

  it('never puts a video part on a sibling wire', () => {
    const options = { model: 'claude-sonnet-4-6', messages: [videoMessage()] } as GenerateOptions
    for (const wire of ['openai', 'anthropic'] as const) {
      const serialized = JSON.stringify(buildCommandCodeRequest(options, wire))
      expect(serialized).not.toContain('video_url')
    }
  })

  it('serializes a video part for Kimi only on the OpenAI-compatible wire', () => {
    const options = { model: 'k3', messages: [videoMessage()] } as GenerateOptions
    const openai = JSON.stringify(buildKimiCodeRequest(options, 'openai', new Map(), true, {
      videoAccepted: true,
      videos: new Map([['v1', { kind: 'inline' as const, mediaType: 'video/mp4', data: 'AAAA' }]]),
    }))
    expect(openai).toContain('video_url')
    const anthropic = JSON.stringify(buildKimiCodeRequest(options, 'anthropic'))
    expect(anthropic).not.toContain('video_url')
  })
})

describe('declarations cannot reach a sibling route', () => {
  it('keeps the symbol carrier out of a Command Code request', () => {
    // The carrier is non-enumerable, so a sibling serializer must not see it;
    // this pins that a shared history cannot smuggle tools into another route.
    const message = { role: 'system', content: [] } as unknown as Message
    Object.defineProperty(message, Symbol.for('dsh-chatgpt-subscription.kimi-code.messageTools'), {
      value: [{ name: 'search_docs', description: 'd', parameters: {} }],
      enumerable: false,
    })
    const options = {
      model: 'claude-sonnet-4-6',
      messages: [message, { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message],
    } as GenerateOptions
    for (const wire of ['openai', 'anthropic'] as const) {
      expect(JSON.stringify(buildCommandCodeRequest(options, wire))).not.toContain('search_docs')
    }
  })
})
