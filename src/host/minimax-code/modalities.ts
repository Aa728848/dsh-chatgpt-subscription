/**
 * MiniMax Code's video vocabulary.
 *
 * The block type, the module augmentation and the media-type list are shared
 * with the Kimi Code line in `../common/video.ts`; only the wording is this
 * line's, because the models that accept video, and the byte budget the endpoint
 * tolerates, are MiniMax's facts.
 */

import { VIDEO_MEDIA_TYPES, type VideoOmissionReason } from '../common/video.ts'

export { VIDEO_MEDIA_TYPES, type VideoOmissionReason }

/**
 * Deterministic text standing in for a video the request cannot carry.
 *
 * The model is told the video existed and why it is absent, so it asks for a
 * description instead of answering as though the message were empty.
 * @param reason - why the occurrence was omitted.
 * @param label - display name or attachment id, when known.
 */
export function videoOmissionText(reason: VideoOmissionReason, label?: string): string {
  const subject = label === undefined || label === '' ? 'the attached video' : label
  switch (reason) {
    case 'unsupported-model':
      return '[video omitted: ' + subject + ' cannot be sent because the selected MiniMax model does not accept video input; switch to MiniMax-M3 or MiniMax-M3.1-Flash-Preview, or ask the user to describe the video.]'
    case 'unsupported-container':
      return '[video omitted: ' + subject + ' uses a container the MiniMax coding endpoint does not accept; supported formats are ' + VIDEO_MEDIA_TYPES.join(', ') + '.]'
    case 'unreadable':
      return '[video omitted: ' + subject + ' could not be read from storage; ask the user to attach it again if its contents are needed.]'
    case 'unsupported-wire':
      return '[video omitted: ' + subject + ' cannot be sent on the Anthropic Messages protocol, which documents no video content part. MiniMax video input is an OpenAI-surface feature; ask the user to describe the video.]'
  }
}
