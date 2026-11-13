/**
 * The doctor: one command that answers "why is this line not working?".
 *
 * Every stage is injected, so these tests exercise the ordering and the early
 * exits without a live agent - and the same function is what a real self-check
 * runs against the official CLI.
 */
import { describe, expect, it, vi } from 'vitest'
import { formatDoctorReport, runDoctor, type DoctorProbes } from '../src/host/antigravity-acp/doctor.ts'
import type { AcpClient } from '../src/host/antigravity-acp/acp-client.ts'

const LAUNCH = { command: '/usr/local/bin/agy', args: ['acp'] }

/** A client stand-in; every probe below ignores it. */
const client = { dispose: async () => undefined } as unknown as AcpClient

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    resolveBinary: async () => ({ path: '/usr/local/bin/agy', version: '1.5.3', kind: 'local-cli' }),
    resolveLaunch: async () => LAUNCH,
    spawnClient: () => client,
    probeAuth: async () => ({ authenticated: true, tier: { id: 't', name: 'Google AI Ultra' } }),
    readCatalog: async () => ({ models: [{ id: 'gemini-4-carbon', name: 'G', efforts: ['low'] }] }),
    ...overrides,
  }
}

describe('runDoctor', () => {
  it('reports every stage in order when everything works', async () => {
    const report = await runDoctor(probes({
      probePrompt: async () => 'ACP_OK',
    }))
    expect(report.ok).toBe(true)
    // Binary first, then the live stages: the executable is what every later
    // stage depends on, so the report reads in the order a user would fix them.
    expect(report.steps.map((step) => step.id)).toEqual(['binary', 'protocol', 'auth', 'catalog', 'prompt'])
    expect(report.steps.every((step) => step.ok)).toBe(true)
  })

  it('stops at the binary when there is none, and says what to do', async () => {
    const report = await runDoctor(probes({
      resolveBinary: async () => ({ error: 'no archive for this platform' }),
      spawnClient: () => { throw new Error('must not spawn') },
    }))
    expect(report.ok).toBe(false)
    expect(report.steps).toHaveLength(1)
    expect(report.steps[0]).toMatchObject({ id: 'binary', ok: false })
    expect(report.steps[0]!.detail).toContain('no archive for this platform')
  })

  it('stops at sign-in rather than reporting an empty catalogue', async () => {
    const report = await runDoctor(probes({
      probeAuth: async () => ({ authenticated: false }),
      readCatalog: async () => { throw new Error('must not read a catalogue while signed out') },
    }))
    expect(report.ok).toBe(false)
    expect(report.steps.map((step) => step.id)).toEqual(['binary', 'protocol', 'auth'])
    expect(report.steps.find((step) => step.id === 'auth')!.detail).toContain('agy acp --login')
  })

  it('reports an empty catalogue as a failure, not as a working line', async () => {
    const report = await runDoctor(probes({
      readCatalog: async () => ({ models: [] }),
    }))
    expect(report.ok).toBe(false)
    expect(report.steps.at(-1)).toMatchObject({ id: 'catalog', ok: false })
  })

  it('turns a failed prompt into a FAIL line instead of throwing', async () => {
    const report = await runDoctor(probes({
      probePrompt: async () => { throw new Error('agent exited') },
    }))
    expect(report.ok).toBe(false)
    expect(report.steps.at(-1)).toMatchObject({ id: 'prompt', ok: false })
    expect(report.steps.at(-1)!.detail).toContain('agent exited')
  })
})

describe('formatDoctorReport', () => {
  it('aligns one line per stage and ends with a verdict', async () => {
    const report = await runDoctor(probes())
    const lines = formatDoctorReport(report)
    expect(lines[0]).toMatch(/^OK\s+binary/)
    expect(lines.at(-1)).toBe('Antigravity (ACP) is ready.')
  })
})
