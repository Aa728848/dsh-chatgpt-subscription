import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface RegistryProvider {
  getModels(): readonly Record<string, unknown>[]
}

interface RegistryModule {
  anthropicProvider(): RegistryProvider
}

/**
 * Load Claude's catalog from the pi-ai installation shipped with the active
 * DSH CLI. The plugin does not take a package dependency on pi-ai, because DSH
 * owns and upgrades that live provider registry.
 */
export function createDshAnthropicRegistryLoader(moduleAnchor?: string): () => Promise<Record<string, unknown>[]> {
  let loading: Promise<RegistryModule> | undefined
  return async () => {
    loading ??= loadRegistry(moduleAnchor)
    return [...(await loading).anthropicProvider().getModels()]
  }
}

async function loadRegistry(moduleAnchor?: string): Promise<RegistryModule> {
  try {
    const packageName: string = '@earendil-works/pi-ai/providers/anthropic'
    return await import(packageName) as RegistryModule
  } catch {
    const roots = candidateModuleRoots(moduleAnchor)
    for (const root of roots) {
      const piRoot = await findPackageRoot(root, '@earendil-works/pi-ai')
      if (piRoot !== null) return await import(await packageImportUrl(piRoot, 'providers/anthropic')) as RegistryModule
    }
    throw new Error('The active DSH installation does not expose the pi-ai Anthropic model registry')
  }
}

function candidateModuleRoots(moduleAnchor?: string): string[] {
  const roots = new Set<string>()
  const anchors = [moduleAnchor, process.env.DSH_CLI_PATH, process.argv[1], import.meta.url]
  for (const anchor of anchors) {
    if (!anchor) continue
    try {
      const require = createRequire(anchor)
      const llmPath = require.resolve('@deepseek-ai/dsh-llm')
      roots.add(dirname(llmPath))
    } catch {
      const plain = anchor.startsWith('file:') ? new URL(anchor).pathname : anchor
      roots.add(dirname(resolve(plain)))
    }
  }
  for (const nodePath of (process.env.NODE_PATH ?? '').split(delimiter)) {
    if (nodePath) roots.add(resolve(nodePath))
  }
  const appData = process.env.APPDATA
  if (appData) roots.add(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  return [...roots]
}

async function findPackageRoot(startDirectory: string, packageName: string): Promise<string | null> {
  const packageParts = packageName.split('/')
  let current = resolve(startDirectory)
  while (true) {
    const candidate = join(current, 'node_modules', ...packageParts)
    try {
      await access(join(candidate, 'package.json'))
      return candidate
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

async function packageImportUrl(packageRoot: string, subpath: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
  }
  const target = resolveExport(packageJson.exports?.[`./${subpath}`])
    ?? resolveWildcardExport(packageJson.exports, subpath)
  if (target === null) throw new Error(`Cannot resolve pi-ai subpath ${subpath}`)
  return pathToFileURL(join(packageRoot, target)).href
}

function resolveWildcardExport(exports: Record<string, unknown> | undefined, subpath: string): string | null {
  if (exports === undefined) return null
  const key = `./${subpath}`
  for (const [pattern, value] of Object.entries(exports)) {
    const star = pattern.indexOf('*')
    if (star < 0) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    const target = resolveExport(value)
    if (target !== null) return target.replace('*', key.slice(prefix.length, key.length - suffix.length))
  }
  return null
}

function resolveExport(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const condition of ['import', 'node', 'default']) {
    const target = resolveExport(record[condition])
    if (target !== null) return target
  }
  return null
}
