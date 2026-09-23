import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup/isolated-home.ts'],
    sequence: { concurrent: false },

    /**
     * Generous per-test ceiling — this is the fix for the suite's instability.
     *
     * Several tests drive real `powershell.exe` subprocesses for the Windows
     * DPAPI credential store (`token-store-windows` spawns six), and one proxy
     * test also refreshes a token and falls back across two endpoints. Measured
     * in isolation the slowest takes 12.3-14.3s across runs, against the 15s
     * budget this file used to set — under 3s of headroom on a test whose own
     * duration varies by 2s. Any contention tipped it over, and the damage was
     * not confined to the test that lost: a test that times out with requests
     * still in flight leaves them running, so they landed in the *next* test's
     * fetch mock and failed it as well ("called 4 times, got 8", with the
     * captured URLs showing the previous test's calls). 60s is ~4x the worst
     * observed time: loose enough never to fire on a healthy run, still tight
     * enough to catch a genuinely hung test.
     */
    testTimeout: 60_000,

    /**
     * Belt-and-braces pool cap.
     *
     * With the timeout above, the full suite passes at Vitest's default pool
     * size (cores - 1) as well — but the contended resource here is subprocess
     * throughput rather than CPU, and an unstable external factor (a loaded CI
     * box, a parallel agent on the same machine) reintroduces the timeout, whose
     * failure mode leaks into neighbouring tests. Capping costs nothing
     * measurable: ~51s wall at 4 workers versus ~54s at 15, because the tests
     * are bound by subprocess latency.
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
})
