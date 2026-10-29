import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach } from 'vitest'

// Storage paths that fall back to `$DSH_HOME` (the Antigravity credential pool
// among them) must never resolve to the developer's real profile inside a test
// run. Two test files covering the same store used to race on the live
// `~/.dsh/storages` file and overwrite real credentials, so every test file now
// gets a private home instead.
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-test-home-'))
process.env.DSH_HOME = home

// Re-asserted per test: a file that reassigns or clears the variable for its own
// fixtures must not be able to leave the rest of the run pointing at the real
// profile. This is the difference between a broken fixture and real credentials.
beforeEach(() => {
  process.env.DSH_HOME = home
})

// The WorkBuddy route reads credentials from the CodeBuddy desktop client's own
// auth directory rather than from `$DSH_HOME`, so isolating the harness home is
// not enough for it: a store constructed without an explicit directory would
// otherwise scan the developer's real signed-in account. Point it at a private
// empty directory too. Tests that need credentials always pass their own
// directory explicitly, so nothing depends on the platform default here.
const codeBuddyAuth = mkdtempSync(path.join(os.tmpdir(), 'dsh-test-codebuddy-auth-'))
process.env.CODEBUDDY_AUTH_DIR = codeBuddyAuth

afterAll(() => {
  removeTree(home)
  removeTree(codeBuddyAuth)
})

/**
 * Remove a temp tree, tolerating a peer still writing into it.
 *
 * These directories are shared by every test file in the run, and vitest tears
 * each file down as it finishes rather than at the end of the run. A file whose
 * store has not finished flushing therefore races the `rm` of whichever file
 * happens to tear down first, and Linux surfaces that as
 * `ENOTEMPTY: directory not empty, rmdir` - a failure in a test that passed,
 * naming a directory no assertion ever mentions.
 *
 * The cleanup is a courtesy to the next run, not an assertion, so a tree that
 * cannot be removed is left for the OS temp sweeper instead of failing the
 * suite. Retrying briefly covers the ordinary case where the writer finishes a
 * moment later.
 */
function removeTree(directory: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      return
    } catch {
      // Busy on a shared temp dir: fall through and try again.
    }
  }
  console.warn(`[test-setup] could not remove temp dir ${directory}; leaving it to the OS`)
}
