/**
 * 结果引用存储的核心不变量。
 *
 * 这一组用例只碰自己的临时目录（每个 `it` 一个 `mkdtemp`），不读 `DSH_HOME`，
 * 也不依赖任何全局状态。清理逐个条目进行：不递归删除目录树。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CacheWarmupStoreError, type PreviewBudget } from '../src/host/cache-warmup/contracts.ts'
import { projectToolResult } from '../src/host/cache-warmup/projection.ts'
import { FileResultReferenceStore, formatResultRefId } from '../src/host/cache-warmup/store.ts'

/** 本次测试创建的临时目录。 */
const roots: string[] = []

/** 建一个独立临时目录。 */
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cache-warmup-store-'))
  roots.push(root)
  return root
}

/**
 * 逐条目清理临时目录：只删自己枚举到的具体文件与空目录。
 * 刻意不用 `fs.rm(recursive)` —— 递归删除会顺着链接把目标删掉。
 */
async function removeEntries(directory: string): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    const stats = await fs.lstat(full).catch(() => undefined)
    if (stats === undefined || stats.isSymbolicLink()) {
      await fs.rm(full, { force: true }).catch(() => undefined)
      continue
    }
    if (stats.isDirectory()) await removeEntries(full)
    else await fs.rm(full, { force: true }).catch(() => undefined)
  }
  await fs.rmdir(directory).catch(() => undefined)
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await removeEntries(root)
  }
})

/** 取一次存储调用的错误，而不是让断言只看 "rejects"。 */
async function storeError(promise: Promise<unknown>): Promise<CacheWarmupStoreError> {
  try {
    await promise
  } catch (error) {
    return error as CacheWarmupStoreError
  }
  throw new Error('expected the store call to reject')
}

/** 一份大请求的 shell 失败日志，用来触发投影。 */
function shellFailureLog(): string {
  const lines = ['$ npm run build']
  for (let index = 0; index < 60; index += 1) lines.push(`[build] compiled module ${index}`)
  lines.push('src/a.ts(12,3): error TS2322: Type string is not assignable to number')
  lines.push('src/b.ts(4,9): error TS1005: ; expected')
  lines.push('npm ERR! code ELIFECYCLE')
  lines.push('[exit code: 1]')
  return lines.join('\n')
}

/** 只够装下预览头的预算：让投影必然发生，同时又不至于超预算。 */
const PREVIEW_BUDGET: PreviewBudget = { maxChars: 700, warmup: true, consecutiveHits: 0, hitRatio: 0 }

