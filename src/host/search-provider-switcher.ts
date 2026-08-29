import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

interface LoaderLike {
  entries(): Iterable<Entry>
}

export async function restoreDefaultWebProviders(loader: LoaderLike): Promise<void> {
  for (const entry of loader.entries()) {
    if (entry.options.id === 'web' || entry.options.name === '@deepseek-ai/dsh-web') {
      const config = currentConfig(entry)
      let changed = false
      const nextConfig = { ...config }
      if (nextConfig.searchProvider === 'codex-subscription') {
        delete nextConfig.searchProvider
        changed = true
      }
      if (nextConfig.fetchProvider === 'codex-subscription') {
        delete nextConfig.fetchProvider
        changed = true
      }
      if (changed) {
        await entry.update({ config: nextConfig }, true)
      }
    }
  }
}

function currentConfig(entry: Entry): Record<string, unknown> {
  const config = entry.options.config
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}
