import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installProgressUpdates, resolveProgressUpdatesSettings } from '../src/host/progress-updates/index.ts'
import { PROGRESS_UPDATES_PROJECTION_KEY, type ProgressUpdatesProjectionDefinition } from '../src/host/progress-updates/projection.ts'
import type { ProgressUpdate } from '../src/host/progress-updates/store.ts'
import { NOTIFY_USER_TOOL } from '../src/host/progress-updates/tool.ts'

/**
 * 取数优先级：**先会话投影、后进程内 Map**。
 *
 * 面板在重开对话、刷新页面、宿主重启之后还能看到历史，靠的就是这条顺序 ——
 * 投影是从已持久化的会话日志折出来的，而内存 `stores` 一重启就空了。
 *
 * 这里用一套假服务驱动**真实的** `installProgressUpdates`：假 `sessionProjections`
 * 收下登记上来的定义、自己按事件折一遍（这样测的是本模块的折叠在真实挂载路径
 * 上的行为），假 `sessions` 提供活跃会话与血缘。插件拿到的上下文刻意做成真实
 * Cordis 的形状：可选服务只从 `get()` 后面出现。
 */

/** 一条会话记录：投影按对象寻址，血缘按 header 走。 */
interface FakeSession {
  header: { id: string, parentSession?: string }
}

/** 一个已登记的投影单元 + 它折出来的状态（按会话 id 分桶）。 */
interface FakeRegistry {
  definitions: ProgressUpdatesProjectionDefinition[]
  /** 每个会话的事件序列，用来重折。 */
  logs: Map<string, unknown[]>
  /** 登记一个单元（真实服务的 `register` 形状）。 */
  register(definition: ProgressUpdatesProjectionDefinition): () => void
  /** 往某个会话的日志里追加一条事件，并把它折进该会话的状态。 */
  append(session: FakeSession, event: unknown): void
  /** 某个会话的折叠状态（真实服务的 `stateOf` 形状）。 */
  stateOf(session: unknown, key: string): unknown
}

/** 造一份假投影服务。 */
function makeRegistry(): FakeRegistry {
  const definitions: ProgressUpdatesProjectionDefinition[] = []
  const logs = new Map<string, unknown[]>()
  const states = new Map<string, unknown>()

  const refold = (session: FakeSession): void => {
    for (const definition of definitions) {
      let state = definition.init(session.header, 0)
      for (const event of logs.get(session.header.id) ?? []) state = definition.apply(state, event as never)
      states.set(session.header.id + ':' + definition.key, state)
    }
  }

  return {
    definitions,
    logs,
    register(definition) {
      definitions.push(definition)
      // 登记之后按已有日志补折一次（真实服务是惰性建 cell，效果一致）。
      for (const id of logs.keys()) {
        const session = { header: { id } }
        let state = definition.init(session.header, 0)
        for (const event of logs.get(id) ?? []) state = definition.apply(state, event as never)
        states.set(id + ':' + definition.key, state)
      }
      return () => { definitions.splice(definitions.indexOf(definition), 1) }
    },
    append(session, event) {
      const bucket = logs.get(session.header.id)
      if (bucket === undefined) logs.set(session.header.id, [event])
      else bucket.push(event)
      refold(session)
    },
    stateOf(session, key) {
      const id = (session as FakeSession | undefined)?.header?.id
      return id === undefined ? undefined : states.get(id + ':' + key)
    },
  }
}

/** 造一条 progress_update 的 tool/call 事件。 */
function progressCall(seq: number, payload: { title?: string, message: string }, time = 1_000 + seq) {
  return { type: 'tool/call', seq, time, data: { turn: 1, step: 1, callId: 'c' + seq, name: NOTIFY_USER_TOOL, arguments: JSON.stringify(payload) } }
}

/** 每个用例收集的 disposer，用完统一释放。 */
const disposers: Array<() => void> = []

/**
 * effect 的替身：跑一次副作用函数，把它的 disposer 收进 disposers。
 * @param fn - 要跑的副作用函数。
 * @returns 副作用函数交回的 disposer。
 */
