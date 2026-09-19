import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

// Storage paths that fall back to `$DSH_HOME` (the Antigravity credential pool
// among them) must never resolve to the developer's real profile inside a test
// run. Two test files covering the same store used to race on the live
// `~/.dsh/storages` file and overwrite real credentials, so every test file now
// gets a private home instead.
const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-test-home-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})
