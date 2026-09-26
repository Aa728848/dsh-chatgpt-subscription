/**
 * Tests for OPT-IN adoption of a pre-existing Claude Code sign-in.
 *
 * WHAT THIS FILE PROVES.
 *
 * 1. THE TRAP. The credential document carries OTHER access tokens besides the
 *    subscription one — notably mcpOAuth.*.accessToken for MCP servers — and a
 *    fixture holding BOTH must come back with the claudeAiOauth token. A document
 *    holding ONLY mcpOAuth must come back as undefined. Both orderings are
 *    covered, because a lazy tree walk would answer correctly for one of them by
 *    luck and wrongly for the other.
 * 2. Presence is content-free. claudeCodeCredentialPresence() answers yes/no
 *    without reading any file: readFile is a spy here and is asserted NOT to have
 *    been called. A second test makes the same point observably, with a fixture
 *    that is not even JSON but is still reported present.
 * 3. The reader never writes. The credential file's bytes, size and mtime are
 *    identical before and after both entry points run, the directory gains no
 *    entry, and a source-level guard asserts the module imports exactly
 *    readFile and stat from node:fs/promises and contains no write API at all.
 * 4. An unrecognised shape yields undefined and NEVER throws: wrong types, a
 *    missing token, a blank token, a non-JSON file, a directory in the file's
 *    place, an empty file, and a file that does not exist.
 * 5. Expiry is validated rather than assumed. A missing, non-finite, null or
 *    string expiresAt is stamped with the expired sentinel and reported expired,
 *    while a real expiry is honoured against an injected clock.
 * 6. The adopted marker exists and is not confused with a plugin-owned account.
 *
 * WHAT THIS FILE DOES NOT PROVE, and must not be read as proving. This machine
 * has NO Claude Code installation and NO credential file: every path this module
 * looks at was checked and is absent. Every fixture below is one this test wrote,
 * so these tests establish that the parser and the reader behave as designed
 * against a document shape assembled from secondary sources — NOT that a real
 * Claude Code writes that shape. A layout difference would show up here as
 * undefined (see 4), which is the intended failure mode, not a silent misread.
 *
 * This file mocks node:fs/promises, and only for the two call-through spies in 2.
 * Every test still reads and writes real temporary files through the delegated
 * originals, so the fixtures are ordinary files on disk rather than in-memory
 * fakes.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(actual.stat),
  }
})

const fs = await import('node:fs/promises')
const readFileSpy = vi.mocked(fs.readFile)

import {
  ADOPTED_CREDENTIAL_EXPIRED_HINT,
  CLAUDE_CODE_CREDENTIAL_FILE,
  CLAUDE_CODE_CREDENTIAL_KEY,
  CLAUDE_CONFIG_DIR_ENV,
  UNKNOWN_CREDENTIAL_EXPIRY,
  claudeCodeCredentialPaths,
  claudeCodeCredentialPresence,
  claudeConfigDir,
  isAdoptedClaudeCredential,
  isAdoptedCredentialExpired,
  parseAdoptedClaudeCredential,
  readClaudeCodeCredentials,
  type ClaudeCodeAdoptedCredential,
} from '../src/host/claude/adopt.ts'

/** Access token of the subscription sign-in, the one adoption must return. */
const CLAUDE_ACCESS_TOKEN = 'claude-oauth-access-token'
/** Access token of an MCP server sign-in in the same file. Never this one. */
const MCP_ACCESS_TOKEN = 'mcp-server-access-token'
/** A far-future expiry, so a mapping bug cannot be mistaken for an expiry bug. */
const FUTURE_EXPIRY = 4_102_444_800_000

const directories: string[] = []
const savedConfigDir = process.env[CLAUDE_CONFIG_DIR_ENV]

