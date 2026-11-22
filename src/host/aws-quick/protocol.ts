import { randomUUID } from 'node:crypto'
import { EventStreamCodec } from '@smithy/eventstream-codec'
import type { AwsQuickEffort, AwsQuickMode } from '../../shared/aws-quick-contracts.ts'
import type { QuickImageAttachment } from './images.ts'

export const QUICK_CHAT_WS_PATH = '/streaming/quickwork-chat-bidirectional-stream'
export const QUICK_DESKTOP_SURFACE = process.platform === 'win32' ? 'QUICK_WORK_DESKTOP_WINDOWS' : 'QUICK_WORK_DESKTOP_MAC'
export const QUICK_DSH_TOOL_POLICY = 'This turn uses DeepSeek Harness (DSH). Prefer tools exposed by the DeepSeek Harness connector for coding, shell, repository and filesystem work. Quick load_skill/load_tools may be used for discovery. Keep every tool call subject to the normal DSH and Quick permission rules. If a required DSH tool is unavailable, report that capability clearly.'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
// Current Smithy types name these toUtf8/fromUtf8 but declare bytes→string first.
const eventCodec = new EventStreamCodec((value) => decoder.decode(value), (value) => encoder.encode(value))

export interface QuickWireEvent { type?: string; payload?: Record<string, unknown>; thread_id?: string; message_id?: string; [key: string]: unknown }
export function encodeQuickInput(value: unknown): Uint8Array {
  const inner = JSON.stringify(value)
  return encoder.encode(JSON.stringify({ eventType: 'rawInputEvent', payload: { payload: Buffer.from(inner, 'utf8').toString('base64') } }))
}
function header(message: { headers: Record<string, { type: string; value: unknown }> }, name: string): string {
  const value = message.headers[name]
  return value?.type === 'string' && typeof value.value === 'string' ? value.value : ''
}
export function decodeQuickOutput(data: ArrayBuffer | Uint8Array): QuickWireEvent | null {
  const message = eventCodec.decode(data instanceof Uint8Array ? data : new Uint8Array(data))
  const messageType = header(message, ':message-type')
  if (messageType === 'error' || messageType === 'exception') {
    const code = header(message, ':error-code') || header(message, ':exception-type') || messageType
    const detail = header(message, ':error-message') || decoder.decode(message.body)
    throw new Error(`AWS Quick stream error [${code}]: ${detail || 'unknown error'}`)
  }
  if (header(message, ':event-type') !== 'rawOutputEvent' || message.body.byteLength === 0) return null
  const outer = JSON.parse(decoder.decode(message.body)) as { payload?: unknown }
  if (typeof outer.payload !== 'string') return null
  return JSON.parse(Buffer.from(outer.payload, 'base64').toString('utf8')) as QuickWireEvent
}
export function quickSessionConnect(actorArn: string | undefined,outpostId?:string,appVersion?:string): unknown {
  return { type: 'session_connect', payload: { actor_id: actorArn, surfaceType: QUICK_DESKTOP_SURFACE, outpostId, appVersion, acp_first_text: 1, user_notification: 1, subtask_progress: 1, self_registering_connectors: 1, external_agent_sign_in: 1, recents_promotion: 1 } }
}
export function quickUserMessage(input: {
  text: string; threadId: string; messageId?: string; traceId?: string; mode: AwsQuickMode; effort?: AwsQuickEffort; preApprovedTools?: string[]; invokingOutpostId?:string; appVersion?:string; attachments?:QuickImageAttachment[]; customPrompt?:string; userLocale?: string; userTimezone?: string
}): unknown {
  return {
    type: 'user_message',
    payload: {
      text: input.text,
      attachments: input.attachments?.length?input.attachments:undefined,
      surfaceType: QUICK_DESKTOP_SURFACE,
      outpostId: input.invokingOutpostId,
      appVersion: input.appVersion,
      acp_first_text: 1,
      user_notification: 1,
      subtask_progress: 1,
      self_registering_connectors: 1,
      external_agent_sign_in: 1,
      recents_promotion: 1,
      message_id: input.messageId ?? randomUUID(),
      thread_id: input.threadId,
      traceId: input.traceId ?? randomUUID(),
      agent_mode: input.mode,
      thinking_effort: input.effort,
      auto_routing: false,
      web_search_enabled: false,
      chat_agent_id: null,
      custom_prompt: input.customPrompt,
      direct_chat: false,
      pre_approved_tools: input.preApprovedTools,
      invokingOutpostId: input.invokingOutpostId,
      user_locale: input.userLocale ?? 'zh-CN',
      user_timezone: input.userTimezone ?? 'UTC',
      send_origin: 'programmatic',
      voice_mode: false,
    },
  }
}
export function unwrapQuickToolArguments(value: unknown): string {
  let parsed=value
  if(typeof parsed==='string'){try{parsed=JSON.parse(parsed)}catch{return typeof parsed==='string'?parsed:String(parsed)}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return JSON.stringify(parsed??{})
  const record=parsed as Record<string,unknown>
  const params=record.params&&typeof record.params==='object'&&!Array.isArray(record.params)?record.params as Record<string,unknown>:undefined
  const unwrapped=params?.arguments&&typeof params.arguments==='object'?params.arguments:record.arguments&&typeof record.arguments==='object'?record.arguments:parsed
  return JSON.stringify(unwrapped)
}
export function quickStopGeneration(threadId: string, assistantMessageId: string): unknown {
  return { type: 'stop_generation', payload: { message_id: assistantMessageId, thread_id: threadId } }
}
export function isQuickChatHost(host: string): boolean {
  if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..')) return false
  return ['.plato.ai.aws.dev', '.enterprise.quick.aws.com', '.enterprise.quick.aws.dev', '.desktop.quick.aws.dev'].some((suffix) => host.endsWith(suffix))
}
