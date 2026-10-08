/**
 * WS-7 extraction (zero requests): rebuild the model-visible message list that
 * turn 18 of the historical session actually sent, step by step.
 *
 * Turn 18 is the trajectory whose step 6 collapsed to a single blank
 * reasoning byte. This script reconstructs the request context for each of its
 * 16 model turns from the on-disk session log, so the replay can send the very
 * same context with the plugin's own buildChatRequest().
 *
 * Only model-visible content is taken. surfaceOp / interrupted / usage / stream
 * and every other metadata field is dropped: they were never message content.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

const ZSTD_MAGIC = 0xFD2FB528
function scanZstdFrames(buffer) {
  const frames = []; let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad zstd magic at ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const d = buffer.readUInt8(offset); offset += 1
    if ((d & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const csf = d >>> 6, ss = (d & 0x20) !== 0, ck = (d & 0x04) !== 0
    const df = d & 0x03, db = df === 3 ? 4 : df
    const csb = csf === 0 ? (ss ? 1 : 0) : (1 << csf)
    offset += (ss ? 0 : 1) + db + csb
    for (;;) {
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 0x03, bs = bh >>> 3
      if (bt === 0x03) throw new Error('reserved block type')
      const pb = bt === 0x01 ? 1 : bs
      offset += pb
      if (last) break
    }
    if (ck) offset += 4
    frames.push({ start, end: offset })
  }
  return { frames }
}
export function readSession(file) {
  const buf = fs.readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buf)
  const parts = []
  for (const fr of frames) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8')) } catch {}
  }
  const events = []
  let lineNo = 0
  for (const line of parts.join('').split('\n')) {
    if (!line.trim()) continue
    lineNo++
    try { events.push({ lineNo, raw: line, obj: JSON.parse(line) }) }
    catch { events.push({ lineNo, raw: line, obj: null }) }
  }
  return { file, frames: frames.length, tornStart, events, text: parts.join('') }
}

export const REDACT = (s) => String(s)
  .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=\-]{8,}/gi, '$1<redacted>')
  .replace(/("(?:access_?token|refresh_?token|id_?token|token|cookie|authorization|password|secret|api_?key|sk-)"\s*:\s*")[^"]{4,}(")/gi, '$1<redacted>$2')

export const FILE = 'C:/Users/A/.dsh/sessions/--C-Users-A-Documents-ChatGPT-dsh-chatgpt-subscription--/session-cda91ba2-2d01-4ffa-8ffe-1c60af1f92b3/session.v4.jsonl.zstd'

/** Text of one content-block list, mirroring mapper.ts textOf(). */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-result') parts.push(textOf(block.content))
  }
  return parts.join('')
}

/**
 * One model-visible message in the harness's own Message shape: exactly what
 * buildChatRequest() consumes. Reasoning is deliberately absent, matching
 * openAIAssistantContent() which never replays a thinking block.
 */
function projectUserMessage(content) {
  const blocks = []
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      // The one image in this history has no resolvable attachment on a
      // standalone replay; mapper would emit an [image: ...] placeholder for
      // an unresolvable block anyway.
      blocks.push({ type: 'text', text: '[image: attached image]' })
    }
  }
  if (blocks.length === 0) return null
  return { role: 'user', content: blocks, source: { kind: 'user' } }
}

function projectAssistantMessage(message) {
  const content = []
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
    else if (block.type === 'tool-call' && typeof block.name === 'string') {
      content.push({ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments })
    }
    // reasoning: never replayed
  }
  if (content.length === 0) return null
  return { role: 'assistant', content, source: { kind: 'model' } }
}

function projectToolResultMessage(message) {
  const text = textOf(message.content)
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: message.toolCallId ?? '', content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId: message.toolCallId ?? '' },
  }
}

/**
 * Walk the log in seq order and build the running model-visible message list,
 * snapshotting it immediately BEFORE each of turn 18's 16 model turns.
 */
