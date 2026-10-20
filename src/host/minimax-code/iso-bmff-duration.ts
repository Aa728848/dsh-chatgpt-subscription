/**
 * The smallest ISO BMFF duration reader this route needs, with no decoder.
 *
 * WHY IT EXISTS. A reference video must be sent to the generation service with
 * its length in seconds beside it (docs/minimax-video-extended-spec.md section
 * 4), and upstream reads that number out of the container itself rather than
 * asking the caller for it - `readIsoBmffDurationSeconds` is the name of the
 * upstream file too. A LOCAL reference video therefore owes the caller no
 * `referenceVideoDurationSeconds` argument: this module supplies it.
 *
 * WHY IT IS NOT AFFMPEG. The number lives in exactly one box, `moov/mvhd`, at a
 * fixed byte offset inside it. Reaching it is an eight-byte header walk, not a
 * demux; pulling in a media toolchain (or a native binding) to read two integers
 * would dwarf the rest of this plugin.
 *
 * THE TWO LAYOUTS, which is the whole reason the walk is written the way it is:
 *
 * | layout        | box order            | what a whole-file read would cost |
 * | ------------- | -------------------- | --------------------------------- |
 * | faststart     | `ftyp moov mdat`     | the moov is near the front         |
 * | ordinary mp4  | `ftyp mdat moov`     | the moov is AFTER tens of megabytes |
 *
 * So the reader NEVER loads the file. It opens a handle, `stat`s the size, and
 * seeks: it reads the eight-byte header of each TOP-LEVEL box only, jumps over a
 * `mdat` by its declared size, and - once it lands on `moov` - reads that box's
 * own child headers the same way until it finds `mvhd`, of which it keeps the
 * last 32 bytes. A 500 MB clip costs a few dozen bytes of I/O.
 *
 * WHAT IT REFUSES, deliberately, instead of guessing:
 *   - a file that is not ISO BMFF at all (a WebM's EBML magic is not a box
 *     header) -> `MINIMAX_VIDEO_NOT_ISO_BMFF`;
 *   - a box header that runs past the end of its container, or a box smaller
 *     than its own header -> `MINIMAX_VIDEO_NOT_ISO_BMFF`;
 *   - an ISO BMFF file with no `moov`, no `mvhd`, or a `mvhd` too short to hold
 *     its own fields -> `MINIMAX_VIDEO_DURATION_UNREADABLE`;
 *   - a `timescale` of zero (the division has no answer) -> the same code;
 *   - `mvhd`'s documented "unknown duration" sentinels (all bits set) -> the
 *     same code, because reporting a made-up length is worse than refusing.
 *
 * Every refusal is an ERROR, never `undefined`: a caller that silently got no
 * duration would send a reference video with no length, or `null`, and neither
 * is a thing the service asked for.
 *
 * @module dsh-chatgpt-subscription/minimax-code/iso-bmff-duration
 */

import fs from 'node:fs/promises'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Raised when a file's length cannot be read out of its ISO BMFF container.
 *
 * A `HarnessError` subclass rather than a bare `Error`, so the tool layer can
 * hand its `code` straight to the caller without re-wrapping the message.
 */
export class IsoBmffDurationError extends HarnessError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'IsoBmffDurationError'
  }
}

/** Bytes of a box header before its payload: a 32-bit size and a four-letter type. */
const BOX_HEADER_BYTES = 8
/** Bytes of a LARGE box header: `size == 1` moves the size into a 64-bit field. */
const BOX_LARGE_HEADER_BYTES = 16

/**
 * Bytes of one `mvhd` payload that can matter.
 *
 * version 1 is the longer of the two: 4 bytes of version+flags, then 8+8 of
 * creation/modification times, 4 of timescale, and 8 of duration = 32. Version 0
 * needs only the first 20 of those.
 */
const MVHD_MAX_READ_BYTES = 32
/** Shortest version 0 `mvhd` payload that still contains a duration. */
const MVHD_V0_MIN_BYTES = 20
/** Shortest version 1 `mvhd` payload that still contains a duration. */
const MVHD_V1_MIN_BYTES = 32

/**
 * Box types a legitimate ISO BMFF file can START with.
 *
 * This is the "is it even an mp4/mov" test, and it is intentionally a small set
 * of real first boxes rather than "four printable characters": a WebM file's
 * EBML magic, a PNG header and a text file all fail it, which is what makes the
 * refusal trustworthy instead of merely cosmetic. A box type outside this set as
 * the FIRST box means the bytes are not ISO BMFF, and no amount of further
 * walking would find a `moov` in them.
 */
