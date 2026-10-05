/**
 * Kimi Code's video vocabulary, re-exported from the shared video modules.
 *
 * The traversal, byte budgeting and base64 encoding live in
 * `../common/video-request.ts` now that a second line accepts video too; a
 * second copy of the module augmentation would be a conflicting redeclaration
 * of the same `video` key.
 *
 * What stays here is the part that is genuinely Kimi's: the models that take
 * video, and the wording used when one cannot be sent.
 */

import { VIDEO_MEDIA_TYPES, type VideoOmissionReason } from '../common/video.ts'

export {
  VIDEO_MEDIA_TYPES,
  base64LengthOf,
  formatMediaBytes,
  isVideoMediaType,
  videoBlockLabel,
  videoDataUrl,
  type VideoAttachmentRef,
  type VideoBlock,
  type VideoOmissionReason,
} from '../common/video.ts'

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
      return '[video omitted: ' + subject + ' cannot be sent because the selected Kimi model does not accept video input; switch to k3 or kimi-for-coding, or ask the user to describe the video.]'
    case 'unsupported-container':
      return '[video omitted: ' + subject + ' uses a container the Kimi coding endpoint does not accept; supported formats are ' + VIDEO_MEDIA_TYPES.join(', ') + '.]'
    case 'unreadable':
      return '[video omitted: ' + subject + ' could not be read from storage; ask the user to attach it again if its contents are needed.]'
    case 'unsupported-wire':
      return '[video omitted: ' + subject + ' cannot be sent because the selected Kimi model is served over the Anthropic Messages protocol, which does not document a video content part. Kimi video input is an OpenAI-surface feature; switch the model to one served over the OpenAI-compatible surface, or ask the user to describe the video.]'
  }
}