export function extractTurn18() {
  const s = readSession(FILE)
  const events = s.events.filter((e) => e.obj && typeof e.obj.seq === 'number').sort((a, b) => a.obj.seq - b.obj.seq)

  // The workbuddy request header: exact config + the exact tools array.
  let header = null
  for (const e of events) {
    if (e.obj.type === 'request/header' && e.obj.data?.header?.config?.provider === 'workbuddy-subscription') header = e.obj.data.header
  }
  if (!header) throw new Error('no workbuddy request/header found')

  // turn/start seq for turn 18, and its system message.
  const turn18Start = events.find((e) => e.obj.type === 'turn/start' && e.obj.data?.turn === 18)
  if (!turn18Start) throw new Error('no turn/start for turn 18')
  const turn18Seq = turn18Start.obj.seq

  let systemMessages = []
  const messages = []          // running conversation, system excluded
  const steps = []
  const seen = new Set()       // assistant seqs already captured

  for (const e of events) {
    const o = e.obj
    const d = o.data || {}
    if (o.type === 'system/message') {
      const t = textOf(d.message?.content)
      // Honor surfaceOp: turn 18's system/message carries
      // {op:'replace', startSeq:8, endSeq:8}, so it SUPERSEDES turn 1's system
      // message instead of joining it. Concatenating both would ship a system
      // prompt twice the size the product actually sent.
      const sop = o.surfaceOp
      if (sop && typeof sop === 'object' && sop.op === 'replace') {
        const lo = typeof sop.startSeq === 'number' ? sop.startSeq : -Infinity
        const hi = typeof sop.endSeq === 'number' ? sop.endSeq : Infinity
        systemMessages = systemMessages.filter((entry) => entry.seq < lo || entry.seq > hi)
      }
      if (t !== '') systemMessages.push({ seq: o.seq, role: 'system', content: [{ type: 'text', text: t }] })
      continue
    }
    if (o.type === 'user/message') {
      const m = projectUserMessage(d.content)
      if (m) messages.push(m)
      continue
    }
    if (o.type === 'tool/result') {
      messages.push(projectToolResultMessage(d.message || {}))
      continue
    }
    if (o.type !== 'assistant/message') continue

    // Every turn's assistant turn joins the context -- a tool message is only
    // meaningful after the assistant message that requested it -- but only
    // turn 18's turns get a snapshot.
    if (d.turn === 18 && o.seq >= turn18Seq) {
    // Snapshot the context that was sent for this model turn.
    steps.push({
      step: d.step,
      seq: o.seq,
      context: messages.slice(),
      systemMessages: systemMessages.map((entry) => entry.content[0].text),
      historical: {
        usage: d.usage ?? null,
        reasoningBytes: (d.message?.content || []).filter((b) => b.type === 'reasoning').map((b) => Buffer.byteLength(b.text || '')),
        reasoningTexts: (d.message?.content || []).filter((b) => b.type === 'reasoning').map((b) => b.text || ''),
        textBytes: (d.message?.content || []).filter((b) => b.type === 'text').map((b) => Buffer.byteLength(b.text || '')),
        toolCalls: (d.message?.content || []).filter((b) => b.type === 'tool-call').map((b) => ({ name: b.name, argsBytes: Buffer.byteLength(b.arguments || '') })),
        finishReason: (d.stream || []).find((it) => it.type === 'chunk' && it.chunk?.type === 'finish')?.chunk?.reason ?? null,
      },
    })
    }

    const m = projectAssistantMessage(d.message || {})
    if (m) messages.push(m)
  }

  return { header, steps }
}

if (import.meta.url === 'file:///' + path.resolve(process.argv[1] || '').replace(/\\/g, '/')) {
  const { header, steps } = extractTurn18()
  console.log('header config: ' + JSON.stringify(header.config))
  console.log('tools: ' + header.tools.map((t) => t.name).join(','))
  console.log('steps extracted: ' + steps.length)
  for (const s of steps) {
    const ctxBytes = Buffer.byteLength(JSON.stringify(s.context))
    const sysBytes = s.systemMessages.reduce((a, t) => a + Buffer.byteLength(t), 0)
    const roles = s.context.map((m) => m.role)
    console.log(
      'step ' + String(s.step).padStart(2)
      + ' | ctxMsgs=' + String(s.context.length).padStart(4)
      + ' ctxBytes=' + String(ctxBytes).padStart(8)
      + ' sysBytes=' + String(sysBytes).padStart(6)
      + ' | roles=' + roles.slice(-8).join('>')
      + ' | histRsn=' + JSON.stringify(s.historical.reasoningBytes)
      + ' rTok=' + (s.historical.usage?.reasoningTokens ?? '-')
      + ' prompt=' + ((s.historical.usage?.inputTokens ?? 0) + (s.historical.usage?.cacheReadTokens ?? 0)),
    )
  }
}