const ISO_BMFF_LEADING_BOX_TYPES: readonly string[] = [
  'ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid',
]

/** One parsed box header. */
interface BoxHeader {
  /** The four-character box type, as ASCII. */
  readonly type: string
  /** Offset of the header's first byte. */
  readonly start: number
  /** Offset of the first payload byte. */
  readonly payloadStart: number
  /** Offset one past the box's last byte. */
  readonly end: number
}

/** Read exactly `length` bytes at `position`, or fewer at end of file. */
type ReadAt = (position: number, length: number) => Promise<Uint8Array>

/** Four bytes as ASCII, whatever they happen to be. */
function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] ?? 0)
  }
  return text
}

/** Whether four bytes look like a box type at all: printable ASCII, no control bytes. */
function isPrintableBoxType(type: string): boolean {
  return type.length === 4 && Array.from(type).every(char => {
    const code = char.charCodeAt(0)
    return code >= 0x20 && code <= 0x7e
  })
}

/** A big-endian reader over one small slice. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Parse one box header at `offset`, bounded by `limit` (end of file, or end of
 * the containing box).
 *
 * The three size spellings ISO BMFF defines are all handled, because real
 * encoders use all three: a plain 32-bit size, `1` meaning "the size is the
 * 64-bit field after the type" (used by boxes over 4 GiB), and `0` meaning
 * "this box runs to the end of its container".
 *
 * @param readAt - position-addressed reader.
 * @param offset - where the header starts.
 * @param limit - one past the last byte this box may occupy.
 * @param what - human name of the container, for the message.
 * @returns the parsed header, with absolute offsets.
 * @throws IsoBmffDurationError when the header is not a valid box header.
 */
async function readBoxHeader(
  readAt: ReadAt,
  offset: number,
  limit: number,
  what: string,
): Promise<BoxHeader> {
  const head = await readAt(offset, BOX_HEADER_BYTES)
  if (head.length < BOX_HEADER_BYTES) {
    throw new IsoBmffDurationError(
      'cannot read the video duration: ' + what + ' ends after only ' + head.length + ' byte(s) at offset '
      + offset + ', which is too short to hold a box header. This file is truncated or is not an mp4/mov '
      + 'container.',
      'MINIMAX_VIDEO_NOT_ISO_BMFF',
    )
  }
  const headView = viewOf(head)
  const declared = headView.getUint32(0)
  const type = asciiAt(head, 4, 4)
  if (!isPrintableBoxType(type)) {
    throw new IsoBmffDurationError(
      'cannot read the video duration: the four bytes at offset ' + (offset + 4) + ' of ' + what + ' are not a '
      + 'box type (' + JSON.stringify(type) + '), so this is not an ISO BMFF (mp4/mov) file and it has no '
      + 'moov/mvhd to read a length from.',
      'MINIMAX_VIDEO_NOT_ISO_BMFF',
    )
  }

  let payloadStart = offset + BOX_HEADER_BYTES
  let boxEnd: number
  if (declared === 1) {
    const large = await readAt(offset + BOX_HEADER_BYTES, 8)
    if (large.length < 8) {
      throw new IsoBmffDurationError(
        'cannot read the video duration: the large-size box "' + type + '" at offset ' + offset + ' of ' + what
        + ' declares a 64-bit size but the file ends before that field does.',
        'MINIMAX_VIDEO_NOT_ISO_BMFF',
      )
    }
    payloadStart = offset + BOX_LARGE_HEADER_BYTES
    boxEnd = offset + Number(viewOf(large).getBigUint64(0))
  } else if (declared === 0) {
    // "Runs to the end of the container" - legal only for the last box.
    boxEnd = limit
  } else {
    boxEnd = offset + declared
  }

  if (boxEnd < payloadStart) {
    throw new IsoBmffDurationError(
      'cannot read the video duration: the box "' + type + '" at offset ' + offset + ' of ' + what + ' declares a '
      + 'size of ' + (boxEnd - offset) + ' byte(s), which is smaller than its own header. The container is corrupt.',
      'MINIMAX_VIDEO_NOT_ISO_BMFF',
    )
  }
  if (boxEnd > limit) {
    throw new IsoBmffDurationError(
      'cannot read the video duration: the box "' + type + '" at offset ' + offset + ' of ' + what + ' declares '
      + 'that it ends at ' + boxEnd + ', past the end of the container at ' + limit + '. This file is truncated.',
      'MINIMAX_VIDEO_NOT_ISO_BMFF',
    )
  }
  return { type, start: offset, payloadStart, end: boxEnd }
}

