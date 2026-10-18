import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { inject as pluginInject } from '../src/index.ts'

/**
 * 源码纪律守卫：`src/index.ts` 不出现 inject 之外的**服务属性直读**。
 *
 * 真实 Cordis 里，没写进 `inject` 的服务名不能直接当属性读——apply 当场抛
 * `cannot get property "..." without inject`，整个插件降级。线上真出现过这种
 * 故障：「进展更新」的可选服务 `sessionProjections` 一度被写成
 * `ctx.sessionProjections`，插件一启动就是 degraded，而所有用假 ctx 的测试都
 * 放过它（假 ctx 给它备了个属性）。
 *
 * 运行时那种写法在这条路径上太脆（apply 与回调读服务的时机不同、服务可能在
 * 挂载之后才 settle），所以这一条改成**对源码本身**的静态断言：除了
 * `inject` 白名单、`ctx.inject([...])` 自己声明的服务、以及 ctx 的基础成员，
 * `src/index.ts` 里不得出现 `ctx.<服务名>` 形式的直接读取。
 *
 * 可选服务必须走 `ctx.get('name')`（`get` 本身是基础成员，不需要声明）。
 */
describe('源码纪律：src/index.ts 不直读 inject 之外的服务', () => {
  /** ctx 上的基础成员：不是服务，任何上下文都直接可读。 */
  const BUILTINS = new Set([
    'effect', 'on', 'get', 'emit', 'inject', 'set', 'logger', 'scope', 'fiber',
  ])

  it('只通过 ctx.get() 取可选服务', async () => {
    const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // ctx.inject(['web'], ...) 自己声明的服务也是合法的：回调里读的就是它。
    const scoped = [...source.matchAll(/\bctx\.inject\(\s*\[([^\]]*)\]/g)]
      .flatMap(match => [...match[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map(q => q[1] ?? q[2]!))
    const allowed = new Set<string>([...pluginInject, ...scoped, ...BUILTINS])
    // 找 ctx.<ident> 形式的属性读取。
    const accessed = [...source.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)].map(match => match[1]!)
    const illegal = [...new Set(accessed)].filter(key => !allowed.has(key))
    expect(illegal).toEqual([])
  })

  it('白名单本身是对的：inject 里列的就是插件真正依赖的服务', () => {
    expect(pluginInject).toContain('tools')
    // 进展更新用到的两个可选服务绝不能出现在 inject 里：它们随 harness 是否装
    // agent-loop 而定，写进去会让插件在没有它们的宿主上挂不上。
    expect(pluginInject).not.toContain('sessions')
    expect(pluginInject).not.toContain('sessionProjections')
    expect(pluginInject).not.toContain('systemPrompt')
  })

  it('进展更新子模块同样不直读属性：可选服务一律 ctx.get()', async () => {
    const source = await fs.readFile(new URL('../src/host/progress-updates/index.ts', import.meta.url), 'utf8')
    // 子模块拿到的上下文是结构类型，服务只能从 get() 出来；属性直读会在这里露出来。
    const accessed = [...source.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)].map(match => match[1]!)
    expect([...new Set(accessed)].sort()).toEqual(['effect', 'get', 'on'])
  })
})
