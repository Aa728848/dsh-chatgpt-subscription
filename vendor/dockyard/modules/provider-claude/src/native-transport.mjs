import {
  fetchNativeResponse,
  finishReason,
  nativeProviderError,
  normalizeUsage,
  parseToolArguments,
  readSseEvents,
  resolveImageData,
  textFromContent,
  validateNativeEndpoint,
} from "../../../packages/providers/src/native-transport.mjs";

const PROVIDER_ID = "claude";
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

/** Resolve only the selected subscription account's host-side OAuth credential. */
export async function resolveClaudeAccessToken({ credential } = {}) {
  const stored = firstString(credential?.access, credential?.token);
  if (!stored || credential?.type === "api_key") return null;
  return { token: stored, kind: "oauth" };
}

function toolCallPart(part) {
  const type = String(part?.type ?? "").toLowerCase().replace(/[_-]/g, "");
  return type === "toolcall" || type === "tooluse" || type === "functioncall"
    ? part
    : null;
}

async function anthropicContent(content, attachments) {
  const values = Array.isArray(content) ? content : [content];
  const blocks = [];
  for (const part of values) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "image") {
      const image = await resolveImageData(part, attachments);
      if (!image) throw nativeProviderError(PROVIDER_ID, "image attachment could not be resolved");
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
      continue;
    }
    if (part.type === "tool-result" || part.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: firstString(part.toolCallId, part.tool_call_id, part.id, "tool-result"),
        content: textFromContent(part.content ?? part.output ?? part.result ?? part.text),
        ...(part.isError || part.is_error ? { is_error: true } : {}),
      });
      continue;
    }
    const tool = toolCallPart(part);
    if (tool) {
      blocks.push({
        type: "tool_use",
        id: firstString(tool.id, tool.toolCallId, tool.tool_call_id, `tool-${blocks.length}`),
        name: firstString(tool.name, tool.function?.name, "tool"),
        input: parseToolArguments(tool.arguments ?? tool.input ?? tool.function?.arguments),
      });
      continue;
    }
    const text = textFromContent(part);
    if (text) blocks.push({ type: "text", text });
  }
  return blocks;
}

async function buildAnthropicMessages(request, attachments) {
  const messages = [];
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "tool" ? "user" : "user";
    const content = await anthropicContent(message?.content ?? message?.text, attachments);
    if (role === "user" && message?.role === "tool" && content.length === 0) continue;
    if (content.length > 0) messages.push({ role, content: content.length === 1 && content[0].type === "text" ? content[0].text : content });
  }
  if (messages.length === 0) messages.push({ role: "user", content: "Continue the conversation." });
  return messages;
}

function buildAnthropicTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const result = tools.map((tool) => ({
    name: firstString(tool?.name, tool?.function?.name, "tool"),
    ...(tool?.description ? { description: String(tool.description) } : {}),
    input_schema: tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? { type: "object" },
  }));
  return result.length > 0 ? result : undefined;
}

function thinkingBudget(request) {
  const value = request?.reasoningBudget ?? request?.thinkingBudget;
  if (Number.isInteger(value) && value > 0) return value;
  const effort = String(request?.reasoningEffort ?? "").toLowerCase();
  if (effort === "high" || effort === "xhigh") return 16_000;
  if (effort === "medium") return 8_000;
  if (effort === "low") return 4_000;
  return null;
}

export async function buildClaudeRequest(request = {}, context = {}) {
  const body = {
    model: request.model,
    messages: await buildAnthropicMessages(request, context.attachments),
    max_tokens: Number.isInteger(request.maxTokens)
      ? request.maxTokens
      : Number.isInteger(request.modelContext?.maxTokens) ? request.modelContext.maxTokens : 4096,
    stream: true,
  };
  if (typeof request.system === "string" && request.system.length > 0) body.system = request.system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const tools = buildAnthropicTools(request.tools);
  if (tools) body.tools = tools;
  const budget = thinkingBudget(request);
  if (budget && body.max_tokens > budget) body.thinking = { type: "enabled", budget_tokens: budget };
  return body;
}

