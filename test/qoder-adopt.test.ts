/**
 * Qoder adopt 的测试：只读导入本机 qodercli 登录态。
 *
 * 加密格式由 frozen fixture 驱动（credential.json：AES-128-CBC，key=IV=machine_id
 * 前 16 字符）；区域探测用 mock fetch（规则 4：区域不猜，是探出来的）。
 * 测试文件自己造一份加密的夹具目录，不碰任何真实 profile。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  adoptQoderSignIn,
  parseQoderAdoptedUserInfo,
  qoderAdoptPresence,
} from '../src/host/qoder/adopt.ts'
import { decryptQoderAdoptPayload } from '../src/host/qoder/cosy.ts'

/** 造一份 qodercli 形态的夹具目录（.qoder/.auth/{machine_id,user}，user 按官方格式加密）。 */
function makeCliFixtureFs(userInfo: Record<string, unknown> | string): { env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-fixture-'))
  const authDir = path.join(dir, '.qoder', '.auth')
  mkdirSync(authDir, { recursive: true })
  const machineId = '00000000-1111-4222-8333-444444444444'
  writeFileSync(path.join(authDir, 'machine_id'), machineId + '\n', 'utf8')
  const plain = typeof userInfo === 'string' ? userInfo : JSON.stringify(userInfo)
  // 与官方同一个格式（frozen fixture credential.json）：key=IV=machine_id 前 16 字符的
  // raw UTF-8 字节，AES-128-CBC，PKCS#7，strict padded Base64 信封。
  const keyBytes = Buffer.from(machineId.slice(0, 16), 'utf8')
  const cipher = createCipheriv('aes-128-cbc', keyBytes, keyBytes)
  writeFileSync(path.join(authDir, 'user'), Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64'), 'utf8')
  return { env: { HOME: dir, USERPROFILE: '' } as unknown as NodeJS.ProcessEnv }
}

describe('adopt：存在性与解密', () => {
  it('presence 只 stat 不 open：没有文件时 false，有文件时 true', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-empty-'))
    expect(await qoderAdoptPresence({ HOME: empty, USERPROFILE: '' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    const { env } = makeCliFixtureFs({ uid: 'u-1', access_token: 'tok-1' })
    expect(await qoderAdoptPresence(env)).toBe(true)
  })

  it('加密的 user 文件能解密回明文 JSON（与 frozen fixture 同一算法）', async () => {
    const { env } = makeCliFixtureFs({ uid: 'u-1', access_token: 'tok-1', organization_tags: ['a'] })
    const machineId = (await readFile(path.join(String(env.HOME), '.qoder', '.auth', 'machine_id'), 'utf8')).trim()
    const content = await readFile(path.join(String(env.HOME), '.qoder', '.auth', 'user'), 'utf8')
    const plain = decryptQoderAdoptPayload(content, machineId)
    expect(JSON.parse(plain)).toMatchObject({ uid: 'u-1', access_token: 'tok-1' })
  })
})

describe('parseQoderAdoptedUserInfo（纯函数）', () => {
  it('字段逐个读出；缺省字段走兜底', () => {
    const result = parseQoderAdoptedUserInfo({
      uid: 'u-1',
      access_token: 'tok-1',
      refresh_token: 'rt-1',
      name: 'Me',
      email: 'me@qoder.com',
      organization_id: 'org-1',
      organization_tags: ['a', 'b'],
      data_policy_agreed: true,
      expire_time: 1_900_000_000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.material).toMatchObject({
        accessToken: 'tok-1',
        refreshToken: 'rt-1',
        uid: 'u-1',
        accountName: 'Me',
        email: 'me@qoder.com',
        organizationId: 'org-1',
        organizationTags: ['a', 'b'],
        dataPolicyAgreed: true,
      })
    }
  })

  it('security_oauth_token 兜底为 access_token；两者都没有 = not-a-qoder-login', () => {
    const fallback = parseQoderAdoptedUserInfo({ uid: 'u-1', security_oauth_token: 'sot-1' })
    expect(fallback.ok).toBe(true)
    if (fallback.ok) expect(fallback.material.accessToken).toBe('sot-1')
    expect(parseQoderAdoptedUserInfo({ uid: 'u-1' })).toEqual({ ok: false, reason: 'not-a-qoder-login' })
    expect(parseQoderAdoptedUserInfo('nope')).toEqual({ ok: false, reason: 'invalid-credentials' })
  })
})

describe('adoptQoderSignIn（区域探测）', () => {
  it('全球区 userinfo 认账 → 区域是 global，凭据带 adopt 判别式', async () => {
    const { env } = makeCliFixtureFs({ uid: 'u-1', access_token: 'tok-1', refresh_token: 'rt-1', name: 'Me' })
    const fetchFn = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('openapi.qoder.sh')
      return Response.json({ id: 'u-1', email: 'me@qoder.com', name: 'Me' })
    }) as unknown as typeof fetch
    const outcome = await adoptQoderSignIn({ env, fetchFn })
    expect(outcome.result).toMatchObject({ attempted: true, adopted: true, region: 'global' })
    expect(outcome.adopted?.credentials).toMatchObject({
      accessToken: 'tok-1',
      region: 'global',
      origin: 'adopt',
      adopted: true,
      uid: 'u-1',
      email: 'me@qoder.com',
    })
  })

  it('全球区不认、中国站认 → 区域是 cn（探测顺序 global → cn）', async () => {
    const { env } = makeCliFixtureFs({ uid: 'u-2', access_token: 'tok-2' })
    const seen: string[] = []
    const fetchFn = (async (url: RequestInfo | URL) => {
      seen.push(String(url))
      if (String(url).includes('qoder.com.cn')) return Response.json({ id: 'u-2', name: 'CN' })
      return Response.json({ message: 'nope' }, { status: 401 })
    }) as unknown as typeof fetch
    const outcome = await adoptQoderSignIn({ env, fetchFn })
    expect(outcome.result).toMatchObject({ adopted: true, region: 'cn' })
    expect(seen[0]).toContain('openapi.qoder.sh')
    expect(seen[1]).toContain('openapi.qoder.com.cn')
  })

  it('两区都不认 → region-unresolved（不替用户猜一个必然 401 的区域）', async () => {
    const { env } = makeCliFixtureFs({ uid: 'u-3', access_token: 'tok-dead' })
    const fetchFn = (async () => Response.json({}, { status: 401 })) as unknown as typeof fetch
    const outcome = await adoptQoderSignIn({ env, fetchFn })
    expect(outcome.result).toMatchObject({ attempted: true, adopted: false, reason: 'region-unresolved' })
    expect(outcome.adopted).toBeUndefined()
  })

  it('没有文件 → attempted:false, no-credentials-file；读坏了 → invalid-credentials', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-none-'))
    const absent = await adoptQoderSignIn({ env: { HOME: empty, USERPROFILE: '' } as unknown as NodeJS.ProcessEnv })
    expect(absent.result).toMatchObject({ attempted: false, adopted: false, reason: 'no-credentials-file' })

    const broken = mkdtempSync(path.join(os.tmpdir(), 'qoder-cli-broken-'))
    const authDir = path.join(broken, '.qoder', '.auth')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(path.join(authDir, 'machine_id'), '00000000-1111-4222-8333-444444444444\n', 'utf8')
    writeFileSync(path.join(authDir, 'user'), 'not-valid-base64!!!', 'utf8')
    const outcome = await adoptQoderSignIn({ env: { HOME: broken, USERPROFILE: '' } as unknown as NodeJS.ProcessEnv })
    expect(outcome.result).toMatchObject({ attempted: true, adopted: false, reason: 'invalid-credentials' })
  })
})
