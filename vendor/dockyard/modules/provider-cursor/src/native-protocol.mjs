import { createHash, randomUUID } from "node:crypto";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function encodeVarint(value) {
  let current = BigInt(Math.max(0, Number(value) || 0));
  const result = [];
  while (current >= 0x80n) {
    result.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  result.push(Number(current));
  return Uint8Array.from(result);
}

function fieldKey(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

export function bytesField(field, value) {
  const bytes = typeof value === "string"
    ? textEncoder.encode(value)
    : value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  return concatBytes([fieldKey(field, 2), encodeVarint(bytes.byteLength), bytes]);
}

export function stringField(field, value) {
  return bytesField(field, textEncoder.encode(String(value ?? "")));
}

export function varintField(field, value) {
  return concatBytes([fieldKey(field, 0), encodeVarint(value)]);
}

export function frameConnectMessage(message, flags = 0) {
  const payload = message instanceof Uint8Array ? message : Uint8Array.from(message ?? []);
  const header = new Uint8Array(5);
  header[0] = flags & 0xff;
  new DataView(header.buffer).setUint32(1, payload.byteLength, false);
  return concatBytes([header, payload]);
}

export function decodeProtoFields(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  const fields = [];
  let offset = 0;
  while (offset < value.length) {
    const key = readVarint(value, offset);
    if (!key) break;
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (wireType === 0) {
      const parsed = readVarint(value, offset);
      if (!parsed) break;
      offset = parsed.offset;
      fields.push({ field, wireType, value: Number(parsed.value) });
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > value.length) break;
      fields.push({ field, wireType, value: value.slice(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(value, offset);
      if (!length) break;
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > value.length) break;
      fields.push({ field, wireType, value: value.slice(offset, end) });
      offset = end;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > value.length) break;
      fields.push({ field, wireType, value: value.slice(offset, offset + 4) });
      offset += 4;
      continue;
    }
    break;
  }
  return fields;
}

function readVarint(bytes, start) {
  let offset = start;
  let value = 0n;
  let shift = 0n;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  return null;
}

function firstBytes(fields, field) {
  return fields.find((entry) => entry.field === field && entry.wireType === 2)?.value ?? null;
}

function firstString(fields, field) {
  const bytes = firstBytes(fields, field);
  return bytes ? textDecoder.decode(bytes) : "";
}

function sha256(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function putBlob(store, value) {
  const bytes = value instanceof Uint8Array ? value : textEncoder.encode(String(value));
  const id = sha256(bytes);
  store.set(Buffer.from(id).toString("hex"), bytes);
  return id;
}

function jsonBlob(store, value) {
  return putBlob(store, textEncoder.encode(JSON.stringify(value)));
}

function normalizeText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(normalizeText).filter(Boolean).join("");
  if (!content || typeof content !== "object") return "";
  if (content.type === "image") return "[image attachment]";
  if (content.type === "tool-result" || content.type === "tool_result") {
    return `[Tool Result]\n${normalizeText(content.content ?? content.output ?? content.result ?? content.text)}`;
  }
  if (content.type === "tool-call" || content.type === "tool_call") {
    return `[Tool Call ${content.name ?? "tool"}] ${content.arguments ?? "{}"}`;
  }
  return String(content.text ?? content.value ?? content.content ?? content.delta ?? "");
}

function normalizedMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: String(message?.role ?? "user"),
      content: normalizeText(message?.content ?? message?.text).trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function encodeUserMessage(text, messageId, mode = 1) {
  return concatBytes([stringField(1, text), stringField(2, messageId), varintField(4, mode)]);
}

function encodeAssistantStep(text) {
  const assistantMessage = stringField(1, text);
  const conversationStep = bytesField(1, assistantMessage);
  return conversationStep;
}

function encodeConversationTurn(userMessageId, stepIds, requestId) {
  return concatBytes([
    bytesField(1, userMessageId),
    ...stepIds.map((id) => bytesField(2, id)),
    ...(requestId ? [stringField(3, requestId)] : []),
  ]);
}

function encodeConversationState(messages, blobStore, requestId) {
  const roots = [];
  const turns = [];
  const turnRecords = [];
  for (const message of messages) {
    if (message.role === "system") {
      roots.push(jsonBlob(blobStore, { role: "system", content: message.content }));
      continue;
    }
    if (message.role === "user") {
      const userMessage = { role: "user", content: [{ type: "text", text: message.content }] };
      roots.push(jsonBlob(blobStore, userMessage));
      turnRecords.push({ text: message.content, steps: [] });
      continue;
    }
    if (message.role === "assistant") {
      roots.push(jsonBlob(blobStore, { role: "assistant", content: [{ type: "text", text: message.content }] }));
      turnRecords.at(-1)?.steps.push(putBlob(blobStore, encodeAssistantStep(message.content)));
      continue;
    }
    const resultText = `[Tool Result]\n${message.content}`;
    roots.push(jsonBlob(blobStore, { role: "user", content: [{ type: "text", text: resultText }] }));
    turnRecords.at(-1)?.steps.push(putBlob(blobStore, encodeAssistantStep(resultText)));
  }
  for (const record of turnRecords.slice(0, -1)) {
    const userMessageId = putBlob(blobStore, encodeUserMessage(record.text, randomUUID()));
    const turn = encodeConversationTurn(userMessageId, record.steps, requestId);
    turns.push(putBlob(blobStore, turn));
  }
  return concatBytes([
    ...roots.map((id) => bytesField(1, id)),
    ...turns.map((id) => bytesField(8, id)),
  ]);
}

function encodeRequestContext(timeZone = "UTC") {
  const env = stringField(10, timeZone);
  const requestContext = bytesField(4, env);
  return bytesField(2, requestContext);
}

function encodeModelDetails(model) {
  return concatBytes([
    stringField(1, model),
    stringField(3, model),
    stringField(4, model),
    stringField(5, model),
  ]);
}

function encodeMcpTools(tools) {
  const supported = (Array.isArray(tools) ? tools : []).map((tool) => {
    const name = String(tool?.name ?? tool?.function?.name ?? "").trim();
    if (!name) return null;
    const fn = tool?.function ?? tool;
    const definition = concatBytes([
      stringField(1, name),
      stringField(4, "opencodex-responses"),
      stringField(5, name),
      stringField(2, fn?.description ?? ""),
      // Cursor accepts a protobuf Value. A JSON string is intentionally not
      // sent here; unsupported schemas are omitted so the Agent turn does not
      // enter the heartbeat-only state caused by an invalid Value payload.
    ]);
    return bytesField(1, definition);
  }).filter(Boolean);
  return concatBytes(supported);
}

/** Build an AgentService Run request and retain the blobs for KV responses. */
export function encodeAgentRunRequest({
  messages,
  model,
  requestId = randomUUID(),
  conversationId = requestId,
  tools = [],
  timeZone = "UTC",
} = {}) {
  const normalized = normalizedMessages(messages);
  const blobStore = new Map();
  const latestUserIndex = normalized.map((message) => message.role).lastIndexOf("user");
  const latestUserText = latestUserIndex >= 0 ? normalized[latestUserIndex].content : normalized.at(-1)?.content ?? "Continue the conversation.";
  const priorConversation = latestUserIndex > 0
    ? normalized.slice(0, latestUserIndex)
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
      .join("\n\n")
    : "";
  const userText = priorConversation
    ? `Conversation history:\n${priorConversation}\n\nCurrent user message:\n${latestUserText}`
    : latestUserText;
  const userMessage = encodeUserMessage(userText, requestId, 1);
  const userAction = concatBytes([
    bytesField(1, userMessage),
    encodeRequestContext(timeZone),
  ]);
  const action = bytesField(1, userAction);
  const run = concatBytes([
    bytesField(1, encodeConversationState(normalized, blobStore, requestId)),
    bytesField(2, action),
    bytesField(3, encodeModelDetails(String(model ?? ""))),
    bytesField(4, encodeMcpTools(tools)),
    stringField(5, conversationId),
  ]);
  const clientMessage = bytesField(1, run);
  return { frame: frameConnectMessage(clientMessage), blobs: blobStore, requestId, conversationId };
}

export function encodeHeartbeat() {
  return frameConnectMessage(bytesField(7, new Uint8Array()));
}

export function decodeConnectFrames(buffer, { maxFrameBytes = 8 * 1024 * 1024 } = {}) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const flags = buffer[offset];
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0, false);
    if (length > maxFrameBytes) {
      const error = new Error(`Cursor Connect frame exceeds ${maxFrameBytes} bytes`);
      error.code = "CURSOR_FRAME_TOO_LARGE";
      error.frameLength = length;
      throw error;
    }
    if (buffer.length - offset - 5 < length) break;
    frames.push({ flags, payload: buffer.slice(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return { frames, rest: buffer.slice(offset) };
}

/**
 * Return redacted wire metadata for diagnostics. This deliberately records
 * only Connect flags, byte lengths, wire types, and protobuf field paths.
 */
export function cursorFrameMetadata(message, flags = null) {
  const bytes = message instanceof Uint8Array ? message : Uint8Array.from(message ?? []);
  const fieldPaths = [];
  const visit = (value, prefix = [], depth = 0) => {
    if (depth > 4 || fieldPaths.length >= 64) return;
    for (const field of decodeProtoFields(value).slice(0, 32)) {
      const path = [...prefix, field.field].join(".");
      fieldPaths.push({ path, wireType: field.wireType, byteLength: field.value instanceof Uint8Array ? field.value.byteLength : null });
      if (field.wireType === 2) visit(field.value, [...prefix, field.field], depth + 1);
      if (fieldPaths.length >= 64) return;
    }
  };
  visit(bytes);
  return {
    ...(Number.isInteger(flags) ? { flags } : {}),
    payloadLength: bytes.byteLength,
    fieldPaths,
  };
}

/**
 * Connect's end-stream frame is a JSON envelope for this Cursor endpoint.
 * Older code treated every trailer as a successful turn, which made upstream
 * quota errors appear in the UI as an empty assistant message.
 */
export function decodeCursorConnectTrailer(payload) {
  const text = textDecoder.decode(payload instanceof Uint8Array ? payload : Uint8Array.from(payload ?? [])).trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: "CURSOR_CONNECT_ERROR", message: text.slice(0, 500) };
  }
  const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  if (!error) return null;
  const code = typeof error.code === "string" && error.code.trim() ? error.code.trim() : "CURSOR_CONNECT_ERROR";
  const message = typeof error.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : code;
  return { code, message };
}

export function decodeCursorText(message) {
  try {
    const interaction = firstBytes(decodeProtoFields(message), 1);
    if (!interaction) return "";
    const update = firstBytes(decodeProtoFields(interaction), 1);
    if (!update) return "";
    return firstString(decodeProtoFields(update), 1);
  } catch {
    return "";
  }
}

export function cursorTurnComplete(message) {
  try {
    const interaction = firstBytes(decodeProtoFields(message), 1);
    if (!interaction) return false;
    return decodeProtoFields(interaction).some((field) => field.wireType === 2 && [14, 18, 19].includes(field.field));
  } catch {
    return false;
  }
}

function decodeKvRequest(message) {
  const kv = firstBytes(decodeProtoFields(message), 4);
  if (!kv) return null;
  const fields = decodeProtoFields(kv);
  const id = fields.find((field) => field.field === 1 && field.wireType === 0)?.value ?? 0;
  const getArgs = firstBytes(fields, 2);
  const setArgs = firstBytes(fields, 3);
  if (getArgs) return { id, kind: "get", blobId: firstBytes(decodeProtoFields(getArgs), 1) };
  if (setArgs) return { id, kind: "set" };
  return null;
}

export function encodeKvResponse(request, blobs) {
  if (request.kind === "get") {
    const key = request.blobId ? Buffer.from(request.blobId).toString("hex") : "";
    const value = blobs.get(key) ?? new Uint8Array();
    const result = bytesField(1, value);
    return frameConnectMessage(bytesField(3, concatBytes([varintField(1, request.id), bytesField(2, result)])));
  }
  return frameConnectMessage(bytesField(3, concatBytes([varintField(1, request.id), bytesField(3, new Uint8Array())])));
}

export function decodeCursorKvRequest(message) {
  return decodeKvRequest(message);
}

export function decodeCursorToolMessage(_message) {
  // AgentService can ask the desktop client to execute native tools. DSH's
  // provider-neutral tool loop owns those tools, so this first transport
  // intentionally does not advertise tool schemas or synthesize tool text.
  return null;
}

export const cursorNativeProtocolConstants = Object.freeze({
  endpoint: "https://agent.api5.cursor.sh/agent.v1.AgentService/Run",
  providerIdentifier: "opencodex-responses",
});