/**
 * Read the duration in seconds out of one `mvhd` payload.
 *
 * THE TWO VERSIONS, and why both are needed: version 0 stores 32-bit
 * `timescale`/`duration` and version 1 stores 64-bit ones, at different offsets,
 * and both spellings appear in the wild (version 1 for anything whose internal
 * clock would overflow 32 bits). Reading a version 1 payload as version 0 yields
 * a plausible-looking but wrong number, so the version byte is checked rather
 * than assumed.
 *
 * @param payload - the first {@link MVHD_MAX_READ_BYTES} bytes of the box.
 * @returns `duration / timescale` in seconds.
 * @throws IsoBmffDurationError for a truncated payload, an unknown version, a
 *   zero timescale, or the "unknown duration" sentinel.
 */
function durationFromMvhd(payload: Uint8Array): number {
  if (payload.length === 0) {
    throw new IsoBmffDurationError(
      'cannot read the video duration: the mvhd box is empty.',
      'MINIMAX_VIDEO_DURATION_UNREADABLE',
    )
  }
  const view = viewOf(payload)
  const version = payload[0] ?? 0
  let timescale: number
  let duration: number
  if (version === 0) {
    if (payload.length < MVHD_V0_MIN_BYTES) {
      throw new IsoBmffDurationError(
        'cannot read the video duration: the version 0 mvhd payload is ' + payload.length + ' byte(s), and it '
        + 'needs at least ' + MVHD_V0_MIN_BYTES + ' to reach the timescale and duration fields.',
        'MINIMAX_VIDEO_DURATION_UNREADABLE',
      )
    }
    timescale = view.getUint32(12)
    duration = view.getUint32(16)
    // All bits set is the format's "unknown" sentinel, not a real length.
    if (duration === 0xffffffff) {
      throw new IsoBmffDurationError(
        'cannot read the video duration: the mvhd box records its duration as 0xFFFFFFFF, which ISO BMFF defines '
        + 'as "unknown". The file plays, but the container does not state how long it is.',
        'MINIMAX_VIDEO_DURATION_UNREADABLE',
      )
    }
  } else if (version === 1) {
    if (payload.length < MVHD_V1_MIN_BYTES) {
      throw new IsoBmffDurationError(
        'cannot read the video duration: the version 1 mvhd payload is ' + payload.length + ' byte(s), and it '
        + 'needs at least ' + MVHD_V1_MIN_BYTES + ' to reach the 64-bit timescale and duration fields.',
        'MINIMAX_VIDEO_DURATION_UNREADABLE',
      )
    }
    timescale = view.getUint32(20)
    const wide = view.getBigUint64(24)
    if (wide === 0xffffffffffffffffn) {
      throw new IsoBmffDurationError(
        'cannot read the video duration: the version 1 mvhd box records its duration as all-ones, which ISO BMFF '
        + 'defines as "unknown". The file plays, but the container does not state how long it is.',
        'MINIMAX_VIDEO_DURATION_UNREADABLE',
      )
    }
    // A duration this large is already beyond every limit this route applies to
    // a reference clip; Number() is exact enough for the seconds it divides into.
    duration = Number(wide)
  } else {
    throw new IsoBmffDurationError(
      'cannot read the video duration: the mvhd box declares version ' + version + ', and only versions 0 and 1 '
      + 'define where the timescale and duration fields sit. Nothing is guessed here, because reading a version '
      + '1 payload with version 0 offsets yields a plausible but wrong length.',
      'MINIMAX_VIDEO_DURATION_UNREADABLE',
    )
  }
  if (timescale === 0) {
    throw new IsoBmffDurationError(
      'cannot read the video duration: the mvhd box declares a timescale of 0, so its duration field cannot be '
      + 'converted into seconds.',
      'MINIMAX_VIDEO_DURATION_UNREADABLE',
    )
  }
  return duration / timescale
}

