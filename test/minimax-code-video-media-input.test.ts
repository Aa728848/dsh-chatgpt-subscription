// @vitest-environment jsdom
/**
 * Unit tests for the media intake layer.
 *
 * Three entry points (browse / drop / paste) all end up calling one normalizer, and
 * that normalizer is the only thing standing between a user and a billed request the
 * host will refuse. These cases pin the boundary: what counts as a local path, what
 * is a link, and what has no path at all.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_INTAKE,
  hostPathForFile,
  intakeFromFiles,
  intakeFromText,
  isMinimaxCdnUrl,
  mediaKindOf,
  mediaNameOf,
  mergeIntake,
  needsDuration,
  normalizeMediaLine,
  pathFromFileUrl,
  stripReferencePrefix,
} from '../src/client/minimax-code/video-media-input.ts'

describe('normalizeMediaLine', () => {
  it('passes a plain local path through, quotes and all', () => {
    expect(normalizeMediaLine('  C:\\ws\\a.png  ')).toEqual({ path: 'C:\\ws\\a.png' })
    expect(normalizeMediaLine('"/home/u/a.png"')).toEqual({ path: '/home/u/a.png' })
    expect(normalizeMediaLine('relative/b.png')).toEqual({ path: 'relative/b.png' })
  })

  it('accepts the composer @workspace reference spelling', () => {
    // A user copies "@docs/a.png" out of the conversation; the tool takes a path.
    expect(normalizeMediaLine('@docs/a.png')).toEqual({ path: 'docs/a.png' })
    expect(normalizeMediaLine('@C:\\ws\\a.png')).toEqual({ path: 'C:\\ws\\a.png' })
    // A bare @ is not a path, and only a LEADING one is a composition spelling.
    expect(stripReferencePrefix('@')).toBe('@')
    expect(stripReferencePrefix('a@b.png')).toBe('a@b.png')
  })

  it('does not mistake a Windows drive letter for a URL scheme', () => {
    // C: looks like scheme: unless single letters are excluded; a drive path that
    // gets rejected here would make the panel unusable on Windows.
    expect(normalizeMediaLine('D:\\clips\\v1.mp4')).toEqual({ path: 'D:\\clips\\v1.mp4' })
  })

  it('turns a file:// address back into a path', () => {
    expect(pathFromFileUrl('file:///C:/ws/a.png')).toBe('C:/ws/a.png')
    expect(pathFromFileUrl('file:///home/u/a.png')).toBe('/home/u/a.png')
    expect(normalizeMediaLine('file:///C:/ws/a.png')).toEqual({ path: 'C:/ws/a.png' })
  })

  it('rejects web links the service would refuse anyway', () => {
    expect(normalizeMediaLine('https://example.com/a.png')).toEqual({ rejectedUrl: 'https://example.com/a.png' })
    expect(normalizeMediaLine('data:image/png;base64,AAAA')).toEqual({ rejectedUrl: 'data:image/png;base64,AAAA' })
    expect(normalizeMediaLine('blob:http://x/y')).toEqual({ rejectedUrl: 'blob:http://x/y' })
  })

  it('accepts the one URL host the host route actually reads', () => {
    // cdn.hailuoai.com is the only address prepareMediaInput lets through
    // (assertMinimaxCdnUrl); anything else is refused before the model sees it.
    const cdn = 'https://cdn.hailuoai.com/video/out/a.mp4'
    expect(normalizeMediaLine(cdn)).toEqual({ path: cdn })
    expect(isMinimaxCdnUrl(cdn)).toBe(true)
    expect(isMinimaxCdnUrl('https://evil.example.com/a.mp4')).toBe(false)
    expect(isMinimaxCdnUrl('https://cdn.hailuoai.com.evil.example/a.mp4')).toBe(false)
  })

  it('asks for a length only on the CDN clips the host cannot measure', () => {
    expect(needsDuration('https://cdn.hailuoai.com/video/out/a.mp4')).toBe(true)
    // A local file's length is read from its container, so nothing to ask.
    expect(needsDuration('C:\\ws\\a.mp4')).toBe(false)
    expect(needsDuration('/ws/a.mp4')).toBe(false)
  })

  it('ignores blank lines', () => {
    expect(normalizeMediaLine('   ')).toBeUndefined()
    expect(normalizeMediaLine('')).toBeUndefined()
  })
})

describe('intakeFromText', () => {
  it('splits lines, de-duplicates, and reports the links it refused', () => {
    const intake = intakeFromText([
      '/ws/a.png',
      '  /ws/a.png  ',
      '',
      'https://example.com/b.png',
      '/ws/c.mp4',
    ].join('\n'))
    expect(intake.paths).toEqual(['/ws/a.png', '/ws/c.mp4'])
    expect(intake.rejectedUrls).toEqual(['https://example.com/b.png'])
    expect(intake.withoutPath).toBe(0)
  })

  it('skips the comment lines a uri-list drag carries', () => {
    expect(intakeFromText('# file:///C:/ws\nC:\\ws\\a.png').paths).toEqual(['C:\\ws\\a.png'])
  })
})

describe('intakeFromFiles', () => {
  it('asks the host bridge for a real path', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const intake = intakeFromFiles([file], { pathFor: () => 'C:\\ws\\a.png' })
    expect(intake).toEqual({ paths: ['C:\\ws\\a.png'], rejectedUrls: [], withoutPath: 0 })
  })

  it('counts a file with no path rather than inventing one', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    expect(intakeFromFiles([file], {})).toEqual({ paths: [], rejectedUrls: [], withoutPath: 1 })
    // A bridge that throws must not take the panel down with it.
    expect(intakeFromFiles([file], {
      pathFor: () => { throw new Error('no path') },
    })).toEqual({ paths: [], rejectedUrls: [], withoutPath: 1 })
  })

  it('collapses duplicates from a multi-select', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const intake = intakeFromFiles([file, file], { pathFor: () => 'C:\\ws\\a.png' })
    expect(intake.paths).toEqual(['C:\\ws\\a.png'])
  })

  it('reads the ambient bridge when none is injected', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const global = globalThis as { __DSH_HOST_PATHS__?: { pathFor: (file: File) => string } }
    const previous = global.__DSH_HOST_PATHS__
    global.__DSH_HOST_PATHS__ = { pathFor: () => 'C:\\ws\\browser.png' }
    try {
      expect(hostPathForFile(file)).toBe('C:\\ws\\browser.png')
    } finally {
      if (previous === undefined) delete global.__DSH_HOST_PATHS__
      else global.__DSH_HOST_PATHS__ = previous
    }
    // A plain browser has no bridge at all.
    expect(hostPathForFile(file)).toBe('')
  })
})

describe('mergeIntake', () => {
  it('keeps order and adds the counts', () => {
    const merged = mergeIntake(
      { paths: ['/a'], rejectedUrls: [], withoutPath: 1 },
      { paths: ['/a', '/b'], rejectedUrls: ['https://x'], withoutPath: 1 },
    )
    expect(merged).toEqual({ paths: ['/a', '/b'], rejectedUrls: ['https://x'], withoutPath: 2 })
    expect(mergeIntake(EMPTY_INTAKE, EMPTY_INTAKE)).toEqual({ paths: [], rejectedUrls: [], withoutPath: 0 })
  })
})

describe('mediaKindOf and mediaNameOf', () => {
  it('routes a path to the right block by its extension', () => {
    expect(mediaKindOf('C:\\ws\\a.PNG')).toBe('image')
    expect(mediaKindOf('/ws/v.mp4')).toBe('video')
    expect(mediaKindOf('/ws/a.wav')).toBe('audio')
    expect(mediaKindOf('/ws/notes.txt')).toBe('unknown')
    expect(mediaKindOf('no-extension')).toBe('unknown')
  })

  it('shows the last path segment in a chip', () => {
    expect(mediaNameOf('C:\\ws\\a.png')).toBe('a.png')
    expect(mediaNameOf('/ws/deep/b.mp4')).toBe('b.mp4')
    expect(mediaNameOf('plain.txt')).toBe('plain.txt')
  })
})
