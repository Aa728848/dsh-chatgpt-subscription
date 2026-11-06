// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findSettledJobInSession, installSettledJobGuard } from '../src/host/settled-job-guard.ts'

interface FakeSessionEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

function fakeSession(events: readonly FakeSessionEvent[]) {
  return {
    snapshotEvents: () => events,
  }
}

class FakeJobsService {
  private readonly live = new Map<string, { id: string; owner: string; status: 'running' | 'killed' }>()

  put(id: string, owner: string, status: 'running' | 'killed' = 'running'): void {
    this.live.set(id, { id, owner, status })
  }

  kill(id: string, caller?: string, _reason?: string): 'requested' | 'already-finished' {
    const job = this.live.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    if (job.owner !== caller) throw new Error(`job ${id} belongs to another session`)
    return job.status === 'killed' ? 'already-finished' : 'requested'
  }

  private lookupLive(id: string, caller?: string) {
    const job = this.live.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    if (job.owner !== caller) throw new Error(`job ${id} belongs to another session`)
    return {
      id: job.id,
      kind: 'win-bash',
      label: 'live job',
      owner: job.owner,
      status: job.status,
      startedAt: 10,
      output: { total: 5, earliest: 0 },
    }
  }

  get(id: string, caller?: string): unknown {
    return this.lookupLive(id, caller)
  }

  read(id: string, caller?: string): unknown {
    const view = this.lookupLive(id, caller)
    return { chunks: [{ text: 'hello\n' }], lossy: false, job: view }
  }

  async wait(id: string, _timeoutMs: number, caller?: string): Promise<unknown> {
    return this.lookupLive(id, caller)
  }
}

describe('settled-job-guard：子代理中断重唤醒后的已结算后台任务幂等恢复', () => {
  const ownerId = 'f170d1e0-bf85-4ec8-b716-1d107831a4f5'
  const settledId = 'win-bash-8da897c34ed34f0a'
  const session = fakeSession([
    {
      type: 'job/registered',
      seq: 571,
      data: {
        jobId: settledId,
        owner: ownerId,
        kind: 'win-bash',
        label: 'dsh web --port 3097 --no-open',
        startedAt: 1793952597602,
      },
    },
    {
      type: 'job/settled',
      seq: 1009,
      data: {
        jobId: settledId,
        owner: ownerId,
        kind: 'win-bash',
        label: 'dsh web --port 3097 --no-open',
        startedAt: 1793952597602,
        finishedAt: 1793953197222,
        status: 'killed',
        cause: 'teardown',
        producerReported: true,
        detail: 'terminated before exit',
      },
    },
  ])

  it('内存表已驱逐但当前会话日志有 job/settled 时，kill/get/read/wait 均幂等返回终态视图', async () => {
    const jobs = new FakeJobsService()
    const ctx = {
      get(name: string): unknown {
        if (name === 'jobs') return jobs
        if (name === 'agents') {
          return {
            get: (id: string) => (id === ownerId ? { id, session } : undefined),
          }
        }
        return undefined
      },
    }
    const guard = installSettledJobGuard(ctx)

    expect(jobs.kill(settledId, ownerId, 'stop QA host 3097 before reporting')).toBe('already-finished')
    expect(jobs.get(settledId, ownerId)).toEqual({
      id: settledId,
      kind: 'win-bash',
      label: 'dsh web --port 3097 --no-open',
      owner: ownerId,
      status: 'killed',
      detail: 'terminated before exit',
      startedAt: 1793952597602,
      finishedAt: 1793953197222,
      output: { total: 0, earliest: 0 },
    })
    expect(jobs.read(settledId, ownerId)).toEqual({
      chunks: [],
      lossy: false,
      job: expect.objectContaining({ id: settledId, status: 'killed', detail: 'terminated before exit' }),
    })
    await expect(jobs.wait(settledId, 5000, ownerId)).resolves.toMatchObject({
      id: settledId,
      status: 'killed',
    })

    guard.dispose()
    expect(() => jobs.kill(settledId, ownerId)).toThrow(`unknown job ${settledId}`)
  })

  it('严格维持会话隔离：其它会话不能恢复不属于自己的 job/settled，真实不存在的 id 仍报 unknown job', async () => {
    const jobs = new FakeJobsService()
    const otherSession = fakeSession([])
    const ctx = {
      get(name: string): unknown {
        if (name === 'jobs') return jobs
        if (name === 'sessions') {
          return {
            get: (id: string) => (id === ownerId ? session : id === 'other-session' ? otherSession : undefined),
          }
        }
        return undefined
      },
    }
    const guard = installSettledJobGuard(ctx)

    // 另一会话即使传入这个 jobId，它自己的日志里没有、就算伪造在日志里 owner 也不匹配。
    expect(() => jobs.kill(settledId, 'other-session')).toThrow(`unknown job ${settledId}`)
    expect(findSettledJobInSession(session, settledId, 'other-session')).toBeUndefined()
    expect(() => jobs.kill('win-bash-never-existed', ownerId)).toThrow('unknown job win-bash-never-existed')
    await expect(jobs.wait('win-bash-never-existed', 1000, ownerId)).rejects.toThrow('unknown job win-bash-never-existed')

    guard.dispose()
  })

  it('仍在内存表中的活跃任务完全走原逻辑，不受守卫影响', () => {
    const jobs = new FakeJobsService()
    jobs.put('win-bash-live', ownerId, 'running')
    const guard = installSettledJobGuard({
      get: (name: string) => (name === 'jobs' ? jobs : undefined),
    })

    expect(jobs.kill('win-bash-live', ownerId)).toBe('requested')
    expect(() => jobs.kill('win-bash-live', 'intruder')).toThrow('job win-bash-live belongs to another session')
    guard.dispose()
  })

  it('支持 jobs 服务晚于插件挂载（经 ctx.inject 延迟装配）', () => {
    const jobs = new FakeJobsService()
    let deliverJobs: (() => void) | undefined
    let mounted = false
    const ctx = {
      get(name: string): unknown {
        if (name === 'jobs') return mounted ? jobs : undefined
        if (name === 'agents') return { get: (id: string) => (id === ownerId ? { id, session } : undefined) }
        return undefined
      },
      inject(deps: string[], callback: (scope: unknown) => void): void {
        if (deps.includes('jobs')) {
          deliverJobs = () => {
            mounted = true
            callback(ctx)
          }
        }
      },
    }
    const guard = installSettledJobGuard(ctx)
    deliverJobs?.()
    expect(jobs.kill(settledId, ownerId)).toBe('already-finished')
    guard.dispose()
  })
})
