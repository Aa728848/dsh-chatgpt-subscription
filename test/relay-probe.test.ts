import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RELAY_PROBE_ENV,
  RELAY_PROBE_FILE_ENV,
  RELAY_PROBE_FILE_NAME,
  RelayProbe,
  createFileRelayProbeSink,
  installRelayProbe,
  relayProbeEnabled,
  relayProbeEnvValue,
  relayProbeLogPath,
} from '../src/host/relay-probe.ts'

const PARENT = { id: 'session-parent-0000', header: { agentPreset: 'ptc' } }
const CHILD = { id: 'session-child-1111', header: { origin: 'subagent', parentSession: 'session-parent-0000' } }

function collector(): { lines: string[]; sink: { write(line: string): void } } {
  const lines: string[] = []
  return { lines, sink: { write: (line) => { lines.push(line) } } }
}

function agent(status: string, nextStep: number, nextTurn: number) {
  return {
    get: () => ({ status, inbox: { nextStep: new Array(nextStep).fill({}), nextTurn: new Array(nextTurn).fill({}) } }),
  }
}

describe('relay probe: the child→parent delivery fingerprint', () => {
  it('records insert, claim, model request, assistant content and turn end', () => {
    const { lines, sink } = collector()
    const probe = new RelayProbe({ sink, agents: agent('idle', 0, 0) })
    const relay = {
      id: 'm-relay-1',
      role: 'user',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-child-1111' },
      content: [{ type: 'text', text: 'Agent session-child-1111 sent a message: done' }],
    }

    probe.observe(PARENT, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', start: 0, inserted: [relay] },
    })
    probe.observe(PARENT, { type: 'user/message', data: { turn: 4, message: relay } })
    probe.observe(PARENT, { type: 'turn/start', data: { turn: 4 } })
    probe.observe(PARENT, { type: 'step/start', data: { turn: 4, step: 1 } })
    probe.observe(PARENT, {
      type: 'request/header',
      data: { header: { config: { provider: 'codex-chatgpt', model: 'gpt-6-astra' } }, reason: 'series', startsSeries: true },
    })
    probe.observe(PARENT, {
      type: 'assistant/message',
      data: {
        turn: 4,
        step: 1,
        message: { role: 'assistant', source: { provider: 'codex-chatgpt', model: 'gpt-6-astra' }, content: [] },
      },
    })
    probe.observe(PARENT, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })

    const joined = lines.join('\n')
    expect(joined).toContain('inbox-insert')
    expect(joined).toContain('kind=agent-message')
    expect(joined).toContain('form=relay')
    expect(joined).toContain('user-committed')
    expect(joined).toContain('sender=session-child-1111')
    expect(joined).toContain('agent-state')
    expect(joined).toContain('resident=yes status=idle')
    expect(joined).toContain('turn-start turn=4')
    expect(joined).toContain('step-start turn=4 step=1')
    expect(joined).toContain('request provider=codex-chatgpt model=gpt-6-astra')
    expect(joined).toContain('startsSeries=yes')
    expect(joined).toContain('visible=no')
    expect(joined).toContain('turn-end turn=4 reason=completed')
  })

  it('logs a resident=no snapshot when the parent Agent is gone', () => {
    const { lines, sink } = collector()
    const probe = new RelayProbe({ sink })
    probe.observe(PARENT, {
      type: 'user/message',
      data: { message: { id: 'm1', source: { kind: 'subagent-settled', form: 'notice', summary: 'child settled' }, content: [{ type: 'text', text: 'x' }] } },
    })
    expect(lines.join('\n')).toContain('resident=no')
  })

  it('stays quiet for sessions that never carried a delivery', () => {
    const { lines, sink } = collector()
    const probe = new RelayProbe({ sink, agents: agent('idle', 0, 0) })
    probe.observe({ id: 'session-other-2222' }, { type: 'turn/start', data: { turn: 1 } })
    probe.observe({ id: 'session-other-2222' }, { type: 'request/header', data: { header: { config: { provider: 'x', model: 'y' } } } })
    expect(lines).toEqual([])
  })

  it('records the child side: the send attempt and a refused delivery', () => {
    const { lines, sink } = collector()
    const probe = new RelayProbe({ sink })
    probe.observe(CHILD, {
      type: 'tool/call',
      data: { message: { content: [{ type: 'tool-call', id: 'call_1', name: 'send_message', arguments: '{}' }] } },
    })
    probe.observe(CHILD, {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            isError: true,
            content: [{ type: 'text', text: 'Error: direct parent is not live; the message was not delivered' }],
          }],
        },
      },
    })
    const joined = lines.join('\n')
    expect(joined).toContain('child-send')
    expect(joined).toContain('tool=send_message')
    expect(joined).toContain('child-send-failed')
    expect(joined).toContain('marker="direct parent is not live"')
  })

  it('never throws on hostile input and counts what it dropped', () => {
    const { sink } = collector()
    const probe = new RelayProbe({
      sink: { write: () => { throw new Error('sink down') } },
      agents: { get: () => { throw new Error('registry down') } },
    })
    expect(() => probe.observe(PARENT, { type: 'user/message', data: { message: { id: 'm', source: { kind: 'agent-message' }, content: [] } } })).not.toThrow()
    expect(() => probe.observe(PARENT, { type: 'turn/end', data: {} })).not.toThrow()
    expect(() => probe.observe(undefined as never, null as never)).not.toThrow()
    expect(probe.failures).toBeGreaterThan(0)
  })

  it('does not record message text of ordinary traffic', () => {
    const { lines, sink } = collector()
    const probe = new RelayProbe({ sink, agents: agent('running', 1, 0) })
    const secret = 'sk-do-not-log-me'
    probe.observe(PARENT, {
      type: 'user/message',
      data: { message: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: secret }] } },
    })
    probe.observe(PARENT, { type: 'turn/start', data: { turn: 2 } })
    expect(lines.join('\n')).not.toContain(secret)
  })
})

