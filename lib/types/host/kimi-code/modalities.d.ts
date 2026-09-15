/**
 * Kimi Code's extra request modalities, declared into DSH's provider-neutral
 * vocabularies by this plugin alone.
 *
 * DSH ships ModelModalityMap = { text, image } and a ContentBlockMap with no
 * video entry, but both are merge-extensible interfaces: a plugin may widen
 * them with a TypeScript module augmentation. That is what this file does, so
 * Kimi's documented video_in capability can travel through DSH's real
 * capability pipeline - the same one that gates read_image, prompt admission,
 * and subagent delegation - instead of being display-only trivia in a tooltip.
 *
 * Nothing here modifies DSH. The augmentation lives in this plugin's
 * compilation unit; DSH's own sources keep compiling against the two
 * modalities they already know.
 *
 * The block shape deliberately mirrors ImageAttachmentRef field for field.
 * DSH itself never constructs a video block - the attachment service only
 * promotes images - so the only readers are this plugin's request mapper and
 * its tests.
 */
/**
 * Container formats the Kimi coding endpoint accepts as video input.
 *
 * Transcribed from the official vision guide and file-upload reference; the
 * service validates the media type, so an unlisted container is reported
 * before it is base64-expanded into a request that would be rejected.
 */
export declare const KIMI_VIDEO_MEDIA_TYPES: readonly string[];
/** Runtime membership test for one video container. */
export declare function isVideoMediaType(mediaType: string): boolean;
/**
 * One durable video reference carried by a request.
 *
 * attachmentId is a plain string rather than DSH's branded AttachmentId: no
 * DSH service issues this identifier, so branding it would imply an origin
 * that does not exist. The field name matches ImageAttachmentRef so one
 * traversal helper can walk both block kinds.
 */
export interface VideoAttachmentRef {
    attachmentId: string;
    /** Verified media type, for example video/mp4. */
    mediaType: string;
    /** Exact encoded byte length. */
    bytes: number;
    /** Intrinsic duration in milliseconds, when the producer knows it. */
    durationMs?: number;
    /** Optional display name, stripped of any local path. */
    name?: string;
}
/** One video occurrence in message content. */
export interface VideoBlock {
    type: 'video';
    attachment: VideoAttachmentRef;
}
declare module '@deepseek-ai/dsh-llm' {
    interface ModelModalityMap {
        /** Widened by this plugin: Kimi's k3 and kimi-for-coding accept video. */
        video: 'video';
    }
    interface ContentBlockMap {
        /** Widened by this plugin; only the Kimi Code mapper reads it. */
        video: VideoBlock;
    }
}
/** Base64 length of raw bytes, including padding. */
export declare function base64LengthOf(bytes: number): number;
/** Canonical data URL the OpenAI-compatible video part carries. */
export declare function videoDataUrl(mediaType: string, base64: string): string;
/**
 * Human-readable byte size for a refusal message.
 * @param bytes - exact encoded byte length.
 */
export declare function formatMediaBytes(bytes: number): string;
/** Why one video occurrence was replaced by text instead of being sent. */
export type VideoOmissionReason = 'unsupported-model' | 'unreadable' | 'unsupported-container'
/** The selected protocol has no documented video part, so none is sent. */
 | 'unsupported-wire';
/**
 * Deterministic text standing in for a video the request cannot carry.
 *
 * The model is told the video existed and why it is absent, so it asks for a
 * description instead of answering as though the message were empty.
 * @param reason - why the occurrence was omitted.
 * @param label - display name or attachment id, when known.
 */
export declare function videoOmissionText(reason: VideoOmissionReason, label?: string): string;
/** Attachment id or display name for one block, whichever is present. */
export declare function videoBlockLabel(block: {
    attachment?: {
        name?: string;
        attachmentId?: string;
    };
}): string | undefined;
//# sourceMappingURL=modalities.d.ts.map