const effect = (fn: () => unknown) => {
  const disposer = fn()
  disposers.push(disposer as () => void)
  return disposer
}

interface FakeRoute {
  path: string
  handler: (req: never, res: never) => void
}

/** 当前用例的会话表与投影服务（用例之间重建）。 */
let sessionTable: Map<string, FakeSession>
let registry: FakeRegistry | undefined

/**
 * 造一个假宿主上下文。
 * @param withProjections - 是否提供 `sessionProjections` 服务（false 模拟老宿主）。
 * @returns 假 ctx 与探针。
 */
function makeCtx(withProjections: boolean) {
  const tools = new Map<string, { name: string, execute: (args: never, exec: never) => Promise<unknown> }>()
  const routes = new Map<string, FakeRoute>()
  const ctx = {
    effect,
    on: () => () => {},
    get: (key: string): unknown => {
      if (key === 'tools') {
        return {
          register: (tool: { name: string }) => {
            tools.set(tool.name, tool as never)
            return () => { tools.delete(tool.name) }
          },
        }
      }
      if (key === 'webServer') {
        return {
          register: (route: FakeRoute) => {
            routes.set(route.path, route)
            return () => { routes.delete(route.path) }
          },
        }
      }
      if (key === 'sessions') {
        return {
          get: (id: string) => sessionTable.get(id),
          list: () => [...sessionTable.values()],
        }
      }
      if (key === 'sessionProjections') return withProjections ? registry : undefined
      return undefined
    },
  }
  return {
    ctx,
    tools,
    /**
     * 走真实的 route handler 读一次面板数据。
     * @param session - 查询的会话 id。
     * @returns 路由交出的进展列表。
     */
    read(session: string): ProgressUpdate[] {
      const route = [...routes.values()][0]
      if (route === undefined) throw new Error('no route registered')
      let payload = ''
      const res = { writeHead: () => res, end: (chunk: string) => { payload = chunk } }
      route.handler({
        url: '/api/dsh-progress-updates/updates?session=' + encodeURIComponent(session),
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:3080' },
      } as never, res as never)
      return (JSON.parse(payload) as { updates: ProgressUpdate[] }).updates
    },
  }
}

/**
 * 挂载一次。
 * @param withProjections - 是否提供 `sessionProjections` 服务。
 * @returns 假 ctx 与探针。
 */
function mount(withProjections = true) {
  const fake = makeCtx(withProjections)
  installProgressUpdates(fake.ctx as never, {
    settings: () => resolveProgressUpdatesSettings({ progressUpdates: true }),
  })
  return fake
}

function disposeAll(): void {
  while (disposers.length > 0) disposers.pop()!()
}

beforeEach(() => {
  sessionTable = new Map()
  registry = makeRegistry()
  disposers.length = 0
})

afterEach(() => {
  disposeAll()
})

