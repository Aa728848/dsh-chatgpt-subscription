/**
 * Small provider-neutral helpers for native streaming transports.
 *
 * The provider modules still own request/response translation. This file only
 * handles the boring wire concerns that are shared by SSE based APIs:
 * bounded fetches, SSE framing, usage normalization, and safe provider
 * errors. Keeping this separate makes it possible to test each adapter with a
 * fake fetch implementation without starting a provider CLI.
 */

function numericStatus(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Validate an endpoint before an OAuth/API credential is attached to it.
 * Provider integrations may opt into a custom HTTPS origin, but plaintext
 * HTTP is only safe for an explicitly local development service.
 */
export function validateNativeEndpoint(value, { providerId = "provider" } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${providerId} endpoint is required`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${providerId} endpoint is invalid`);
  }
  if (url.username || url.password) {
    throw new Error(`${providerId} endpoint must not include embedded credentials`);
  }
  if (url.hash) {
    throw new Error(`${providerId} endpoint must not include a URL fragment`);
  }
  const localHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(`${providerId} endpoint must use HTTPS; HTTP is only allowed for loopback development`);
  }
  return url.toString();
}

function diagnosticText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorDetails(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return {};
    try {
      return errorDetails(JSON.parse(value));
    } catch {
      return { message: text };
    }
  }
  if (typeof value !== "object") return { message: String(value) };

  const nested = value.error;
  const nestedObject = nested && typeof nested === "object" ? nested : null;
  const message = [
    nestedObject?.message,
    typeof nested === "string" ? nested : null,
    value.message,
    nestedObject?.status,
    value.status,
  ].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  const code = [
    nestedObject?.code,
    value.code,
    nestedObject?.status,
    value.status,
  ].find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  const status = [nestedObject?.status, value.status]
    .find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  return {
    ...(message ? { message: String(message).replace(/\s+/g, " ").trim().slice(0, 500) } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function isAuthenticationFailure(message, body) {
  const text = `${diagnosticText(message)} ${diagnosticText(body)}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return [
    /access token.{0,80}(?:could not be validated|invalid|expired|revok|not valid|unauthor)/,
    /(?:invalid|expired|revok|unauthor|not valid).{0,80}(?:access token|token|credential)/,
    /\b(?:unauthorized|authentication failed|login required)\b/,
    /\bcredentials?\b.{0,50}\b(?:invalid|expired|missing|unavailable)\b/,
  ].some((pattern) => pattern.test(text));
}

export function nativeProviderError(providerId, message, { status, body, code } = {}) {
  const bodyDetails = errorDetails(body);
  const messageDetails = errorDetails(message);
  const resolvedMessage = messageDetails.message ?? bodyDetails.message ?? (message ? String(message) : null);
  const resolvedCode = code ?? messageDetails.code ?? bodyDetails.code;
  const upstreamStatus = messageDetails.status ?? bodyDetails.status;
  const statusCode = numericStatus(status);
  const codeText = String(upstreamStatus ?? resolvedCode ?? "").toUpperCase();
  const exhaustionText = `${resolvedMessage ?? ""} ${diagnosticText(body)} ${diagnosticText(upstreamStatus)} ${diagnosticText(resolvedCode)}`
    .toLowerCase();
  const quotaExhausted = codeText === "RESOURCE_EXHAUSTED"
    || /\bresources?\b[\s\S]{0,80}\bexhausted\b/.test(exhaustionText)
    || /\bquota\b[\s\S]{0,80}\b(?:exhausted|depleted|exceeded)\b/.test(exhaustionText)
    || /\bcapacity\b[\s\S]{0,80}\bexhausted\b/.test(exhaustionText);
  const rateLimited = statusCode === 429
    || numericStatus(resolvedCode) === 429
    || numericStatus(upstreamStatus) === 429
    || codeText === "RESOURCE_EXHAUSTED"
    || codeText === "RATE_LIMITED"
    || quotaExhausted;
  const displayMessage = quotaExhausted
    ? "额度或上游资源已耗尽，请刷新额度、切换账号或稍后重试"
    : rateLimited
      ? "请求频率受限，请切换账号或稍后重试"
    : resolvedMessage;
  const error = new Error(`${providerId ?? "provider"} native request failed${displayMessage ? `: ${displayMessage}` : ""}`);
  error.providerId = providerId ?? null;
  if (status !== undefined && status !== null) error.status = status;
  if (resolvedCode !== undefined && resolvedCode !== null) {
    error.code = resolvedCode;
    error.upstreamCode = resolvedCode;
  }
  if (resolvedMessage) error.upstreamMessage = resolvedMessage;
  if (upstreamStatus !== undefined && upstreamStatus !== null) error.upstreamStatus = upstreamStatus;
  // Providers do not agree on where to put auth failures: some return HTTP
  // 401, while others return HTTP 403 or a JSON code such as "unauthorized"
  // with a human message. An explicit token validation failure is an unusable
  // OAuth credential, so the account pool must stop selecting it.
  error.authExpired = statusCode === 401 || isAuthenticationFailure(resolvedMessage, body);
  error.authForbidden = !error.authExpired && statusCode === 403;
  error.quotaExhausted = quotaExhausted;
  error.rateLimited = rateLimited;
  if (body !== undefined) error.body = body;
  return error;
}

const nativeResponseControls = new WeakMap();

export async function fetchNativeResponse(url, init = {}, {
  providerId,
  timeoutMs = 300_000,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const upstreamSignal = init.signal;
  const abort = () => controller.abort(upstreamSignal?.reason);
  const timeoutError = nativeProviderError(providerId, "request timed out");
  timeoutError.code = "ETIMEDOUT";
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    upstreamSignal?.removeEventListener?.("abort", abort);
  };
  const control = { cleanup, get timedOut() { return timedOut; }, timeoutError };
  let handedOff = false;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abort();
    else upstreamSignal.addEventListener("abort", abort, { once: true });
  }
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (response.ok === false || (response.status !== undefined && response.status >= 400)) {
      let body = null;
      try {
        body = await response.text();
      } catch {
        // Preserve the HTTP status when a mock or a broken upstream has no
        // readable error body.
      }
      const details = errorDetails(body);
      throw nativeProviderError(providerId, details.message, {
        status: response.status,
        body,
        code: details.code,
      });
    }
    nativeResponseControls.set(response, control);
    handedOff = true;
    return response;
  } catch (error) {
    if (error?.name === "AbortError" && timedOut && !error.providerId) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (!handedOff) cleanup();
  }
}

async function* responseChunks(response) {
  if (!response?.body) return;
  if (typeof response.body[Symbol.asyncIterator] === "function") {
    for await (const chunk of response.body) yield chunk;
    return;
  }
  const reader = response.body.getReader?.();
  if (!reader) return;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function parseSseEvent(lines) {
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const raw = data.join("\n");
  if (raw.trim() === "[DONE]") return { event, data: null, done: true };
  try {
    return { event, data: JSON.parse(raw), raw };
  } catch {
    return { event, data: raw, raw };
  }
}

/** Yield parsed Server-Sent Events from a fetch Response. */
export async function* readSseEvents(response) {
  const control = nativeResponseControls.get(response);
  const decoder = new TextDecoder();
  let buffer = "";
  let lines = [];
  try {
    for await (const chunk of responseChunks(response)) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line !== "") {
          lines.push(line);
          continue;
        }
        const parsed = parseSseEvent(lines);
        lines = [];
        if (parsed) {
          yield parsed;
          if (parsed.done) return;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) lines.push(buffer);
    const parsed = parseSseEvent(lines);
    if (parsed) yield parsed;
  } catch (error) {
    if (control?.timedOut && !error?.providerId) throw control.timeoutError;
    throw error;
  } finally {
    control?.cleanup();
    nativeResponseControls.delete(response);
  }
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = Number(value.input_tokens
    ?? value.inputTokens
    ?? value.prompt_tokens
    ?? value.promptTokens
    ?? value.promptTokenCount);
  const outputTokens = Number(value.output_tokens
    ?? value.outputTokens
    ?? value.completion_tokens
    ?? value.completionTokens
    ?? value.candidatesTokenCount);
  const totalTokens = Number(value.total_tokens ?? value.totalTokens ?? value.totalTokenCount);
  const cacheReadTokens = Number(value.cache_read_input_tokens
    ?? value.cacheReadInputTokens
    ?? value.cachedContentTokenCount);
  const cacheWriteTokens = Number(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens);
  const result = {};
  if (Number.isFinite(inputTokens)) result.inputTokens = inputTokens;
  if (Number.isFinite(outputTokens)) result.outputTokens = outputTokens;
  if (Number.isFinite(totalTokens)) result.totalTokens = totalTokens;
  if (Number.isFinite(cacheReadTokens)) result.cacheReadTokens = cacheReadTokens;
  if (Number.isFinite(cacheWriteTokens)) result.cacheWriteTokens = cacheWriteTokens;
  return Object.keys(result).length > 0 ? result : null;
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => textFromContent(part)).filter(Boolean).join("");
  if (!content || typeof content !== "object") return "";
  if (content.type === "image") return "";
  if (content.type === "tool-result") {
    return textFromContent(content.content ?? content.output ?? content.result ?? content.text);
  }
  return content.text ?? content.value ?? content.content ?? content.delta ?? "";
}

export function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function base64FromBytes(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("base64");
  return null;
}

export function dataUrlParts(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) return null;
  const mediaType = match[1] || "application/octet-stream";
  const encoded = match[0].includes(";base64,")
    ? match[2]
    : (() => {
      try {
        return Buffer.from(decodeURIComponent(match[2]), "utf8").toString("base64");
      } catch {
        // A malformed percent-encoding in a data URL must not abort the whole
        // request; treat the payload as opaque utf8 text instead.
        return Buffer.from(match[2], "utf8").toString("base64");
      }
    })();
  return { mediaType, data: encoded };
}

export async function resolveImageData(content, attachments) {
  const direct = content?.data ?? content?.base64 ?? content?.source?.data;
  const directData = base64FromBytes(direct);
  if (directData) {
    return {
      mediaType: content.mediaType ?? content.mimeType ?? content.source?.media_type ?? "application/octet-stream",
      data: directData,
    };
  }
  const dataUrl = dataUrlParts(content?.url ?? content?.source?.url);
  if (dataUrl) return dataUrl;
  const reference = content?.attachment ?? content?.ref ?? content?.source;
  if (!reference || !attachments?.readImage) return null;
  const image = await attachments.readImage(reference);
  const data = base64FromBytes(image?.data ?? image?.bytes ?? image?.base64);
  if (!data) return null;
  return {
    mediaType: content.mediaType ?? content.mimeType ?? image?.ref?.mediaType ?? image?.mediaType ?? "application/octet-stream",
    data,
  };
}

export function finishReason(value, fallback = "stop") {
  const reason = String(value ?? fallback).toLowerCase();
  if (reason.includes("tool") || reason === "function_call" || reason === "tool_use") {
    return { kind: "tool-calls" };
  }
  if (reason.includes("length") || reason.includes("max")) return { kind: "length" };
  if (reason.includes("error") || reason.includes("cancel")) return { kind: "error" };
  return { kind: "stop" };
}