describe('FileResultReferenceStore 内容寻址与幂等', () => {
  it('refId 是 ref://<session>/<sha256>，文件内容与原文逐字相同', async () => {
    const root = await makeRoot()
    const store = new FileResultReferenceStore({ rootDir: root })
    const content = '失败日志\n第二行：中文与 emoji 🙂'
    const reference = await store.put({ sessionId: 'session-a', content })

    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
    expect(reference.refId).toBe(`ref://session-a/${digest}`)
    expect(reference.refId).toBe(formatResultRefId('session-a', digest))
    expect(reference.bytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(reference.chars).toBe(content.length)
    expect(reference.created).toBe(true)

    const file = path.join(root, 'session-a', `${digest}.txt`)
    expect(await fs.readFile(file, 'utf8')).toBe(content)
  })

  it('put 幂等：同内容返回同一引用，不重写文件、不留第二份', async () => {
    const root = await makeRoot()
    const store = new FileResultReferenceStore({ rootDir: root })
    const content = 'x'.repeat(200)

    const first = await store.put({ sessionId: 'session-a', content })
    const file = path.join(root, 'session-a', `${first.digest}.txt`)
    const before = await fs.stat(file)
    const second = await store.put({ sessionId: 'session-a', content })
    const after = await fs.stat(file)

    expect(second.refId).toBe(first.refId)
    expect(second.created).toBe(false)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await fs.readdir(path.join(root, 'session-a'))).toEqual([`${first.digest}.txt`])
  })

  it('原子写入：目录里没有留下临时文件', async () => {
    const root = await makeRoot()
    const store = new FileResultReferenceStore({ rootDir: root })
    await store.put({ sessionId: 'session-a', content: 'file A' })
    await store.put({ sessionId: 'session-a', content: 'file B' })
    const names = await fs.readdir(path.join(root, 'session-a'))
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('宿主侧文件权限是 0600', async () => {
    const root = await makeRoot()
    const store = new FileResultReferenceStore({ rootDir: root })
    const reference = await store.put({ sessionId: 'session-a', content: 'secret' })
    const stats = await fs.stat(path.join(root, 'session-a', `${reference.digest}.txt`))
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('拒绝非法 session id（挡住路径穿越）', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    expect((await storeError(store.put({ sessionId: '../etc', content: 'x' }))).code).toBe('SESSION_INVALID')
    expect((await storeError(store.put({ sessionId: '', content: 'x' }))).code).toBe('SESSION_INVALID')
  })
})

describe('FileResultReferenceStore 上限与淘汰', () => {
  it('单结果超限直接拒绝，且不建目录', async () => {
    const root = await makeRoot()
    const store = new FileResultReferenceStore({ rootDir: root, maxResultBytes: 32 })
    expect((await storeError(store.put({ sessionId: 'session-a', content: 'x'.repeat(64) }))).code).toBe(
      'RESULT_TOO_LARGE',
    )
    await expect(fs.readdir(path.join(root, 'session-a'))).rejects.toThrow()
  })

  it('session 超限只淘汰最旧的具体文件，其他引用仍可读', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot(), maxSessionBytes: 120 })
    const first = await store.put({ sessionId: 'session-a', content: 'a'.repeat(40) })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const second = await store.put({ sessionId: 'session-a', content: 'b'.repeat(40) })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const third = await store.put({ sessionId: 'session-a', content: 'c'.repeat(40) })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const fourth = await store.put({ sessionId: 'session-a', content: 'd'.repeat(40) })

    expect((await storeError(store.page({ sessionId: 'session-a', refId: first.refId }))).code).toBe(
      'RESULT_NOT_FOUND',
    )
    for (const reference of [second, third, fourth]) {
      expect((await store.page({ sessionId: 'session-a', refId: reference.refId })).complete).toBe(true)
    }
    // 淘汰只删文件，会话目录本身还在。
    const remaining = await fs.readdir(path.join(store.rootDir(), 'session-a'))
    expect(remaining).toHaveLength(3)
  })
})

describe('FileResultReferenceStore 归属与生命周期', () => {
  it('越权读取给出明确错误，且不泄露另一个 session 的内容或存在性', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const other = await store.put({ sessionId: 'session-b', content: '机密内容：别的会话的原文' })
    const error = await storeError(store.page({ sessionId: 'session-a', refId: other.refId }))
    expect(error).toBeInstanceOf(CacheWarmupStoreError)
    expect(error.code).toBe('SESSION_MISMATCH')
    expect(error.message).not.toContain('机密内容')
    expect(error.message).not.toContain('session-b')
  })

  it('非法引用形状被拒绝', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    expect((await storeError(store.page({ sessionId: 'session-a', refId: 'ref://session-a/nothex' }))).code).toBe(
      'REFERENCE_INVALID',
    )
    expect((await storeError(store.page({ sessionId: 'session-a', refId: 'file:///etc/passwd' }))).code).toBe(
      'REFERENCE_INVALID',
    )
  })

  it('release 后缺页返回明确错误；重复 release 返回 false', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const reference = await store.put({ sessionId: 'session-a', content: 'to be released' })
    expect(await store.release({ sessionId: 'session-a', refId: reference.refId })).toBe(true)
    expect(await store.release({ sessionId: 'session-a', refId: reference.refId })).toBe(false)
    expect((await storeError(store.page({ sessionId: 'session-a', refId: reference.refId }))).code).toBe(
      'RESULT_NOT_FOUND',
    )
  })

  it('过期后 page 报 RESULT_EXPIRED，而已经进入历史的 preview 逐字不变', async () => {
    let clock = Date.now()
    const store = new FileResultReferenceStore({
      rootDir: await makeRoot(),
      ttlMs: 1_000,
      now: () => clock,
    })
    const content = shellFailureLog()
    const projected = await projectToolResult({
      toolName: 'bash',
      sessionId: 'session-a',
      content,
      budget: PREVIEW_BUDGET,
      store,
    })
    expect(projected.changed).toBe(true)
    expect(projected.refId).toBeDefined()
    const frozen = JSON.stringify(projected)

    // 文件 mtime 一定不早于 clock 初值，所以必须跨过 TTL 并且留足余量。
    clock += 60_000
    expect((await storeError(store.page({ sessionId: 'session-a', refId: projected.refId! }))).code).toBe(
      'RESULT_EXPIRED',
    )
    // 存储过期不回头改历史：preview 与 refId 都是常量。
    expect(JSON.stringify(projected)).toBe(frozen)
    expect(projected.preview).toContain(projected.refId!)
  })
})

