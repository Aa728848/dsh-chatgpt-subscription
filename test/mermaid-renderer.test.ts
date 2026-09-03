// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../src/client/mermaid/sanitize.ts'

describe('Mermaid renderer & sanitizer', () => {
  it('strips foreignObject, script and on* handlers from SVG', () => {
    const rawSvg = `
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <foreignObject width="100" height="100">
          <div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div>
        </foreignObject>
        <g id="node1" onclick="alert(2)" data-val="123">
          <text x="10" y="20">Hello World</text>
        </g>
        <script>alert(3)</script>
      </svg>
    `
    const cleaned = sanitizeSvg(rawSvg)
    expect(cleaned).toContain('<text x="10" y="20">Hello World</text>')
    expect(cleaned).not.toContain('foreignObject')
    expect(cleaned).not.toContain('foreignobject')
    expect(cleaned).not.toContain('script')
    expect(cleaned).not.toContain('onclick')
    expect(cleaned).not.toContain('alert')
  })

  it('handles invalid xml gracefully without throwing', () => {
    const invalid = '<svg><unclosed>'
    const cleaned = sanitizeSvg(invalid)
    expect(cleaned).toBe('')
  })
})