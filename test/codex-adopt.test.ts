/**
 * Tests for OPT-IN adoption of a pre-existing Codex CLI sign-in.
 *
 * WHAT THIS FILE PROVES.
 *
 * 1. THE TRAP. A Codex auth.json may carry tokens that are not the ChatGPT
 *    subscription sign-in — an API key record, a third party's entry — so a
 *    fixture holding BOTH must come back with the tokens block, whichever one the
 *    serializer wrote first. Both orderings are covered, because a lazy tree walk
 *    would answer correctly for one of them by luck and wrongly for the other.
 * 2. THE MAPPING is exact, including expiresAt in EPOCH MILLISECONDS derived from
 *    the access token's own 'exp' claim. A seconds-versus-milliseconds bug is
 *    silent in one direction, so the assertion is written against the exact number
 *    rather than against a range.
 * 3. Presence is content-free. codexCliCredentialPresence() answers yes/no
 *    without reading any file: readFile is a spy here and is asserted NOT to have
 *    been called. A second test makes the same point observably, with a fixture
 *    that is not even JSON but is still reported present.
 * 4. The reader never writes. The credential file's bytes, size and mtime are
 *    identical before and after both entry points run, the directory gains no
 *    entry, and a source-level guard asserts the module imports exactly readFile
 *    and stat from node:fs/promises and contains no write API at all.
 * 5. An unrecognised shape yields undefined and NEVER throws: wrong types, a
 *    missing token block, a missing token, a blank token, a non-chatgpt auth_mode,
 *    a JWT with no usable exp, a non-JSON file, a directory in the file's place,
 *    an empty file, and a file that does not exist.
 * 6. The adopted marker exists and is not confused with a plugin-owned account.
 *
 * WHAT THIS FILE DOES NOT PROVE, and must not be read as proving. Every fixture
 * below is one this test wrote. The document shape and the file layout are
 * assembled from the mapping a user verified by hand against their own
 * `~/.codex/auth.json`, NOT from a captured file written by a running CLI on this
 * machine. These tests therefore establish that the parser and the reader behave
 * as designed against that shape. A layout difference in a future CLI would
 * surface as undefined (see 5), which is the intended failure mode rather than a
 * silent misread.
 *
 * This file mocks node:fs/promises, and only for the two call-through spies in 3.
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
  ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT,
  CODEX_CLI_CHATGPT_AUTH_MODE,
  CODEX_CLI_CREDENTIAL_FILE,
  CODEX_CLI_CREDENTIAL_SOURCE,
  CODEX_CLI_TOKENS_KEY,
  CODEX_HOME_ENV,
  codexCliCredentialPaths,
  codexCliCredentialPresence,
  codexHomeDir,
  isAdoptedCodexCredential,
  isAdoptedCodexCredentialExpired,
  parseAdoptedCodexCredential,
  readCodexCliCredentials,
} from '../src/host/codex-adopt.ts'

/** A JWT whose 'exp' is this many seconds past the epoch, as a real token states it. */
const ACCESS_EXP_SECONDS = 2_000_000_000
/** The same instant in epoch MILLISECONDS, which is what the store's field holds. */
const ACCESS_EXP_MS = ACCESS_EXP_SECONDS * 1000
const ID_EXP_SECONDS = 1_900_000_000

/**
 * A real-shaped JWT for the given claims.
 *
 * The header and signature are placeholder text: this module decodes the payload
 * and verifies nothing, and a test must not pretend otherwise by shipping a
 * signature it could not produce. What the reader reads is the payload, so that is
 * what the fixture makes real.
 */
function jwt(claims: Record<string, unknown>): string {
  const segment = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return [segment({ alg: 'RS256', typ: 'JWT' }), segment(claims), 'not-a-signature'].join('.')
}

const ACCESS_TOKEN = jwt({ exp: ACCESS_EXP_SECONDS, sub: 'user-1' })
const ID_TOKEN = jwt({
  exp: ID_EXP_SECONDS,
  email: 'owner@example.com',
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-from-id-token' },
})
/** A token that belongs to something else entirely and must never be adopted. */
const UNRELATED_TOKEN = 'sk-proj-an-api-key-that-is-not-a-subscription-sign-in'

