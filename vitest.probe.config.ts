import { defineConfig } from 'vitest/config'

/**
 * Dedicated config for the one-shot channel probes.
 *
 * It deliberately omits `test/setup/isolated-home.ts`: the probes must read the
 * real `~/.dsh` credentials, which that setup redirects to a temp home.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.probe.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    maxWorkers: 1,
    minWorkers: 1,
  },
})