describe('取数优先级：投影优先', () => {
  it('会话日志里的进展能被读回来 —— 即使内存里一条都没有（重开对话/刷新页面）', () => {
    const root: FakeSession = { header: { id: 'root' } }
    sessionTable.set('root', root)
    registry!.append(root, progressCall(3, { title: '定位到根因', message: '正文一' }, 1_700_000_000_000))
    registry!.append(root, progressCall(5, { message: '正文二' }, 1_700_000_001_000))

    const fake = mount()
    const updates = fake.read('root')
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ id: 'pu-3-root', title: '定位到根因', message: '正文一', at: 1_700_000_000_000, source: 'root' })
    expect(updates[1]).toMatchObject({ id: 'pu-5-root', message: '正文二' })
  })

  it('挂载时就把投影登记给会话投影服务（键是 progressUpdates）', () => {
    mount()
    expect(registry!.definitions.map(definition => definition.key)).toEqual([PROGRESS_UPDATES_PROJECTION_KEY])
    // 卸载时注销：投影单元的生命周期跟着插件行走。
    disposeAll()
    expect(registry!.definitions).toHaveLength(0)
  })

  it('子会话的进展归并到顶层祖先（整棵委派树共用一份进展）', () => {
    const root: FakeSession = { header: { id: 'root' } }
    const child: FakeSession = { header: { id: 'child', parentSession: 'root' } }
    const grandchild: FakeSession = { header: { id: 'grandchild', parentSession: 'child' } }
    sessionTable.set('root', root)
    sessionTable.set('child', child)
    sessionTable.set('grandchild', grandchild)

    registry!.append(child, progressCall(1, { message: '子会话先汇报' }, 200))
    registry!.append(root, progressCall(1, { message: '主会话后汇报' }, 300))
    registry!.append(grandchild, progressCall(2, { message: '孙会话更早' }, 100))

    const fake = mount()
    // 按 at 升序：子会话的进展落在它真正发生的那个时间点上。
    expect(fake.read('root').map(update => update.message))
      .toEqual(['孙会话更早', '子会话先汇报', '主会话后汇报'])
    // 用子会话 id 查询拿到的是**它自己那一支**（自身 + 子孙），不是整棵树：
    // 折叠是按会话各折各的，读值时才合并 —— 一个子会话的进展本来就不该把
    // 它的祖先与兄弟会话的进展一并带出来。
    expect(fake.read('child').map(update => update.message)).toEqual(['孙会话更早', '子会话先汇报'])
  })

  it('投影路径可用时不再读内存：工具推进内存的那一条不会混进历史', async () => {
    const root: FakeSession = { header: { id: 'root' } }
    sessionTable.set('root', root)
    registry!.append(root, progressCall(1, { message: '日志里的' }, 100))

    const fake = mount()
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ message: '内存里的' } as never, { agent: { id: 'root', session: { header: { id: 'root' } } } } as never))
      .toEqual({ displayed: true })

    expect(fake.read('root').map(update => update.message)).toEqual(['日志里的'])
  })
})

describe('降级：投影取不到时回退内存', () => {
  it('宿主没有 sessionProjections 服务时照常挂载，updatesOf 走内存路径', async () => {
    const root: FakeSession = { header: { id: 'root' } }
    sessionTable.set('root', root)
    const fake = mount(false)

    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ title: '开始', message: '正文' } as never, { agent: { id: 'root', session: { header: { id: 'root' } } } } as never))
      .toEqual({ displayed: true })
    expect(fake.read('root').map(update => update.message)).toEqual(['正文'])
    expect(fake.read('root')[0]!.id).toMatch(/^pu-/)
  })

  it('没有会话服务时同样回退内存（读不到会话对象就没法寻址投影）', async () => {
    const fake = makeCtx(true)
    const ctx = fake.ctx as { get: (key: string) => unknown }
    const read = ctx.get
    ctx.get = (key: string): unknown => (key === 'sessions' ? undefined : read(key))
    installProgressUpdates(fake.ctx as never, {
      settings: () => resolveProgressUpdatesSettings({ progressUpdates: true }),
    })
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    await tool.execute({ message: '内存兜底' } as never, {} as never)
    expect(fake.read('session').map(update => update.message)).toEqual(['内存兜底'])
  })

  it('会话不在 sessions 里（历史会话还没 attach）时回退内存，且不抛错', async () => {
    // 日志里有进展，但 sessions.get() 认不出这个 id。
    const ghost: FakeSession = { header: { id: 'ghost' } }
    registry!.append(ghost, progressCall(1, { message: '日志里的' }, 100))
    const fake = mount()
    expect(() => fake.read('ghost')).not.toThrow()
    expect(fake.read('ghost')).toEqual([])
  })

  it('投影登记被服务拒绝时安静降级：插件照常挂载，工具照常可用', async () => {
    registry!.register = () => { throw new Error('duplicate projection key') }
    const root: FakeSession = { header: { id: 'root' } }
    sessionTable.set('root', root)
    const fake = mount()
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    await tool.execute({ message: '仍然可用' } as never, { agent: { id: 'root', session: { header: { id: 'root' } } } } as never)
    expect(fake.read('root').map(update => update.message)).toEqual(['仍然可用'])
  })
})