function headersForToken(auth, userAgent) {
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
  };
  if (userAgent) headers["user-agent"] = userAgent;
  if (auth.kind === "apiKey" || auth.token.startsWith("sk-ant-")) {
    headers["x-api-key"] = auth.token;
  } else {
    headers.authorization = `Bearer ${auth.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["anthropic-client-platform"] = "DESKTOP_APP";
    headers["anthropic-client-version"] = "1.0.0";
  }
  return headers;
}

function mergeUsage(previous, next) {
  return next ? { ...(previous ?? {}), ...next } : previous;
}

async function* streamClaudeResponse(response) {
  let text = "";
  let textIndex = 0;
  let textOpen = true;
  let nextIndex = 1;
  let usage = null;
  let stop = "stop";
  const tools = new Map();
  const reasoning = new Map();
  yield { type: "block-start", index: textIndex, blockType: "text" };

  for await (const event of readSseEvents(response)) {
    const payload = event.data;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "message_start") {
      usage = mergeUsage(usage, normalizeUsage(payload.message?.usage));
      continue;
    }
    if (payload.type === "content_block_start") {
      const block = payload.content_block ?? {};
      if (block.type === "tool_use" || block.type === "thinking" || block.type === "redacted_thinking") {
        if (textOpen) {
          yield { type: "block-end", index: textIndex, block: { type: "text", text } };
          textOpen = false;
        }
        const index = nextIndex++;
        if (block.type === "tool_use") {
          tools.set(payload.index, {
            index,
            id: firstString(block.id, `tool-${payload.index}`),
            name: firstString(block.name, "tool"),
            arguments: "",
          });
          yield { type: "block-start", index, blockType: "tool-call" };
        } else {
          reasoning.set(payload.index, { index, text: "" });
          yield { type: "block-start", index, blockType: "reasoning" };
        }
        continue;
      }
      if (block.type === "text" && !textOpen) {
        textIndex = nextIndex++;
        text = "";
        textOpen = true;
        yield { type: "block-start", index: textIndex, blockType: "text" };
      }
      continue;
    }
    if (payload.type === "content_block_delta") {
      const delta = payload.delta ?? {};
      if (delta.type === "text_delta" && delta.text) {
        if (!textOpen) {
          textIndex = nextIndex++;
          text = "";
          textOpen = true;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        text += delta.text;
        yield { type: "text-delta", index: textIndex, text: delta.text };
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        let state = reasoning.get(payload.index);
        if (!state) {
          if (textOpen) {
            yield { type: "block-end", index: textIndex, block: { type: "text", text } };
            textOpen = false;
          }
          state = { index: nextIndex++, text: "" };
          reasoning.set(payload.index, state);
          yield { type: "block-start", index: state.index, blockType: "reasoning" };
        }
        state.text += delta.thinking;
        yield { type: "reasoning-delta", index: state.index, text: delta.thinking };
      } else if (delta.type === "input_json_delta" && tools.has(payload.index)) {
        const tool = tools.get(payload.index);
        tool.arguments += delta.partial_json ?? "";
        yield { type: "tool-call-delta", index: tool.index, id: tool.id, name: tool.name, argumentsDelta: delta.partial_json ?? "" };
      }
      continue;
    }
    if (payload.type === "content_block_stop") {
      const thought = reasoning.get(payload.index);
      if (thought) {
        yield { type: "block-end", index: thought.index, block: { type: "reasoning", text: thought.text } };
        reasoning.delete(payload.index);
      }
      const tool = tools.get(payload.index);
      if (tool) {
        yield {
          type: "block-end",
          index: tool.index,
          block: { type: "tool-call", id: tool.id, name: tool.name, arguments: tool.arguments || "{}" },
        };
        tools.delete(payload.index);
      }
      continue;
    }
    if (payload.type === "message_delta") {
      stop = payload.delta?.stop_reason ?? stop;
      usage = mergeUsage(usage, normalizeUsage(payload.usage));
      continue;
    }
    if (payload.type === "error") {
      throw nativeProviderError(PROVIDER_ID, payload.error?.message ?? "Anthropic returned an error", {
        status: payload.error?.status,
        body: payload.error,
      });
    }
  }

  for (const thought of reasoning.values()) {
    yield { type: "block-end", index: thought.index, block: { type: "reasoning", text: thought.text } };
  }
  if (textOpen) yield { type: "block-end", index: textIndex, block: { type: "text", text } };
  for (const tool of tools.values()) {
    yield {
      type: "block-end",
      index: tool.index,
      block: { type: "tool-call", id: tool.id, name: tool.name, arguments: tool.arguments || "{}" },
    };
  }
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: finishReason(stop) };
}

export function createClaudeNativeExecutor({
  endpoint = process.env.DOCKYARD_CLAUDE_ENDPOINT || DEFAULT_ENDPOINT,
  env = process.env,
  timeoutMs = 300_000,
  fetchImpl = fetch,
  tokenResolver = resolveClaudeAccessToken,
  userAgent = null,
} = {}) {
  const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID });
  const executor = async ({ request = {}, invocation, context = {} } = {}) => {
    let credential = null;
    if (context.secretStore) {
      const ref = invocation?.auth?.credentialRef ?? invocation?.account?.auth?.credentialRef ?? invocation?.account?.credentialRef;
      if (ref) credential = await context.secretStore.read(ref);
    }
    const auth = await tokenResolver({ credential, env: { ...env, ...(context.env ?? {}) } });
    if (!auth?.token) {
      const error = nativeProviderError(PROVIDER_ID, "Claude OAuth token is unavailable; authorize Claude first");
      error.authExpired = true;
      throw error;
    }
    const body = await buildClaudeRequest(request, context);
    const response = await fetchNativeResponse(safeEndpoint, {
      method: "POST",
      headers: headersForToken(auth, userAgent),
      body: JSON.stringify(body),
      signal: context.signal,
    }, { providerId: PROVIDER_ID, timeoutMs, fetchImpl });
    return streamClaudeResponse(response);
  };
  executor.nativeTransport = "anthropic-messages";
  return executor;
}

export const claudeNativeTransportConstants = Object.freeze({
  providerId: PROVIDER_ID,
  endpoint: DEFAULT_ENDPOINT,
});
