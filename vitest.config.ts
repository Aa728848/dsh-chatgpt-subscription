import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup/isolated-home.ts'],
    sequence: { concurrent: false },
    testTimeout: 15_000,
  },
})