describe('FileResultReferenceStore 字节安全分页', () => {
  it('多字节内容逐页取回，拼起来等于原文，任何一页都不切坏字符', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = ['中文标题🙂', '🙂'.repeat(30), '尾部行\n'.repeat(20)].join('\n')
    const reference = await store.put({ sessionId: 'session-a', content })
    const decoder = new TextDecoder('utf-8', { fatal: true })

    let offset = 0
    let assembled = ''
    let pages = 0
    for (;;) {
      const page = await store.page({
        sessionId: 'session-a',
        refId: reference.refId,
        offset,
        limit: 3,
        maxBytes: 9,
      })
      expect(page.mode).toBe('text')
      // fatal 解码器会在半个字符上抛错，这比 "猜有没有替换字符" 更硬。
      expect(decoder.decode(Buffer.from(page.content, 'utf8'))).toBe(page.content)
      expect(page.content).not.toContain('\uFFFD')
      assembled += page.content
      pages += 1
      expect(pages).toBeLessThan(400)
      if (page.complete) {
        expect(page.nextOffset).toBeNull()
        expect(page.omitted.reason).toBe('none')
        expect(page.omitted.chars).toBe(0)
        break
      }
      expect(page.nextOffset).toBeGreaterThan(offset)
      expect(page.omitted.chars).toBeGreaterThan(0)
      offset = page.nextOffset!
    }
    expect(assembled).toBe(content)
  })

  it('offset 必须落在字符边界上，越界给出明确错误', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = '中文内容'
    const reference = await store.put({ sessionId: 'session-a', content })
    const totalBytes = Buffer.byteLength(content, 'utf8')

    expect((await storeError(store.page({ sessionId: 'session-a', refId: reference.refId, offset: 1 }))).code).toBe(
      'OFFSET_INVALID',
    )
    expect(
      (await storeError(store.page({ sessionId: 'session-a', refId: reference.refId, offset: totalBytes + 1 }))).code,
    ).toBe('OFFSET_OUT_OF_RANGE')
    // 正好等于总字节数：空页且 complete。
    const end = await store.page({ sessionId: 'session-a', refId: reference.refId, offset: totalBytes })
    expect(end.content).toBe('')
    expect(end.complete).toBe(true)
  })

  it('maxBytes 小于一个字符时也整字符返回，不切坏', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const reference = await store.put({ sessionId: 'session-a', content: '中文内容' })
    const page = await store.page({ sessionId: 'session-a', refId: reference.refId, limit: 1, maxBytes: 1 })
    expect(page.content).toBe('中')
    expect(page.complete).toBe(false)
    expect(page.omitted.reason).toBe('bytes')
  })

  it('limit 默认 64、上限 512，maxBytes 默认 16384、上限 65536', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const reference = await store.put({ sessionId: 'session-a', content: 'line\n'.repeat(10) })
    const defaults = await store.page({ sessionId: 'session-a', refId: reference.refId })
    expect(defaults.limit).toBe(64)
    expect(defaults.maxBytes).toBe(16_384)
    const capped = await store.page({
      sessionId: 'session-a',
      refId: reference.refId,
      limit: 10_000,
      maxBytes: 10_000_000,
    })
    expect(capped.limit).toBe(512)
    expect(capped.maxBytes).toBe(65_536)
  })

  it('单行 minified JSON（仅含转义 \\n，无真实换行）：按逻辑转义换行受 limit 行数约束，且拼合后与原文逐字相等', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    // 构造含字面量 \\n（双反斜杠+n，不应断行）与真转义 \n（单反斜杠+n，应断行）的单行 JSON
    const lines = Array.from({ length: 10 }, (_, idx) => `line-${idx} literal-escaped-\\\\n-stay`)
    const minifiedJson = JSON.stringify({ exitCode: 1, stdout: lines.join('\n') })
    expect(minifiedJson.includes('\n')).toBe(false)
    expect(minifiedJson.includes('\\n')).toBe(true)

    const reference = await store.put({ sessionId: 'session-a', content: minifiedJson })
    const p1 = await store.page({ sessionId: 'session-a', refId: reference.refId, limit: 4 })
    expect(p1.complete).toBe(false)
    expect(p1.omitted.reason).toBe('lines')
    expect(p1.omitted.lines).toBe(6)

    const p2 = await store.page({ sessionId: 'session-a', refId: reference.refId, offset: p1.nextOffset!, limit: 4 })
    expect(p2.complete).toBe(false)
    expect(p2.omitted.lines).toBe(2)

    const p3 = await store.page({ sessionId: 'session-a', refId: reference.refId, offset: p2.nextOffset!, limit: 4 })
    expect(p3.complete).toBe(true)
    expect(p3.nextOffset).toBeNull()
    expect(p1.content + p2.content + p3.content).toBe(minifiedJson)
  })
})

