import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { installProgressUpdates, resolveProgressUpdatesSettings } from '../src/host/progress-updates/index.ts'
import { NUDGE_THRESHOLD } from '../src/host/progress-updates/store.ts'
import { PROGRESS_UPDATES_PATH, PROGRESS_API_PREFIX } from '../src/host/progress-updates/routes.ts'
import { NOTIFY_USER_TOOL } from '../src/host/progress-updates/tool.ts'

/**
 * 宿主半边的两条真实链路：
 *
 * 1. **设置项的活引用**：loader 把 `volatile()` 字段解析成一个 `{ get() }` 引用，
 *    设置保存时就地写进这个引用，不重挂插件行。所以「打开开关 → 工具真的开始
 *    工作」必须靠每次重读引用，这份测试钉的就是这条路径。
 * 2. **进展到浏览器的唯一通道**：`GET /api/dsh-progress-updates/updates`。
 *    浏览器是另一个运行时，只能走同源 HTTP；这里直接调 route handler，验证写入
 *    的进展能被读回来，并验证 loopback 信任栅栏。
 */

/** loader 交给插件的那种活引用：值可以被持有者就地更新。 */
function liveRef<T>(initial: T): { get(): T, set(next: T): void } {
  let current = initial
  return { get: () => current, set: (next) => { current = next } }
}

const disposers: Array<() => void> = []

/**
 * effect 的替身：跑一次副作用函数，把它的 disposer 收进 disposers。
 * 只依赖模块级的 disposers，不捕获任何用例局部变量，所以放在模块作用域。
 * @param fn - 要跑的副作用函数。
 * @returns 副作用函数交回的 disposer，原样返回给插件。
 */
const effect = (fn: () => unknown) => {
  const disposer = fn()
  disposers.push(disposer as () => void)
  return disposer
}

interface FakeRoute {
  kind: string
  path: string
  handler: (req: never, res: never) => void
}

/** 最小宿主上下文：四个可选服务都只从 `get()` 后面出现（真实 Cordis 的形状）。 */
function makeCtx() {
  const tools = new Map<string, { name: string, execute: (args: never, exec: never) => Promise<unknown> }>()
  const sections = new Map<string, { name: string, text: string | ((context: unknown) => string) }>()
  const routes = new Map<string, FakeRoute>()
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const ctx = {
    effect,
    on: (event: string, listener: (...args: never[]) => unknown) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    get: (key: string): unknown => {
      if (key === 'tools') {
        return {
          register: (tool: { name: string }) => {
            tools.set(tool.name, tool as never)
            return () => { tools.delete(tool.name) }
          },
        }
      }
      if (key === 'systemPrompt') {
        return {
          section: (section: { name: string }) => {
            sections.set(section.name, section as never)
            return () => { sections.delete(section.name) }
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
      return undefined
    },
  }
  return {
    ctx,
    tools,
    sections,
    routes,
    /**
     * 调一次真实的 route handler。
     * @param url - 请求 URL（含 query）。
     * @param request - 覆盖默认请求字段。
     * @returns 状态码与解析后的响应体。
     */
    callRoute(url: string, request: Record<string, unknown> = {}): { status: number, body: unknown } {
      const route = [...routes.values()][0]
      if (route === undefined) throw new Error('no route registered')
      let status = 0
      let payload = ''
      const res = {
        writeHead: (code: number) => { status = code; return res },
        end: (chunk: string) => { payload = chunk },
      }
      const req = {
        url,
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:3080' },
        ...request,
      }
      route.handler(req as never, res as never)
      return { status, body: payload === '' ? undefined : JSON.parse(payload) }
    },
  }
}

function disposeAll(): void {
  while (disposers.length > 0) disposers.pop()!()
}

beforeEach(() => {
  disposers.length = 0
})

afterEach(() => {
  disposeAll()
})

/**
 * 按本插件 Config 字段的形状挂载一次。
 * @param enabled - 总开关，可以是活引用。
 * @returns 假 ctx 与探针。
 */
function mount(enabled: boolean | { get(): boolean }) {
  const fake = makeCtx()
  installProgressUpdates(fake.ctx as never, {
    settings: () => resolveProgressUpdatesSettings({ progressUpdates: enabled as never }),
  })
  return fake
}

describe('插件 Config：两个字段都是活引用', () => {
  it('解析出来的就是 { get() } 引用，默认开启、阈值 8', () => {
    // 默认开启：装上插件即开箱可用，用户可随时在设置里关掉。
    const parsed = Config({})
    expect(parsed.progressUpdates?.get()).toBe(true)
    expect(parsed.progressUpdatesNudgeThreshold?.get()).toBe(NUDGE_THRESHOLD)
  })

  it('输出语言默认 auto，显式值原样读回', () => {
    expect(Config({}).progressUpdatesLanguage?.get()).toBe('auto')
    expect(Config({ progressUpdatesLanguage: 'zh' }).progressUpdatesLanguage?.get()).toBe('zh')
  })

  it('显式写 false 时解析出来是关闭（默认值改了不等于关不掉）', () => {
    const parsed = Config({ progressUpdates: false })
    expect(parsed.progressUpdates?.get()).toBe(false)
  })

  it('解析出来的引用正是挂载函数认识的形状', () => {
    const parsed = Config({ progressUpdates: true, progressUpdatesNudgeThreshold: 3 })
    expect(resolveProgressUpdatesSettings(parsed)).toEqual({ enabled: true, nudgeThreshold: 3, language: 'auto' })
  })

  it('阈值有下界：0 与负数被 schema 拒绝，而不是变成"每轮都催"', () => {
    expect(() => Config({ progressUpdatesNudgeThreshold: 0 })).toThrow()
    expect(() => Config({ progressUpdatesNudgeThreshold: 51 })).toThrow()
  })
})

describe('开关：loader 的活引用', () => {
  it('活引用为 true 时工具返回 displayed:true，切换成 false 后立刻返回 displayed:false', async () => {
    const enabled = liveRef(true)
    const fake = mount(enabled)
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ message: '第一条' } as never, {} as never)).toEqual({ displayed: true })
    // 设置保存：loader 把新值就地写进同一个引用，不重挂插件行。
    enabled.set(false)
    expect(await tool.execute({ message: '第二条' } as never, {} as never)).toEqual({ displayed: false })
    // 再打开也能立刻生效。
    enabled.set(true)
    expect(await tool.execute({ message: '第三条' } as never, {} as never)).toEqual({ displayed: true })
  })

  it('同样的活引用也驱动提示词引导：关掉就返回空串', () => {
    const enabled = liveRef(false)
    const fake = mount(enabled)
    const section = fake.sections.get('plugin:progress-updates')!
    const render = section.text as () => string
    expect(render()).toBe('')
    enabled.set(true)
    expect(render()).toContain('progress_update')
    enabled.set(false)
    expect(render()).toBe('')
  })

  it('普通值（没有 get 的裸布尔）也照常工作，供测试与手工上下文使用', async () => {
    const fake = mount(true)
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    expect(await tool.execute({ message: 'x' } as never, {} as never)).toEqual({ displayed: true })
  })
})

