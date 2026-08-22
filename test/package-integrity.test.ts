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

  it('ensures peerDependencies and devDependencies match for @deepseek-ai packages', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
    const peerDeps = pkg.peerDependencies || {}
    const devDeps = pkg.devDependencies || {}

    const dshPeerKeys = Object.keys(peerDeps).filter((k) => k.startsWith('@deepseek-ai/'))
    for (const key of dshPeerKeys) {
      if (devDeps[key]) {
        expect(devDeps[key], `devDependency ${key} must match peerDependency ${key}`).toBe(peerDeps[key])
      }
    }
  })
})