describe('FileResultReferenceStore 结构化分页', () => {
  /** 五行 JSON Lines，三行 level=error。 */
  const rows = [
    { id: 1, level: 'error', message: 'boom one' },
    { id: 2, level: 'warn', message: 'careful' },
    { id: 3, level: 'error', message: 'boom two' },
    { id: 4, level: 'info', message: 'fine' },
    { id: 5, level: 'error', message: 'boom three' },
  ]
  const content = rows.map((row) => JSON.stringify(row)).join('\n')

  it('fields + equals 过滤，分页信息显式（complete/nextOffset/omitted）', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const reference = await store.put({ sessionId: 'session-a', content })

    const first = await store.page({
      sessionId: 'session-a',
      refId: reference.refId,
      fields: ['level'],
      equals: { level: 'error' },
      limit: 2,
    })
    expect(first.mode).toBe('structured')
    expect(first.fields).toEqual(['level'])
    expect(first.totalRows).toBe(5)
    expect(first.matchedRows).toBe(3)
    expect(first.complete).toBe(false)
    expect(first.nextOffset).toBe(2)
    expect(first.omitted.reason).toBe('rows')
    expect(first.omitted.rows).toBe(1)
    expect(first.content.split('\n').map((line) => JSON.parse(line))).toEqual([
      { level: 'error' },
      { level: 'error' },
    ])

    const second = await store.page({
      sessionId: 'session-a',
      refId: reference.refId,
      fields: ['level'],
      equals: { level: 'error' },
      offset: 2,
      limit: 2,
    })
    expect(second.complete).toBe(true)
    expect(second.nextOffset).toBeNull()
    expect(second.content.split('\n').map((line) => JSON.parse(line))).toEqual([{ level: 'error' }])
  })

  it('未知字段与不可解析内容都明确报错，而不是悄悄退回文本分页', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const structured = await store.put({ sessionId: 'session-a', content })
    expect(
      (await storeError(store.page({ sessionId: 'session-a', refId: structured.refId, fields: ['nope'] }))).code,
    ).toBe('FIELD_UNKNOWN')
    expect(
      (await storeError(store.page({ sessionId: 'session-a', refId: structured.refId, equals: { nope: 'x' } }))).code,
    ).toBe('FIELD_UNKNOWN')

    const prose = await store.put({
      sessionId: 'session-a',
      content: '这是一段普通说明。\n没有任何表格结构。\n也没有 JSON。',
    })
    expect(
      (await storeError(store.page({ sessionId: 'session-a', refId: prose.refId, fields: ['level'] }))).code,
    ).toBe('NOT_STRUCTURED')
  })

  it('结构化行 offset 越界给出明确错误', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const reference = await store.put({ sessionId: 'session-a', content })
    // 用 fields 进入结构化模式：offset 此时是（过滤后的）行下标，而不是字节偏移。
    expect(
      (await storeError(store.page({ sessionId: 'session-a', refId: reference.refId, offset: 99, fields: ['id'] }))).code,
    ).toBe('OFFSET_OUT_OF_RANGE')
  })
})

describe('FileResultReferenceStore 零参构造', () => {
  it('不传任何选项也能构造，根目录落在 <DSH_HOME>/storages/cache-warmup', async () => {
    const store = new FileResultReferenceStore()
    const home = process.env.DSH_HOME
    expect(home).toBeTruthy()
    expect(store.rootDir()).toBe(path.join(home!, 'storages', 'cache-warmup'))
  })
})