/** A complete, recognizable document. Callers override what they are testing. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
    tokens: {
      id_token: ID_TOKEN,
      access_token: ACCESS_TOKEN,
      refresh_token: 'codex-refresh-token',
      account_id: 'acct-codex-1',
    },
    last_refresh: '2026-01-01T00:00:00Z',
    ...overrides,
  })
}

const directories: string[] = []
const savedHome = process.env[CODEX_HOME_ENV]

beforeEach(() => {
  // The variable decides which directory the module consults, so a test that sets
  // it must not leak into the next one — and, more importantly, the developer's
  // own CODEX_HOME must not decide what these tests see.
  delete process.env[CODEX_HOME_ENV]
  readFileSpy.mockClear()
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env[CODEX_HOME_ENV]
  else process.env[CODEX_HOME_ENV] = savedHome
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** A private directory that is removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/** Write one fixture file and answer its path. */
async function writeFixture(contents: string, name = CODEX_CLI_CREDENTIAL_FILE): Promise<string> {
  const file = join(await tempDir('dsh-codex-adopt-'), name)
  await writeFile(file, contents, 'utf8')
  return file
}

describe('the field mapping is exact', () => {
  it('maps the tokens block and derives expiry in epoch MILLISECONDS from the JWT exp', async () => {
    const file = await writeFixture(document())

    const adopted = await readCodexCliCredentials([file])

    expect(adopted).toBeDefined()
    // The exact number, not a range: 'exp' is seconds and the store's field is
    // milliseconds, and the wrong conversion is silent in one direction.
    expect(adopted?.credentials.expiresAt).toBe(ACCESS_EXP_MS)
    expect(adopted?.credentials.accessToken).toBe(ACCESS_TOKEN)
    expect(adopted?.credentials.refreshToken).toBe('codex-refresh-token')
    expect(adopted?.credentials.idToken).toBe(ID_TOKEN)
    expect(adopted?.credentials.accountId).toBe('acct-codex-1')
    // The claims the card renders come from the id token, and only from there.
    expect(adopted?.credentials.email).toBe('owner@example.com')
    expect(adopted?.credentials.planType).toBe('plus')
    expect(adopted?.source).toBe(CODEX_CLI_CREDENTIAL_SOURCE)
    expect(adopted?.sourcePath).toBe(file)
    expect(adopted?.adopted).toBe(true)
    // No token value is smuggled in anywhere but the credential record.
    expect(Object.keys(adopted ?? {}).sort()).toEqual(['adopted', 'credentials', 'source', 'sourcePath'])
  })

  it('omits what the document does not state rather than inventing it', () => {
    const sourcePath = join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE)
    const minimal = parseAdoptedCodexCredential({
      auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
      tokens: { access_token: ACCESS_TOKEN, refresh_token: 'r' },
    }, sourcePath)

    expect(minimal?.credentials.idToken).toBeUndefined()
    expect(minimal?.credentials.email).toBeUndefined()
    expect(minimal?.credentials.planType).toBeUndefined()
    expect(minimal?.credentials.accountId).toBeUndefined()
    expect(minimal?.credentials.expiresAt).toBe(ACCESS_EXP_MS)
  })

  it('tolerates an id token that states no plan, and one that does not decode', () => {
    const sourcePath = join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE)
    const withClaims = (idToken: string) => parseAdoptedCodexCredential({
      auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
      tokens: { access_token: ACCESS_TOKEN, refresh_token: 'r', id_token: idToken },
    }, sourcePath)

    expect(withClaims(jwt({ email: 'a@b.c' }))?.credentials.planType).toBeUndefined()
    expect(withClaims(jwt({ email: 'a@b.c' }))?.credentials.email).toBe('a@b.c')
    // An undecodable id token costs the claims, not the sign-in: the access token
    // is what the pool actually authenticates with.
    const undecodable = withClaims('not.a.jwt')
    expect(undecodable?.credentials.idToken).toBe('not.a.jwt')
    expect(undecodable?.credentials.email).toBeUndefined()
  })
})