describe('进展路由：浏览器半边的唯一取数通道', () => {
  it('注册在约定的路径上（客户端半边的取数常量写死了这个形状）', () => {
    const fake = mount(true)
    expect(PROGRESS_API_PREFIX).toBe('/api/dsh-progress-updates')
    expect([...fake.routes.keys()]).toContain('/api/dsh-progress-updates/updates')
    expect(PROGRESS_UPDATES_PATH).toBe('/api/dsh-progress-updates/updates')
  })

  it('写进去的进展能被浏览器读回来', async () => {
    const fake = mount(true)
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    await tool.execute({ title: '定位到根因', message: '正文一' } as never, {} as never)
    await tool.execute({ message: '正文二' } as never, {} as never)

    const response = fake.callRoute('/api/dsh-progress-updates/updates?session=session')
    expect(response.status).toBe(200)
    const body = response.body as { updates: Array<{ title?: string, message: string, at: number, id: string }> }
    expect(body.updates).toHaveLength(2)
    expect(body.updates[0]).toMatchObject({ title: '定位到根因', message: '正文一' })
    expect(body.updates[1]?.message).toBe('正文二')
    expect(typeof body.updates[0]?.at).toBe('number')
  })

  it('无条件不带 session 时回退到默认桶', async () => {
    const fake = mount(true)
    const tool = fake.tools.get(NOTIFY_USER_TOOL)!
    await tool.execute({ message: '只有一条' } as never, {} as never)

    const response = fake.callRoute('/api/dsh-progress-updates/updates')
    expect(response.status).toBe(200)
    expect((response.body as { updates: unknown[] }).updates).toHaveLength(1)
  })

  it('没有进展时返回空数组而不是 404', () => {
    const fake = mount(true)
    const response = fake.callRoute('/api/dsh-progress-updates/updates?session=nobody')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ updates: [] })
  })

  it('信任栅栏：非 loopback 来源被拒 403', () => {
    const fake = mount(true)
    const response = fake.callRoute('/api/dsh-progress-updates/updates', {
      socket: { remoteAddress: '192.168.1.50' },
      headers: { host: '192.168.1.50:3080' },
    })
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ ok: false })
  })

  it('信任栅栏：loopback 但 Host 头不是 loopback 也拒', () => {
    const fake = mount(true)
    const response = fake.callRoute('/api/dsh-progress-updates/updates', {
      headers: { host: 'example.com' },
    })
    expect(response.status).toBe(403)
  })

  it('信任栅栏：跨站 fetch 标记被拒', () => {
    const fake = mount(true)
    const response = fake.callRoute('/api/dsh-progress-updates/updates', {
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(403)
  })

  it('开关关闭时路由照常注册并返回空态（客户端要能渲染空态而不是报错）', () => {
    const fake = mount(false)
    expect([...fake.routes.keys()]).toContain('/api/dsh-progress-updates/updates')
    const response = fake.callRoute('/api/dsh-progress-updates/updates')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ updates: [] })
  })

  it('响应带 no-store：进展实时变化，缓存住就等于展示过期数据', () => {
    const fake = mount(true)
    const route = [...fake.routes.values()][0]!
    const headers: Record<string, unknown> = {}
    const res = {
      writeHead: (_code: number, h: Record<string, unknown>) => { Object.assign(headers, h); return res },
      end: () => {},
    }
    route.handler({
      url: '/api/dsh-progress-updates/updates',
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3080' },
    } as never, res as never)
    expect(headers['cache-control']).toBe('no-store')
  })
})