describe('relay probe: enablement and sink', () => {
  it('reads the environment switch', () => {
    expect(relayProbeEnabled({})).toBe(false)
    expect(relayProbeEnabled({ [RELAY_PROBE_ENV]: '0' })).toBe(false)
    expect(relayProbeEnabled({ [RELAY_PROBE_ENV]: 'off' })).toBe(false)
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(relayProbeEnabled({ [RELAY_PROBE_ENV]: value })).toBe(true)
    }
  })

  it('resolves the log path, with an override', () => {
    expect(relayProbeLogPath({}, { home: 'C:\\home\\.dsh' })).toBe(join('C:\\home\\.dsh', RELAY_PROBE_FILE_NAME))
    expect(relayProbeLogPath({ [RELAY_PROBE_FILE_ENV]: ' D:\\logs\\relay.log ' }, { home: 'ignored' })).toBe('D:\\logs\\relay.log')
  })

  it('honours an env file after the process environment, and only when asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-probe-env-'))
    try {
      const envFile = join(dir, '.env')
      writeFileSync(envFile, [
        '# probe settings',
        `export ${RELAY_PROBE_ENV} = "on"`,
        `${RELAY_PROBE_FILE_ENV}='log-from-env.log'`,
        '',
      ].join('\n'))
      expect(relayProbeEnvValue(RELAY_PROBE_ENV, {}, { envFile })).toBe('on')
      expect(relayProbeEnabled({}, { envFile })).toBe(true)
      expect(relayProbeLogPath({}, { envFile })).toBe('log-from-env.log')
      // The process environment wins, and no envFile means no file is read.
      expect(relayProbeEnabled({ [RELAY_PROBE_ENV]: '0' }, { envFile })).toBe(false)
      expect(relayProbeEnabled({}, { envFile: null })).toBe(false)
      expect(relayProbeEnabled({}, { envFile: join(dir, 'missing.env') })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends through the file sink and truncates past its cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-probe-'))
    try {
      const path = join(dir, 'nested', 'relay-probe.log')
      const sink = createFileRelayProbeSink({ path, maxBytes: 40 })
      sink.write('first-line')
      sink.write('second-line')
      expect(readFileSync(path, 'utf8')).toContain('first-line')
      writeFileSync(path, 'x'.repeat(100))
      sink.write('after-cap')
      expect(readFileSync(path, 'utf8').trim()).toBe('after-cap')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('attaches to session events and detaches on dispose', () => {
    const { lines, sink } = collector()
    const listeners: Array<(session: unknown, event: unknown) => void> = []
    let disposed = 0
    const ctx = {
      on: (_event: 'session/event', listener: (session: unknown, event: unknown) => void) => {
        listeners.push(listener)
        return () => { disposed += 1 }
      },
      get: () => undefined,
      logger: { info: () => undefined },
    }
    const dispose = installRelayProbe(ctx as never, { sink, path: 'memory' })
    expect(lines.join('\n')).toContain('probe-start pid=')
    for (const listener of listeners) {
      listener(PARENT, {
        type: 'user/message',
        data: { message: { id: 'm3', source: { kind: 'agent-message', form: 'relay' }, content: [] } },
      })
    }
    expect(lines.join('\n')).toContain('user-committed')
    dispose()
    expect(disposed).toBe(1)
  })
})