describe('an unrelated token is never adopted', () => {
  it('returns the tokens block from a document that also carries a foreign token', async () => {
    // The foreign entry is FIRST on purpose: JSON object order is preserved by
    // JSON.parse, so a "first accessToken anywhere" scan would answer with it on
    // this fixture. That is what makes the assertion below meaningful rather than
    // incidental.
    const file = await writeFixture(document({
      OPENAI_API_KEY: UNRELATED_TOKEN,
      nested: { access_token: UNRELATED_TOKEN, refresh_token: 'r' },
    }))

    const adopted = await readCodexCliCredentials([file])

    expect(adopted?.credentials.accessToken).toBe(ACCESS_TOKEN)
    expect(adopted?.credentials.accessToken).not.toBe(UNRELATED_TOKEN)
    expect(adopted?.credentials.refreshToken).toBe('codex-refresh-token')
  })

  it('returns the tokens block when the two entries are written in the other order', async () => {
    const raw = JSON.parse(document()) as { tokens: Record<string, unknown> }
    const reversed = { ...raw, tokens: undefined, other: { access_token: UNRELATED_TOKEN } }
    delete reversed.tokens
    const file = await writeFixture(JSON.stringify({ other: reversed.other, ...raw, tokens: raw.tokens }))

    expect((await readCodexCliCredentials([file]))?.credentials.accessToken).toBe(ACCESS_TOKEN)
  })

  it('yields undefined for a document whose only tokens are not the tokens block', () => {
    const sourcePath = join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE)
    const cases: unknown[] = [
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, nested: { access_token: UNRELATED_TOKEN, refresh_token: 'r' } },
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, [CODEX_CLI_TOKENS_KEY]: null },
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, [CODEX_CLI_TOKENS_KEY]: [] },
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, [CODEX_CLI_TOKENS_KEY]: 'access_token' },
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, [CODEX_CLI_TOKENS_KEY]: {} },
      // An access token with no refresh token is NOT adopted: the store's record
      // is a sign-in, not a bare token, and the missing half could never be
      // re-recognised.
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, [CODEX_CLI_TOKENS_KEY]: { access_token: ACCESS_TOKEN } },
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, [CODEX_CLI_TOKENS_KEY]: { refresh_token: 'r' } },
      {
        auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
        [CODEX_CLI_TOKENS_KEY]: { access_token: '   ', refresh_token: 'r' },
      },
      // The foreign token must not be promoted into a missing tokens block either.
      {
        auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
        nested: { access_token: UNRELATED_TOKEN, refresh_token: 'r' },
      },
    ]
    for (const value of cases) {
      expect(parseAdoptedCodexCredential(value, sourcePath), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('refuses an auth_mode that is not the ChatGPT sign-in', () => {
    const sourcePath = join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE)
    for (const authMode of ['apiKey', '', null, undefined, 7, undefined]) {
      const value = { auth_mode: authMode, [CODEX_CLI_TOKENS_KEY]: { access_token: ACCESS_TOKEN, refresh_token: 'r' } }
      expect(parseAdoptedCodexCredential(value, sourcePath), String(authMode)).toBeUndefined()
    }
  })
})

describe('a token with no usable expiry is refused', () => {
  it('yields undefined rather than stamping an invented one', () => {
    const sourcePath = join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE)
    const unusable = [
      'not-a-jwt',
      'only.two',
      'a.b.c.d',
      // A payload that decodes to no object at all.
      ['', Buffer.from('"nope"', 'utf8').toString('base64url'), 's'].join('.'),
      // An object payload whose exp is unusable.
      jwt({}),
      jwt({ exp: null }),
      jwt({ exp: '2000000000' }),
      jwt({ exp: Number.NaN }),
      jwt({ exp: -1 }),
    ]
    for (const accessToken of unusable) {
      const value = {
        auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
        [CODEX_CLI_TOKENS_KEY]: { access_token: accessToken, refresh_token: 'r' },
      }
      expect(parseAdoptedCodexCredential(value, sourcePath), accessToken).toBeUndefined()
    }
  })

  it('reports expiry against an injected clock, treating the instant itself as expired', () => {
    const adopted = parseAdoptedCodexCredential({
      auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
      [CODEX_CLI_TOKENS_KEY]: { access_token: ACCESS_TOKEN, refresh_token: 'r' },
    }, join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE))
    expect(adopted).toBeDefined()
    if (adopted === undefined) return

    // The predicate reads a FLAT credential, which is the shape the pool stores
    // (see AdoptedCredentialMarkers); the snapshot nests one under 'credentials'.
    expect(isAdoptedCodexCredentialExpired(adopted.credentials, ACCESS_EXP_MS - 1)).toBe(false)
    expect(isAdoptedCodexCredentialExpired(adopted.credentials, ACCESS_EXP_MS)).toBe(true)
    expect(isAdoptedCodexCredentialExpired(adopted.credentials, ACCESS_EXP_MS + 1)).toBe(true)
    // A non-finite expiry is expired: no established validity, no use.
    expect(isAdoptedCodexCredentialExpired({ expiresAt: Number.NaN }, 0)).toBe(true)
    // The hint names the place the user has to go, not this settings card.
    expect(ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT).toContain('Codex CLI')
    expect(ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT.toLowerCase()).toContain('expired')
  })
})