/**
 * Read one mp4/mov file's length in seconds, without decoding a frame.
 *
 * The walk, in full:
 *
 * 1. `stat` the file - the size is the only bound needed, and nothing is read
 *    before it is known.
 * 2. From offset 0, read each TOP-LEVEL box header and jump to the next one, so
 *    an `mdat` is skipped by arithmetic rather than by reading it. The first box
 *    must be one of {@link ISO_BMFF_LEADING_BOX_TYPES}, which is where a
 *    non-mp4 file is caught.
 * 3. On `moov`, walk ITS direct children the same way until `mvhd` appears. A
 *    `trak` is skipped by size, exactly like `mdat`.
 * 4. Read the first {@link MVHD_MAX_READ_BYTES} bytes of `mvhd` and divide
 *    `duration` by `timescale`.
 *
 * Both measured layouts work for the same reason: the walk is driven by the
 * sizes the boxes declare, so it does not care whether `moov` came before or
 * after the media data. Faststart files find it on the first or second hop; a
 * camera/encoder file finds it after one seek over the entire `mdat`.
 *
 * @param filePath - absolute path to the file to read.
 * @returns the clip length in seconds, as an exact ratio.
 * @throws IsoBmffDurationError (a `HarnessError`) whenever the length cannot be
 *   established - a missing file, a non-ISO-BMFF file, a truncated box, a
 *   missing `moov`/`mvhd`, an unreadable `mvhd`, or a zero timescale.
 */
export async function readIsoBmffDurationSeconds(filePath: string): Promise<number> {
  const handle = await fs.open(filePath, 'r').catch((error: unknown) => {
    throw new IsoBmffDurationError(
      'cannot read the video duration: ' + filePath + ' could not be opened ('
      + (error instanceof Error ? error.message : String(error)) + ').',
      'MINIMAX_VIDEO_MEDIA_NOT_FOUND',
    )
  })
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new IsoBmffDurationError(
        'cannot read the video duration: ' + filePath + ' is not a regular file.',
        'MINIMAX_VIDEO_MEDIA_NOT_FOUND',
      )
    }
    const fileSize = stats.size
    /**
     * Positioned read: this is the "seek" the whole module is built around.
     * `handle.read` fills at most `length` bytes from `position` and may come
     * back short at end of file, so the loop below only ever returns what really
     * exists.
     */
    const readAt: ReadAt = async (position, length) => {
      const buffer = new Uint8Array(Math.max(0, length))
      let filled = 0
      while (filled < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, position + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return buffer.subarray(0, filled)
    }

    let sawLeadingBox = false
    for (let offset = 0; offset < fileSize;) {
      if (fileSize - offset < BOX_HEADER_BYTES) break
      const box = await readBoxHeader(readAt, offset, fileSize, 'the file')
      if (!sawLeadingBox) {
        sawLeadingBox = true
        if (!ISO_BMFF_LEADING_BOX_TYPES.includes(box.type)) {
          throw new IsoBmffDurationError(
            'cannot read the video duration: ' + filePath + ' starts with the box "' + box.type + '", which is not '
            + 'a box an mp4/mov file begins with (expected one of '
            + ISO_BMFF_LEADING_BOX_TYPES.join(', ') + '). This is not an ISO BMFF container, so it has no '
            + 'moov/mvhd to read a length from.',
            'MINIMAX_VIDEO_NOT_ISO_BMFF',
          )
        }
      }
      if (box.type === 'moov') {
        // The moov is in hand: walk its direct children for mvhd. Everything
        // else (trak, udta, iods, meta) is skipped by its declared size, so a
        // file with several hundred frames of sample tables costs nothing.
        for (let child = box.payloadStart; child < box.end;) {
          if (box.end - child < BOX_HEADER_BYTES) break
          const entry = await readBoxHeader(readAt, child, box.end, 'the moov box')
          if (entry.type === 'mvhd') {
            const available = entry.end - entry.payloadStart
            const wanted = Math.min(MVHD_MAX_READ_BYTES, available)
            return durationFromMvhd(await readAt(entry.payloadStart, wanted))
          }
          child = entry.end
        }
        throw new IsoBmffDurationError(
          'cannot read the video duration: ' + filePath + ' has a moov box with no mvhd child, so the container '
          + 'states no length. Nothing is inferred from the sample tables: this reader answers from mvhd only.',
          'MINIMAX_VIDEO_DURATION_UNREADABLE',
        )
      }
      offset = box.end
    }

    throw new IsoBmffDurationError(
      'cannot read the video duration: ' + filePath + (sawLeadingBox ? ' has no moov box' : ' is empty')
      + ', so the container states no length. A file that is still being written, or one whose moov was '
      + 'truncated off, looks exactly like this.',
      'MINIMAX_VIDEO_DURATION_UNREADABLE',
    )
  } finally {
    await handle.close().catch(() => undefined)
  }
}
