/**
 * 程序内检索的**行为基线**。
 *
 * 分两组，各自回答一个不同的问题：
 *
 * 1. **英文关键词**（模型按说明段被要求写的形态）：名字/描述/参数名三种线索都要能命中，
 *    门槛卡在 top1 ≥ 14/16、top8 = 16/16。这是检索算法本身的健康度。
 * 2. **中文口语**（用户在对话里怎么说）：检索**不要求命中**——跨语言交给模型翻译，工具层
 *    只保证「不空手而归」，即零命中时必须退化为按 namespace 分组的浏览清单。
 *
 * 这两组的差别是刻意的：如果哪天有人往检索里加回一张中英对照表，第 2 组会变绿，但
 * 第 1 组才是真实主路径；而第 2 组的门槛只锁「不空手」，不会逼着后来者继续穷举。
 *
 * @module test/codemode-retrieval
 */
import { describe, expect, it } from 'vitest'
import { createDiscoveryDefinitions } from '../src/host/codemode/discovery.ts'
import { createRules } from '../src/host/codemode/rules.ts'

const catalog = [
  { name: 'mcp__okx__get_ticker', description: 'Get the latest price ticker for an instrument', parameters: { type: 'object', properties: { instId: { type: 'string' } } } },
  { name: 'mcp__okx__get_candles', description: 'Get OHLC candlestick data for an instrument', parameters: { type: 'object', properties: { instId: { type: 'string' }, bar: { type: 'string' } } } },
  { name: 'mcp__okx__place_order', description: 'Place a spot or swap order', parameters: { type: 'object', properties: { instId: { type: 'string' }, side: { type: 'string' }, sz: { type: 'string' } } } },
  { name: 'mcp__okx__get_balance', description: 'Get the account balance of every currency', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__slack__post_message', description: 'Post a message to a channel', parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'mcp__slack__list_channels', description: 'List channels the token can see', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__github__list_pull_requests', description: 'List pull requests in a repository', parameters: { type: 'object', properties: { repo: { type: 'string' } } } },
  { name: 'mcp__github__create_issue', description: 'Create an issue', parameters: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'mcp__notion__create_page', description: 'Create a page in a database', parameters: { type: 'object', properties: { parent: { type: 'string' } } } },
  { name: 'mcp__fs__list_directory', description: 'List files in a directory', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'mcp__fs__move_file', description: 'Move or rename a file', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'mcp__db__run_query', description: 'Run a read-only SQL query', parameters: { type: 'object', properties: { sql: { type: 'string' } } } },
  { name: 'mcp__crm__search_contacts', description: 'Search contacts by name or email', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'mcp__crm__create_lead', description: 'Create a sales lead', parameters: { type: 'object', properties: { email: { type: 'string' } } } },
]

const queries: [string, string | undefined][] = [
  ['查币价 BTC', 'mcp__okx__get_ticker'],
  ['BTC 现在多少钱', 'mcp__okx__get_ticker'],
  ['看一下 K 线', 'mcp__okx__get_candles'],
  ['下单买 100 USDT', 'mcp__okx__place_order'],
  ['账户余额还剩多少', 'mcp__okx__get_balance'],
  ['发消息到频道', 'mcp__slack__post_message'],
  ['把文件挪到别处', 'mcp__fs__move_file'],
  ['列一下目录', 'mcp__fs__list_directory'],
  ['未合并的 PR', 'mcp__github__list_pull_requests'],
  ['建一个 issue', 'mcp__github__create_issue'],
  ['查数据库', 'mcp__db__run_query'],
  ['找联系人', 'mcp__crm__search_contacts'],
  ['instId', 'mcp__okx__get_ticker'],
  ['sql', 'mcp__db__run_query'],
  ['ticker', 'mcp__okx__get_ticker'],
  ['order', 'mcp__okx__place_order'],
]

const englishQueries: [string, string][] = [
  ['ticker BTC', 'mcp__okx__get_ticker'],
  ['candles kline', 'mcp__okx__get_candles'],
  ['place order', 'mcp__okx__place_order'],
  ['account balance', 'mcp__okx__get_balance'],
  ['post message channel', 'mcp__slack__post_message'],
  ['move file', 'mcp__fs__move_file'],
  ['list directory', 'mcp__fs__list_directory'],
  ['pull requests', 'mcp__github__list_pull_requests'],
  ['create issue', 'mcp__github__create_issue'],
  ['sql query', 'mcp__db__run_query'],
  ['search contacts', 'mcp__crm__search_contacts'],
  ['instId', 'mcp__okx__get_ticker'],
  ['git repo', 'mcp__github__list_pull_requests'],
  ['notion page', 'mcp__notion__create_page'],
  ['slack channels', 'mcp__slack__list_channels'],
  ['mcp__okx__get_ticker', 'mcp__okx__get_ticker'],
]

/** 跑一组查询，返回统计与逐条结果。 */
async function runQueries(queries: readonly [string, string][]) {
  const rules = createRules({})
  const defs = createDiscoveryDefinitions(rules, () => catalog, () => null) as {
    name: string
    execute: (args: unknown) => Promise<{ tools: { name: string }[]; fallback?: boolean }>
  }[]
  const search = defs.find((definition) => definition.name === 'code_tools_search')!
  let zero = 0
  let top1 = 0
  let top8 = 0
  const rows: string[] = []
  for (const [query, expected] of queries) {
    const { tools, fallback } = await search.execute({ query, limit: 8 })
    const names = tools.map((tool) => tool.name)
    const anyHit = names.includes(expected)
    const first = names[0] === expected
    if (names.length === 0) zero += 1
    if (first) top1 += 1
    if (anyHit) top8 += 1
    rows.push((first ? 'TOP1 ' : anyHit ? 'TOP8 ' : 'MISS ') + query
      + ' -> ' + (names[0] ?? '(empty)') + (fallback === true ? ' [browse]' : '') + ' [' + expected + ']')
  }
  return { zero, top1, top8, rows }
}

describe('程序内检索的行为基线', () => {
  it('英文关键词：top1 ≥ 14/16，top8 全中', async () => {
    const { top1, top8, rows } = await runQueries(englishQueries)
    expect(top8, rows.join('\n')).toBe(englishQueries.length)
    expect(top1, rows.join('\n')).toBeGreaterThanOrEqual(14)
  })

  it('中文口语：不空手而归——零命中时退化为按 namespace 分组的浏览清单', async () => {
    const rules = createRules({})
    const defs = createDiscoveryDefinitions(rules, () => catalog, () => null) as {
      name: string
      execute: (args: unknown) => Promise<{ tools: { name: string }[]; fallback?: boolean }>
    }[]
    const search = defs.find((definition) => definition.name === 'code_tools_search')!
    for (const query of ['查币价 BTC', '找联系人', '把文件挪到别处', '下单买 100 USDT']) {
      const { tools, fallback } = await search.execute({ query, limit: 8 })
      // 允许命中（例如中文描述的工具），但绝不允许返回空数组。
      expect(tools.length, query).toBeGreaterThan(0)
      if (fallback === true) expect(tools.length, query).toBeLessThanOrEqual(8)
    }
  })
})