describe('presence is a separate, content-free check', () => {
  it('answers yes without reading any content, and lists nothing it did not stat', async () => {
    const file = await writeFixture(document())
    const absent = join(await tempDir('dsh-codex-adopt-empty-'), CODEX_CLI_CREDENTIAL_FILE)

    expect(await codexCliCredentialPresence([absent, file])).toBe(true)
    expect(await codexCliCredentialPresence([absent])).toBe(false)
    // THE POINT OF THE SPLIT: the startup check never opens a candidate for
    // reading, so a user who does not opt in never has their token read.
    expect(readFileSpy).not.toHaveBeenCalled()

    // ...and the spy is LIVE, which is what makes the assertion above evidence
    // rather than a no-op: the opted-in read does go through it.
    expect((await readCodexCliCredentials([file]))?.credentials.accessToken).toBe(ACCESS_TOKEN)
    expect(readFileSpy).toHaveBeenCalled()
  })

  it('reports a present file whose content is not JSON at all', async () => {
    // Belt and braces for the spy above: the answer cannot depend on the content,
    // because here the content cannot even be parsed and the answer is still yes.
    const file = await writeFixture('this is not json {{{')
    expect(await codexCliCredentialPresence([file])).toBe(true)
  })
})

describe('candidate paths and precedence', () => {
  it('honours CODEX_HOME, and treats a blank value as unset', () => {
    const configured = join('C:', 'codex', 'work')
    process.env[CODEX_HOME_ENV] = configured
    expect(codexHomeDir()).toBe(configured)
    expect(codexCliCredentialPaths()).toEqual([join(configured, CODEX_CLI_CREDENTIAL_FILE)])

    // A blank variable is not "the directory with an empty name": that would
    // resolve to a drive-relative path on Windows.
    process.env[CODEX_HOME_ENV] = '   '
    const fromHome = codexHomeDir()
    expect(fromHome).toBe(join(homedir(), '.codex'))
    expect(codexCliCredentialPaths()).toEqual([join(fromHome, CODEX_CLI_CREDENTIAL_FILE)])
  })

  it('is read at call time, so a home set after import is honoured', async () => {
    const directory = await tempDir('dsh-codex-home-')
    await writeFile(join(directory, CODEX_CLI_CREDENTIAL_FILE), document(), 'utf8')
    process.env[CODEX_HOME_ENV] = directory

    const adopted = await readCodexCliCredentials()
    expect(adopted?.sourcePath).toBe(join(directory, CODEX_CLI_CREDENTIAL_FILE))
  })

  it('uses the first candidate that parses, and reports which file that was', async () => {
    const broken = await writeFixture('not json')
    const good = await writeFixture(document())

    const adopted = await readCodexCliCredentials([broken, good])

    expect(adopted?.credentials.accessToken).toBe(ACCESS_TOKEN)
    // The source path is the only way a fallback stays visible to the user.
    expect(adopted?.sourcePath).toBe(good)
  })
})