beforeEach(() => {
  // The variable decides which directory the module consults, so a test that sets
  // it must not leak into the next one — and, more importantly, the developer's
  // own CLAUDE_CONFIG_DIR must not decide what these tests see.
  delete process.env[CLAUDE_CONFIG_DIR_ENV]
  readFileSpy.mockClear()
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env[CLAUDE_CONFIG_DIR_ENV]
  else process.env[CLAUDE_CONFIG_DIR_ENV] = savedConfigDir
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** A private directory that is removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/** Write one fixture file and answer its path. */
async function writeFixture(contents: string, name = CLAUDE_CODE_CREDENTIAL_FILE): Promise<string> {
  const directory = await tempDir('dsh-claude-adopt-')
  const file = join(directory, name)
  await writeFile(file, contents, 'utf8')
  return file
}

/**
 * A credential document of the shape a Claude Code client is reported to write,
 * carrying BOTH access tokens, with the MCP block first.
 *
 * The MCP block is deliberately placed FIRST: JSON object order is preserved by
 * JSON.parse, so a "first accessToken found" scan would answer with the MCP token
 * on this fixture. That is what makes the assertion below meaningful rather than
 * incidental.
 */
function documentWithBothTokens(): string {
  return JSON.stringify({
    mcpOAuth: {
      'server-one': {
        accessToken: MCP_ACCESS_TOKEN,
        refreshToken: 'mcp-refresh-token',
        expiresAt: FUTURE_EXPIRY,
        scopes: ['mcp'],
      },
    },
    [CLAUDE_CODE_CREDENTIAL_KEY]: {
      accessToken: CLAUDE_ACCESS_TOKEN,
      refreshToken: 'claude-refresh-token',
      expiresAt: FUTURE_EXPIRY,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
    // Unknown extra fields must be tolerated, not rejected: a future client that
    // adds one must not break adoption.
    someFutureField: { nested: [1, 2, 3] },
  })
}

/** The same document with the subscription sign-in written first. */
function documentWithBothTokensReversed(): string {
  return JSON.stringify({
    [CLAUDE_CODE_CREDENTIAL_KEY]: {
      accessToken: CLAUDE_ACCESS_TOKEN,
      refreshToken: 'claude-refresh-token',
      expiresAt: FUTURE_EXPIRY,
      scopes: ['user:inference'],
    },
    mcpOAuth: { 'server-one': { accessToken: MCP_ACCESS_TOKEN, refreshToken: 'mcp-refresh-token' } },
  })
}

/** A document whose only access token is an MCP server's. */
function documentWithOnlyMcp(): string {
  return JSON.stringify({
    mcpOAuth: {
      'server-one': { accessToken: MCP_ACCESS_TOKEN, refreshToken: 'mcp-refresh-token', expiresAt: FUTURE_EXPIRY },
    },
  })
}

describe('the MCP access token is never adopted', () => {
  it('returns the claudeAiOauth token from a document that also holds an MCP token', async () => {
    const file = await writeFixture(documentWithBothTokens())
    const adopted = await readClaudeCodeCredentials([file])

    expect(adopted).toBeDefined()
    expect(adopted?.credentials.accessToken).toBe(CLAUDE_ACCESS_TOKEN)
    expect(adopted?.credentials.accessToken).not.toBe(MCP_ACCESS_TOKEN)
    // The rest of the record is mapped from the SAME nested object, so a reader
    // that mixed the two blocks would be caught here as well.
    expect(adopted?.credentials.refreshToken).toBe('claude-refresh-token')
    expect(adopted?.credentials.expiresAt).toBe(FUTURE_EXPIRY)
    expect(adopted?.credentials.scopes).toEqual(['user:inference', 'user:profile'])
    expect(adopted?.credentials.subscriptionType).toBe('max')
    expect(adopted?.sourcePath).toBe(file)
    expect(adopted?.source).toBe('claude-code')
    expect(adopted?.adopted).toBe(true)
  })

  it('returns the claudeAiOauth token when the two blocks are written in the other order', async () => {
    const file = await writeFixture(documentWithBothTokensReversed())
    const adopted = await readClaudeCodeCredentials([file])

    expect(adopted?.credentials.accessToken).toBe(CLAUDE_ACCESS_TOKEN)
  })

  it('yields undefined for a document whose only access token is an MCP token', async () => {
    const file = await writeFixture(documentWithOnlyMcp())
    const adopted = await readClaudeCodeCredentials([file])

    expect(adopted).toBeUndefined()
  })

  it('yields undefined when claudeAiOauth is absent, not an object, or shaped differently', () => {
    const sourcePath = 'C:\\fixtures\\.credentials.json'
    const onlyMcp = JSON.parse(documentWithOnlyMcp()) as unknown
    const cases: unknown[] = [
      onlyMcp,
      { [CLAUDE_CODE_CREDENTIAL_KEY]: null },
      { [CLAUDE_CODE_CREDENTIAL_KEY]: [] },
      { [CLAUDE_CODE_CREDENTIAL_KEY]: 'accessToken' },
      { [CLAUDE_CODE_CREDENTIAL_KEY]: {} },
      // An access token with no refresh token is NOT adopted: the store's record is
      // a sign-in, and its identity aliases come from the refresh token.
      { [CLAUDE_CODE_CREDENTIAL_KEY]: { accessToken: CLAUDE_ACCESS_TOKEN } },
      { [CLAUDE_CODE_CREDENTIAL_KEY]: { refreshToken: 'claude-refresh-token' } },
      { [CLAUDE_CODE_CREDENTIAL_KEY]: { accessToken: '   ', refreshToken: 'claude-refresh-token' } },
      // The MCP token must not be promoted into a missing claudeAiOauth either.
      { [CLAUDE_CODE_CREDENTIAL_KEY]: { refreshToken: 'claude-refresh-token' }, mcpOAuth: { a: { accessToken: MCP_ACCESS_TOKEN } } },
    ]
    for (const value of cases) {
      expect(parseAdoptedClaudeCredential(value, sourcePath), JSON.stringify(value)).toBeUndefined()
    }
  })
})

describe('presence is a separate, content-free check', () => {
  it('reports the file it found, lists every candidate, and reads no content', async () => {
    const file = await writeFixture(documentWithBothTokens())
    const absent = join(await tempDir('dsh-claude-adopt-empty-'), CLAUDE_CODE_CREDENTIAL_FILE)

    const presence = await claudeCodeCredentialPresence([absent, file])

    expect(presence.present).toBe(true)
    expect(presence.path).toBe(file)
    // Every candidate is reported whether or not it existed, so the card can print
    // exactly where it looked.
    expect(presence.searched).toEqual([absent, file])
    // THE POINT OF THE SPLIT: the startup check never opens a candidate for
    // reading, so a user who does not opt in never has their token read.
    expect(readFileSpy).not.toHaveBeenCalled()

    // ...and the spy is LIVE, which is what makes the assertion above evidence
    // rather than a no-op: the opted-in read does go through it.
    await readClaudeCodeCredentials([file])
    expect(readFileSpy).toHaveBeenCalled()
  })

  it('reports nothing found without reading anything', async () => {
    const directory = await tempDir('dsh-claude-adopt-empty-')
    const absent = join(directory, CLAUDE_CODE_CREDENTIAL_FILE)

    const presence = await claudeCodeCredentialPresence([absent])

    expect(presence.present).toBe(false)
    expect(presence.path).toBeNull()
    expect(presence.searched).toEqual([absent])
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('reports a present file whose content is not JSON at all', async () => {
    // Belt and braces for the spy above: the answer cannot depend on the content,
    // because here the content cannot even be parsed and the answer is still yes.
    const file = await writeFixture('this is not json {{{')
    const presence = await claudeCodeCredentialPresence([file])

    expect(presence.present).toBe(true)
    expect(presence.path).toBe(file)
  })
})

describe('candidate paths and precedence', () => {
  it('puts the CLAUDE_CONFIG_DIR home first and the conventional home second', () => {
    const configured = join('C:', 'profiles', 'work')
    process.env[CLAUDE_CONFIG_DIR_ENV] = configured

    expect(claudeConfigDir()).toBe(configured)
    const paths = claudeCodeCredentialPaths()
    expect(paths[0]).toBe(join(configured, CLAUDE_CODE_CREDENTIAL_FILE))
    expect(paths).toHaveLength(2)
    expect(paths[1].endsWith(join('.claude', CLAUDE_CODE_CREDENTIAL_FILE))).toBe(true)
  })

  it('falls back to the conventional home when the variable is unset or blank', () => {
    delete process.env[CLAUDE_CONFIG_DIR_ENV]
    const fromHome = claudeConfigDir()
    process.env[CLAUDE_CONFIG_DIR_ENV] = '   '
    expect(claudeConfigDir()).toBe(fromHome)
    // A blank variable is not "the directory with an empty name": that would
    // resolve to a drive-relative path on Windows. The conventional path is then
    // the only candidate, and the duplicate suppression keeps it listed once.
    expect(claudeCodeCredentialPaths()).toEqual([join(fromHome, CLAUDE_CODE_CREDENTIAL_FILE)])
  })

  it('does not list the conventional path twice when it is also the configured one', () => {
    process.env[CLAUDE_CONFIG_DIR_ENV] = join(homedir(), '.claude')
    const paths = claudeCodeCredentialPaths()
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe(join(homedir(), '.claude', CLAUDE_CODE_CREDENTIAL_FILE))
  })

  it('is read at call time, so a directory set after import is honoured', async () => {
    const directory = await tempDir('dsh-claude-config-')
    const file = join(directory, CLAUDE_CODE_CREDENTIAL_FILE)
    await writeFile(file, documentWithBothTokens(), 'utf8')
    process.env[CLAUDE_CONFIG_DIR_ENV] = directory

    const adopted = await readClaudeCodeCredentials()
    expect(adopted?.sourcePath).toBe(file)
  })

  it('uses the first candidate that parses, and reports which file that was', async () => {
    const broken = await writeFixture('not json')
    const good = await writeFixture(documentWithBothTokens())

    const adopted = await readClaudeCodeCredentials([broken, good])

    expect(adopted?.credentials.accessToken).toBe(CLAUDE_ACCESS_TOKEN)
    // The source path is the only way a fallback stays visible to the user.
    expect(adopted?.sourcePath).toBe(good)
  })
})

describe('unrecognised input never throws', () => {
  it('answers undefined for every shape it does not recognise', () => {
    const sourcePath = 'C:\\fixtures\\.credentials.json'
    const cases: unknown[] = [null, undefined, 42, 'claudeAiOauth', [], {}, { claudeAiOauth: undefined }]
    for (const value of cases) {
      expect(parseAdoptedClaudeCredential(value, sourcePath), JSON.stringify(value) ?? 'undefined').toBeUndefined()
    }
  })

  it('answers undefined instead of throwing for files it cannot use', async () => {
    const directory = await tempDir('dsh-claude-adopt-bad-')
    const missing = join(directory, 'nope.json')
    const notJson = await writeFixture('}{ not json')
    const empty = await writeFixture('')
    const asDirectory = join(await tempDir('dsh-claude-adopt-dir-'), CLAUDE_CODE_CREDENTIAL_FILE)
    await mkdir(asDirectory)

    expect(await readClaudeCodeCredentials([missing])).toBeUndefined()
    expect(await readClaudeCodeCredentials([notJson])).toBeUndefined()
    expect(await readClaudeCodeCredentials([empty])).toBeUndefined()
    expect(await readClaudeCodeCredentials([asDirectory])).toBeUndefined()
    // An absent file is also a "no" from the presence check, not a throw.
    expect((await claudeCodeCredentialPresence([missing])).present).toBe(false)
    expect((await claudeCodeCredentialPresence([asDirectory])).present).toBe(false)
  })
})

describe('expiry is validated, never assumed', () => {
  function adoptedFrom(claudeAiOauth: Record<string, unknown>): ClaudeCodeAdoptedCredential | undefined {
    return parseAdoptedClaudeCredential(
      { [CLAUDE_CODE_CREDENTIAL_KEY]: { accessToken: CLAUDE_ACCESS_TOKEN, refreshToken: 'r', ...claudeAiOauth } },
      'C:\\fixtures\\.credentials.json',
    )
  }

  it('stamps an unusable expiry with the expired sentinel rather than never-expiring', () => {
    const badExpiries: unknown[] = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '4102444800000', {}, []]
    for (const expiresAt of badExpiries) {
      const adopted = adoptedFrom({ expiresAt })
      expect(adopted?.credentials.expiresAt, String(expiresAt)).toBe(UNKNOWN_CREDENTIAL_EXPIRY)
      // The safe direction: a credential nothing vouched for reads as expired.
      expect(adopted === undefined ? true : isAdoptedCredentialExpired(adopted)).toBe(true)
    }
  })

  it('honours a real expiry against an injected clock, and treats the instant itself as expired', () => {
    const adopted = adoptedFrom({ expiresAt: 1_000 })
    expect(adopted).toBeDefined()
    if (adopted === undefined) return
    expect(isAdoptedCredentialExpired(adopted, 999)).toBe(false)
    expect(isAdoptedCredentialExpired(adopted, 1_000)).toBe(true)
    expect(isAdoptedCredentialExpired(adopted, 1_001)).toBe(true)
  })

  it('maps scopes and subscriptionType only when the document states them', () => {
    const withoutThem = adoptedFrom({ expiresAt: FUTURE_EXPIRY })
    expect(withoutThem?.credentials.scopes).toBeUndefined()
    expect(withoutThem?.credentials.subscriptionType).toBeUndefined()

    const withStringScopes = adoptedFrom({ expiresAt: FUTURE_EXPIRY, scopes: 'user:inference  user:profile', subscriptionType: 7 })
    // The RFC 6749 string form is accepted; a junk entry is dropped rather than
    // costing the user the whole sign-in, and a non-string subscriptionType is
    // simply not stated.
    expect(withStringScopes?.credentials.scopes).toEqual(['user:inference', 'user:profile'])
    expect(withStringScopes?.credentials.subscriptionType).toBeUndefined()

    const withJunkEntries = adoptedFrom({ expiresAt: FUTURE_EXPIRY, scopes: ['user:inference', 5, '', 'user:profile'] })
    expect(withJunkEntries?.credentials.scopes).toEqual(['user:inference', 'user:profile'])

    // No account block is invented, so the alias set falls back to the seed.
    expect(withoutThem?.credentials.account).toBeUndefined()
  })

  it('states the re-sign-in instruction for the card, naming Claude Code', () => {
    expect(ADOPTED_CREDENTIAL_EXPIRED_HINT).toContain('Claude Code')
    expect(ADOPTED_CREDENTIAL_EXPIRED_HINT.toLowerCase()).toContain('expired')
  })
})

describe('the adopted marker the pool must honour', () => {
  it('recognises a snapshot and refuses to mistake a plugin-owned credential for one', () => {
    const snapshot = parseAdoptedClaudeCredential(
      { [CLAUDE_CODE_CREDENTIAL_KEY]: { accessToken: CLAUDE_ACCESS_TOKEN, refreshToken: 'r', expiresAt: FUTURE_EXPIRY } },
      'C:\\fixtures\\.credentials.json',
    )
    expect(isAdoptedClaudeCredential(snapshot)).toBe(true)
    // A credential this plugin signed in itself: no marker, so it stays
    // refreshable and is never treated as a disposable snapshot.
    expect(isAdoptedClaudeCredential({ accessToken: 'a', refreshToken: 'r', expiresAt: FUTURE_EXPIRY })).toBe(false)
    // A malformed marker is not a marker.
    expect(isAdoptedClaudeCredential({ adopted: true, credentials: {} })).toBe(false)
    expect(isAdoptedClaudeCredential({ adopted: false, source: 'claude-code', credentials: {} })).toBe(false)
    expect(isAdoptedClaudeCredential(null)).toBe(false)
  })
})

describe('the reader never writes', () => {
  it('leaves the credential file and its directory byte-for-byte untouched', async () => {
    const file = await writeFixture(documentWithBothTokens())
    const directory = dirname(file)
    const before = {
      bytes: await readFile(file),
      stats: await stat(file),
      entries: (await readdir(directory)).sort(),
    }

    // Both entry points: the startup check and the opted-in read.
    await claudeCodeCredentialPresence([file])
    const adopted = await readClaudeCodeCredentials([file])
    expect(adopted?.credentials.accessToken).toBe(CLAUDE_ACCESS_TOKEN)

    const after = {
      bytes: await readFile(file),
      stats: await stat(file),
      entries: (await readdir(directory)).sort(),
    }
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.stats.size).toBe(before.stats.size)
    expect(after.stats.mtimeMs).toBe(before.stats.mtimeMs)
    // No temporary file, no backup, no marker file left behind.
    expect(after.entries).toEqual(before.entries)
    expect(after.entries).toEqual([CLAUDE_CODE_CREDENTIAL_FILE])
  })

  it('imports only read-only filesystem APIs, and admits no write call', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/host/claude/adopt.ts', import.meta.url)), 'utf8')

    // The named-only import is the module's structural guarantee: there is no fs
    // namespace object here to reach a write through.
    expect(source).toContain("import { readFile, stat } from 'node:fs/promises'")
    expect(source).not.toContain("from 'node:fs'")
    expect(source).not.toContain('* as fs')
    // Word-boundary matching on a CALL, so a prose word that merely contains a
    // write verb ("renamed", "unlinked", "confirm") cannot trip the guard.
    const writeCall = /\b(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|createWriteStream|truncate|chmod|link|symlink|utimes)\s*\(/
    expect(source).not.toMatch(writeCall)
    // Nothing exported here performs a write either: every export is a reader, a
    // predicate, a constant or a type.
    const exportNames = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((match) => match[1])
    expect(exportNames).toEqual([
      'claudeConfigDir',
      'claudeCodeCredentialPaths',
      'claudeCodeCredentialPresence',
      'parseAdoptedClaudeCredential',
      'readClaudeCodeCredentials',
      'isAdoptedClaudeCredential',
      'isAdoptedCredentialExpired',
    ])
  })
})
