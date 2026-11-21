import { describe, expect, it } from 'vitest'
import { claudeCodeCchToken, signClaudeCodeCch } from '../src/host/common/claude-code-cch.ts'
import {
  sampleFromCapture,
  selectCchSeed,
  x64MovabsSeedCandidates,
  type CchSample,
} from '../scripts/claude-code-cch-seed.ts'

function sample(seed: bigint, text: string, file = text + '.json'): CchSample {
  const placeholder = JSON.stringify({
    system: [{ type: 'text', text: 'x-anthropic-billing-hdr: cch=00000;' }],
    model: 'claude-test',
    max_tokens: 128,
    messages: [{ role: 'user', content: text }],
  })
  const raw = signClaudeCodeCch(placeholder, seed)
  return sampleFromCapture({ url: '/v1/messages', raw, cch: claudeCodeCchToken(placeholder, seed) }, file)
}

describe('Claude Code cch seed finder', () => {
  it('extracts uint64 immediates from REX.W movabs instructions', () => {
    const first = 0x4d659218e32a3268n
    const second = 0x6e52736ac806831en
    const binary = Buffer.alloc(32)
    binary[2] = 0x48
    binary[3] = 0xb8
    binary.writeBigUInt64LE(first, 4)
    binary[20] = 0x49
    binary[21] = 0xbf
    binary.writeBigUInt64LE(second, 22)
    const candidates = x64MovabsSeedCandidates(binary)
    expect(candidates).toEqual([
      { seed: first, offset: 4, source: 'x64-movabs' },
      { seed: second, offset: 22, source: 'x64-movabs' },
    ])
  })

  it('selects only a seed that reproduces two distinct bodies byte for byte', () => {
    const seed = 0x4d659218e32a3268n
    const samples = [sample(seed, 'first'), sample(seed, 'second')]
    const hits = selectCchSeed([
      { seed: 1n, offset: 0, source: 'file' },
      { seed, offset: 10, source: 'x64-movabs' },
      { seed, offset: 20, source: 'x64-movabs' },
    ], samples)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ seed, roundTrips: [true, true] })
  })

  it('rejects a wrong seed and mismatched capture metadata', () => {
    const seed = 0x6e52736ac806831en
    const samples = [sample(seed, 'first'), sample(seed, 'second')]
    expect(selectCchSeed([{ seed: 1n, offset: 0, source: 'file' }], samples)).toEqual([])
    expect(() => sampleFromCapture({ url: '/v1/messages', raw: samples[0]!.raw, cch: '00000' }, 'bad.json'))
      .toThrow('No matching cch token')
  })

  it('does not accept a single request as sufficient evidence', () => {
    expect(() => selectCchSeed([{ seed: 1n, offset: 0, source: 'file' }], [sample(1n, 'only')]))
      .toThrow('At least two')
  })
})
