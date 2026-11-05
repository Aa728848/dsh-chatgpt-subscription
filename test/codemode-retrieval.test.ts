/**
 * 程序内检索的**行为基线**：口语化中文查询必须能找到工具。
 *
 * 这一组断言不是词法细节测试，而是「模型实际会不会空手而归」的度量。基线值来自实测：
 * 修复前零命中 4/16、top1 4/16、top8 9/16；修复后零命中 0、top1 14/16、top8 16/16。
 * 阈值留出余量（零命中必须为 0，top8 ≥ 15/16），改动检索算法时它可以立刻报警。
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

describe('程序内检索的行为基线', () => {
  it('口语化查询零命中为 0，top8 召回不低于 15/16', async () => {
    const rules = createRules({})
    const defs = createDiscoveryDefinitions(rules, () => catalog, () => null) as {
      name: string; execute: (args: unknown) => Promise<{ tools: { name: string }[] }>
    }[]
    const search = defs.find((d) => d.name === 'code_tools_search')!
    let zero = 0, top1 = 0, top8 = 0
    const rows: string[] = []
    for (const [query, expected] of queries) {
      const { tools } = await search.execute({ query, limit: 8 })
      const names = tools.map((t) => t.name)
      const anyHit = names.includes(expected!)
      const first = names[0] === expected
      if (names.length === 0) zero += 1
      if (first) top1 += 1
      if (anyHit) top8 += 1
      rows.push((first ? 'TOP1 ' : anyHit ? 'TOP8 ' : 'MISS ') + query + ' -> ' + (names[0] ?? '(空)') + ' [' + expected + ']')
    }
    // 失败时把逐条结果打进断言消息，省去再跑一次定位。
    expect(zero, rows.join('\n')).toBe(0)
    expect(top8, rows.join('\n')).toBeGreaterThanOrEqual(15)
    expect(top1, rows.join('\n')).toBeGreaterThanOrEqual(12)
  })
})
