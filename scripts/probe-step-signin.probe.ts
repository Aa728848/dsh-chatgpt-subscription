/**
 * 一次性探针：用真实账号跑一遍 signInOasisQuotaCredential，验证密码换 token 是否真的通了。
 * 只打印结构（长度/字段名/套餐），绝不打印任何 token。
 */
import { test, expect } from 'vitest'
import { signInOasisQuotaCredential, readStepQuota } from '../src/host/step-code/client.ts'

test('password -> Oasis token -> quota read', async () => {
  const account = process.env.STEP_USER ?? ''
  const password = process.env.STEP_PW ?? ''
  expect(account).not.toBe('')
  const cred = await signInOasisQuotaCredential({ profile: 'step_plan', account, password })
  console.log('[probe] token length =', cred.token.length, '| has pair =', cred.token.includes('...'), '| webid len =', cred.deviceId.length)
  console.log('[probe] source =', cred.source, '| expiresAt =', cred.expiresAt === null ? 'null' : 'set')
  const quota = await readStepQuota(cred, 'step_plan')
  console.log('[probe] quota ok =', quota.ok)
  if (quota.ok) {
    console.log('[probe] kind =', quota.snapshot.kind, '| plan =', quota.snapshot.planName, '| family =', quota.snapshot.planFamily)
    console.log('[probe] windows =', quota.snapshot.windows.length, '| buckets =', quota.snapshot.creditBuckets.length)
    console.log('[probe] sources =', quota.snapshot.sources.join(', '))
  } else {
    console.log('[probe] error =', quota.error)
  }
  expect(quota.ok).toBe(true)
})