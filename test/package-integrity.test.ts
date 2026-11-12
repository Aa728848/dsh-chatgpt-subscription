import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT_DIR = path.resolve(__dirname, '..')

function getFilesRecursively(dir: string, extensions: string[]): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') {
        continue
      }
      result.push(...getFilesRecursively(fullPath, extensions))
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      result.push(fullPath)
    }
  }
  return result
}

describe('Package Integrity & BOM Checks', () => {
  it('ensures package.json has no UTF-8 BOM and is valid JSON', () => {
    const pkgPath = path.join(ROOT_DIR, 'package.json')
    const rawBuffer = fs.readFileSync(pkgPath)

    // Check BOM bytes (0xEF, 0xBB, 0xBF)
    const hasBom = rawBuffer.length >= 3 && rawBuffer[0] === 0xef && rawBuffer[1] === 0xbb && rawBuffer[2] === 0xbf
    expect(hasBom, 'package.json must not contain UTF-8 BOM').toBe(false)

    // Check JSON.parse directly on raw string
    const rawText = rawBuffer.toString('utf8')
    expect(rawText.charCodeAt(0), 'package.json first char must not be 0xFEFF').not.toBe(0xfeff)
    expect(() => JSON.parse(rawText), 'package.json must parse successfully without BOM stripping').not.toThrow()
  })

  it('ensures all source, config, and documentation files contain no UTF-8 BOM', () => {
    const files = [
      path.join(ROOT_DIR, 'package.json'),
      path.join(ROOT_DIR, 'cordis.patch.yml'),
      path.join(ROOT_DIR, 'CHANGELOG.md'),
      path.join(ROOT_DIR, 'README.md'),
      path.join(ROOT_DIR, 'tsconfig.json'),
      path.join(ROOT_DIR, 'tsconfig.host.json'),
      path.join(ROOT_DIR, 'tsconfig.client.json'),
      path.join(ROOT_DIR, 'tsdown.config.ts'),
      path.join(ROOT_DIR, 'vitest.config.ts'),
      ...getFilesRecursively(path.join(ROOT_DIR, 'src'), ['.ts', '.tsx', '.json', '.css']),
      ...getFilesRecursively(path.join(ROOT_DIR, 'test'), ['.ts', '.tsx']),
    ]

    const filesWithBom: string[] = []
    for (const file of files) {
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file)
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          filesWithBom.push(path.relative(ROOT_DIR, file))
        }
      }
    }

    expect(filesWithBom, 'No project files should contain UTF-8 BOM').toEqual([])
  })

  it('ensures every @deepseek-ai devDependency range is one its peerDependency also declares', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
    const peerDeps = pkg.peerDependencies || {}
    const devDeps = pkg.devDependencies || {}

    const rangesOf = (spec: string): string[] => spec.split('||').map((part) => part.trim())
    const dshPeerKeys = Object.keys(peerDeps).filter((k) => k.startsWith('@deepseek-ai/'))
    for (const key of dshPeerKeys) {
      if (!devDeps[key]) continue
      // The peer range declares every harness generation this plugin supports;
      // the dev range is the one it builds and tests against, so it must be a
      // subset rather than an equal — claiming a generation without exercising
      // it is what this checks against.
      const peerRanges = new Set(rangesOf(peerDeps[key]))
      for (const devRange of rangesOf(devDeps[key])) {
        expect(
          peerRanges.has(devRange),
          `devDependency ${key} range ${devRange} must appear in peerDependency ${key}`,
        ).toBe(true)
      }
    }
  })

  it('never installs a kernel package into the profile beside the running harness', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
    const dependents = pkg.dependencies || {}
    const peerDeps = pkg.peerDependencies || {}
    const peerMeta = pkg.peerDependenciesMeta || {}

    // Issue #104: shipping a kernel package as a real dependency made npm copy it
    // into the profile, where the pinned copy shadowed the desktop kernel's own
    // version and broke the `standard` preset on every drift. No @deepseek-ai
    // package may appear in `dependencies` — the kernel supplies them all.
    const kernelDeps = Object.keys(dependents).filter((key) => key.startsWith('@deepseek-ai/'))
    expect(kernelDeps, 'kernel packages must be peers, never dependencies').toEqual([])

    // The other kernel peers carry the union of every supported generation, so
    // npm resolves them to the copy the harness already installed. The executor
    // was the exception that produced issue #104: a caret range in
    // `dependencies` that npm installed as a second, version-pinned copy. It is
    // an optional peer so npm never installs it, and Code Mode degrades to the
    // PTC row when the running harness does not ship it.
    const executor = '@deepseek-ai/dsh-tool-executor-native'
    expect(peerDeps[executor], `${executor} must be a peer`).toBeTruthy()
    expect(
      peerMeta[executor]?.optional,
      `${executor} must be an optional peer so npm does not install a second copy`,
    ).toBe(true)
  })

  it('declares a Node engines floor at least as new as the transport it bundles', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
    const node = pkg.engines?.node

    // Without an engines floor npm installs this plugin happily on an old LTS and
    // the failure only surfaces at runtime, as a syntax/runtime error inside the
    // bundled transport rather than as an install-time refusal.
    expect(node, 'package.json must declare engines.node').toBeTruthy()

    const floor = String(node).match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
    expect(floor, `engines.node must be a plain ">=X.Y.Z" floor, got ${String(node)}`).toBeTruthy()

    const declared = [Number(floor![1]), Number(floor![2] ?? 0), Number(floor![3] ?? 0)]
    // undici ^8 is bundled into lib/index.js and declares node >=22.19.0. A weaker
    // floor would advertise support for a runtime the bundled transport cannot use,
    // which is exactly what this guard exists to stop (>=18.0.0 was proposed once).
    const required = [22, 19, 0]
    const comparison = declared[0] - required[0] || declared[1] - required[1] || declared[2] - required[2]
    expect(
      comparison >= 0,
      `engines.node ${String(node)} is weaker than the bundled undici floor >=22.19.0`,
    ).toBe(true)
  })

  it('keeps the native executor a real import in the built Code Mode bundle', () => {
    const bundlePath = path.join(ROOT_DIR, 'lib', 'codemode.js')
    if (!fs.existsSync(bundlePath)) return
    const content = fs.readFileSync(bundlePath, 'utf8')

    // One executor per scope: Code Mode hands every program sub-call to the
    // kernel's instance. Inlining a copy would apply that copy's own policy and
    // approval pipeline beside the host's, which is the failure this guards.
    expect(content).toMatch(/from\s*["']@deepseek-ai\/dsh-tool-executor-native["']/)
  })

  it('ensures built lib/index.js does not statically import CallId from @deepseek-ai/dsh-llm', () => {
    const libIndexPath = path.join(ROOT_DIR, 'lib', 'index.js')
    if (fs.existsSync(libIndexPath)) {
      const content = fs.readFileSync(libIndexPath, 'utf8')
      const topImports = content.slice(0, 2000)
      expect(topImports).not.toMatch(/import\s*\{[^}]*\bCallId\b[^}]*\}\s*from\s*["']@deepseek-ai\/dsh-llm["']/)
    }
  })
})
