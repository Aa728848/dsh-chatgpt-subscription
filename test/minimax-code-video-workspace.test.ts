// @vitest-environment jsdom
/**
 * Tests for the workspace directory lister behind the media blocks' `@` completion.
 *
 * The panel cannot read the filesystem: the only way it can offer real candidates is
 * `remote.workspaceFiles.list`. These cases pin the two properties that matter —
 * it resolves the remote the way the rest of this plugin does, and it degrades to an
 * empty list instead of throwing, because it runs on every keystroke.
 */
import { describe, expect, it, vi } from 'vitest'
import { joinWorkspacePath, workspaceListerFor } from '../src/client/minimax-code/video-workspace.ts'

/** A context whose `get` answers the two service names this module probes. */
function contextWith(services: Record<string, unknown>): never {
  return {
    get: (name: string) => services[name],
  } as never
}

describe('workspaceListerFor', () => {
  it('lists a directory through remote.workspaceFiles.list', async () => {
    const list = vi.fn(async (_sessionId: string, path: string) => ({
      ok: true as const,
      value: {
        path,
        entries: [
          { name: 'docs', type: 'directory' },
          { name: 'a.png', type: 'file' },
        ],
        truncated: false,
      },
    }))
    const lister = workspaceListerFor(contextWith({ 'remote.workspaceFiles': { list } }), 's1')
    expect(lister).toBeDefined()
    const entries = await lister!('')
    // Children of the workspace root carry their own name as the path.
    expect(entries).toEqual([
      { name: 'docs', path: 'docs', directory: true },
      { name: 'a.png', path: 'a.png', directory: false },
    ])
    expect(list).toHaveBeenCalledWith('s1', '')

    // A subdirectory prefixes every child with the listed path.
    expect((await lister!('docs'))[0].path).toBe('docs/docs')
  })

  it('answers an empty list instead of throwing when the remote fails', async () => {
    const failing = workspaceListerFor(contextWith({
      'remote.workspaceFiles': { list: async () => ({ ok: false as const, error: { code: 'x' } }) },
    }), 's1')
    expect(await failing!('')).toEqual([])

    const throwing = workspaceListerFor(contextWith({
      'remote.workspaceFiles': {
        list: () => { throw new Error('no host') },
      },
    }), 's1')
    expect(await throwing!('')).toEqual([])
  })

  it('is undefined when the host has no workspace reader', () => {
    expect(workspaceListerFor(contextWith({}), 's1')).toBeUndefined()
    // A context without even `get` (a bare test double) must not throw.
    expect(workspaceListerFor({} as never, 's1')).toBeUndefined()
  })

  it('joins a workspace child path, root included', () => {
    expect(joinWorkspacePath('', 'a.png')).toBe('a.png')
    expect(joinWorkspacePath('docs', 'a.png')).toBe('docs/a.png')
  })
})
