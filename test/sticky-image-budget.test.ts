import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StickyImageBudgetStore } from '../src/host/common/sticky-image-budget.ts'

describe('StickyImageBudgetStore', () => {
  it('persists dropped identities across store instances', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sticky-images-'))
    const file = path.join(root, 'cache.json')
    const store = new StickyImageBudgetStore('claude', file)
    store.record('session', new Set(['image-a', 'image-b']))
    store.flush()

    const restored = new StickyImageBudgetStore('claude', file)
    expect([...restored.priorDroppedKeys('session')].sort()).toEqual(['image-a', 'image-b'])
  })

  it('does not share an unnamed request bucket', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sticky-images-'))
    const store = new StickyImageBudgetStore('minimax-code', path.join(root, 'cache.json'))
    store.record(undefined, new Set(['image-a']))
    store.record('', new Set(['image-b']))
    store.flush()
    expect(store.priorDroppedKeys(undefined).size).toBe(0)
    expect(store.priorDroppedKeys('').size).toBe(0)
  })

  it('fails closed on malformed durable state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sticky-images-'))
    const file = path.join(root, 'cache.json')
    await fs.writeFile(file, '{broken', 'utf8')
    const store = new StickyImageBudgetStore('claude', file)
    expect(store.priorDroppedKeys('session').size).toBe(0)
  })
})