describe('unrecognised input never throws', () => {
  it('answers undefined for every shape it does not recognise', () => {
    const sourcePath = join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE)
    const cases: unknown[] = [
      null, undefined, 42, 'tokens', [], {},
      { auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE, tokens: undefined },
    ]
    for (const value of cases) {
      expect(parseAdoptedCodexCredential(value, sourcePath), JSON.stringify(value) ?? 'undefined').toBeUndefined()
    }
  })

  it('answers undefined instead of throwing for files it cannot use', async () => {
    const directory = await tempDir('dsh-codex-adopt-bad-')
    const missing = join(directory, 'nope.json')
    const notJson = await writeFixture('}{ not json')
    const empty = await writeFixture('')
    const asDirectory = join(await tempDir('dsh-codex-adopt-dir-'), CODEX_CLI_CREDENTIAL_FILE)
    await mkdir(asDirectory)

    expect(await readCodexCliCredentials([missing])).toBeUndefined()
    expect(await readCodexCliCredentials([notJson])).toBeUndefined()
    expect(await readCodexCliCredentials([empty])).toBeUndefined()
    expect(await readCodexCliCredentials([asDirectory])).toBeUndefined()
    // An absent file, and a directory in the file's place, are also "no" from the
    // presence check rather than a throw.
    expect(await codexCliCredentialPresence([missing])).toBe(false)
    expect(await codexCliCredentialPresence([asDirectory])).toBe(false)
  })
})

describe('the adopted marker the pool must honour', () => {
  it('recognises a snapshot and refuses to mistake a plugin-owned credential for one', () => {
    const snapshot = parseAdoptedCodexCredential({
      auth_mode: CODEX_CLI_CHATGPT_AUTH_MODE,
      [CODEX_CLI_TOKENS_KEY]: { access_token: ACCESS_TOKEN, refresh_token: 'r' },
    }, join('C:', 'fixtures', CODEX_CLI_CREDENTIAL_FILE))
    expect(isAdoptedCodexCredential(snapshot)).toBe(true)
    // A credential this plugin signed in itself: no marker, so it stays
    // refreshable and is never treated as a disposable snapshot.
    expect(isAdoptedCodexCredential({ accessToken: 'a', refreshToken: 'r', expiresAt: ACCESS_EXP_MS })).toBe(false)
    // A malformed or partial marker is not a marker.
    expect(isAdoptedCodexCredential({ adopted: true, credentials: {} })).toBe(false)
    expect(isAdoptedCodexCredential({ adopted: true, source: 'other', credentials: {} })).toBe(false)
    expect(isAdoptedCodexCredential({ adopted: false, source: 'codex', credentials: {} })).toBe(false)
    expect(isAdoptedCodexCredential({ adopted: true, source: 'codex' })).toBe(false)
    expect(isAdoptedCodexCredential(null)).toBe(false)
  })
})

describe('the reader never writes', () => {
  it('leaves the credential file and its directory byte-for-byte untouched', async () => {
    const file = await writeFixture(document())
    const directory = dirname(file)
    const before = {
      bytes: await readFile(file),
      stats: await stat(file),
      entries: (await readdir(directory)).sort(),
    }

    // Both entry points: the startup check and the opted-in read.
    expect(await codexCliCredentialPresence([file])).toBe(true)
    const adopted = await readCodexCliCredentials([file])
    expect(adopted?.credentials.accessToken).toBe(ACCESS_TOKEN)

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
    expect(after.entries).toEqual([CODEX_CLI_CREDENTIAL_FILE])
  })

  it('imports only read-only filesystem APIs, and admits no write call', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/host/codex-adopt.ts', import.meta.url)), 'utf8')

    // The named-only import is the module's structural guarantee: there is no fs
    // namespace object here to reach a write through.
    expect(source).toContain("import { readFile, stat } from 'node:fs/promises'")
    expect(source).not.toContain("from 'node:fs'")
    expect(source).not.toContain('* as fs')
    // Word-boundary matching on a CALL, so a prose word that merely contains a
    // write verb ("renamed", "unlinked", "confirm") cannot trip the guard.
    const writeCall = /\b(?:writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|createWriteStream|truncate|chmod|link|symlink|utimes)\s*\(/
    expect(source).not.toMatch(writeCall)
    // RULE 3 as a source fact: there is no refresh function in this module to
    // find, so nothing here can rotate a grant the Codex CLI is also rotating.
    expect(source).not.toMatch(/export (?:async )?function \w*[Rr]efresh\w*/)
    // Nothing exported here performs a write either: every export is a reader, a
    // predicate, a constant or a type.
    const exportNames = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((match) => match[1])
    expect(exportNames).toEqual([
      'codexHomeDir',
      'codexCliCredentialPaths',
      'codexCliCredentialPresence',
      'parseAdoptedCodexCredential',
      'readCodexCliCredentials',
      'isAdoptedCodexCredential',
      'isAdoptedCodexCredentialExpired',
    ])
  })
})
