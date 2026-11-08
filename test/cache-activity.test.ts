import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PromptCacheActivityStore } from '../src/host/common/cache-activity.ts'

describe('PromptCacheActivityStore', () => {
  it('restores the last activity and prompt size across instances', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cache-activity-'))
    const file = path.join(root, 'activity.json')
    const store = new PromptCacheActivityStore('step-code', file)
    store.record('session', 2_048, 1_000)
    store.flush()
    expect(new PromptCacheActivityStore('step-code', file).read('session')).toEqual({
      lastActiveAt: 1_000,
      totalTokens: 2_048,
    })
  })

  it('does not create an unnamed shared bucket', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cache-activity-'))
    const store = new PromptCacheActivityStore('step-code', path.join(root, 'activity.json'))
    store.record(undefined, 100)
    store.record('', 100)
    expect(store.read(undefined)).toBeUndefined()
  })
})
