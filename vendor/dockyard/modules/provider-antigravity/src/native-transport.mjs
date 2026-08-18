import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
import { decodeJwtPayload } from "../../../packages/providers/src/provider-utils.mjs";

const PROVIDER_ID = "antigravity";
const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const DEFAULT_QUOTA_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const DEFAULT_PROJECT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ANTIGRAVITY_INFO_PATHS = [
  "/Applications/Antigravity.app/Contents/Info.plist",
  join(homedir(), "Applications/Antigravity.app/Contents/Info.plist"),
];

function normalizeAntigravityClientVersion(value) {
  const version = String(value ?? "").trim();
  return /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function detectAntigravityUserAgent() {
  for (const infoPath of ANTIGRAVITY_INFO_PATHS) {
    try {
      const version = normalizeAntigravityClientVersion(execFileSync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleShortVersionString", infoPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ));
      if (version) return `antigravity/hub/${version} ${process.platform}/${process.arch}`;
    } catch {
      // CodexSplit omits User-Agent when the desktop bundle is unavailable.
    }
  }
  return null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function emailFromObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const direct = firstString(value.email, value.userEmail, value.email_address, value.account?.email);
  if (direct) return direct;
  const idToken = firstString(value.id_token, value.idToken);
  if (idToken) {
    try {
      const payload = decodeJwtPayload(idToken);
      const fromClaims = firstString(payload?.email);
      if (fromClaims) return fromClaims;
    } catch {
      // A malformed id_token must not fail the whole token read.
    }
  }
  for (const child of Object.values(value)) {
    const email = emailFromObject(child, depth + 1);
    if (email) return email;
  }
  return null;
}

function tokenFromObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const direct = firstString(value.access_token, value.accessToken);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    const token = tokenFromObject(child, depth + 1);
    if (token) return token;
  }
  return null;
}

function readOfficialTokenFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const token = tokenFromObject(parsed);
    return token ? { token, kind: "oauth", email: emailFromObject(parsed) } : null;
  } catch {
    return null;
  }
}

/** Read only the OAuth token file from an explicitly selected profile. */
export function readAntigravityTokenFile({ env = process.env, home = homedir() } = {}) {
  return readOfficialTokenFile(
    env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE
      || join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  );
}

/** Resolve Antigravity's local OAuth token without spawning `agy -p`. */
export function resolveAntigravityAccessToken({ credential, env = process.env, home = homedir() } = {}) {
  const stored = firstString(credential?.access, credential?.token);
  if (stored) {
    return { token: stored, kind: "oauth", email: emailFromObject(credential) };
  }
  const fromCredentialObject = tokenFromObject(credential);
  if (fromCredentialObject) {
    return { token: fromCredentialObject, kind: "oauth", email: emailFromObject(credential) };
  }
  const fromEnv = firstString(env.DOCKYARD_ANTIGRAVITY_ACCESS_TOKEN, env.GEMINI_ACCESS_TOKEN);
  if (fromEnv) return { token: fromEnv, kind: "oauth" };
  // Do not probe the macOS Keychain here. Integrated accounts are stored in
  // DSH Credentials and a missing legacy token must result in an ordinary
  // reauthorization error, never a system dialog for a guessed keychain item.
  return readAntigravityTokenFile({ env, home });
}

function projectIdFromLoadCodeAssist(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  for (const key of ["cloudaicompanionProject", "cloudaicompanion_project", "projectId", "project_id", "project"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = firstString(candidate.id, candidate.projectId, candidate.project_id, candidate.name);
      if (nested) return nested.trim();
    }
  }
  for (const child of Object.values(value)) {
    const nested = projectIdFromLoadCodeAssist(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Resolve the Code Assist project for the selected OAuth session. */
export function createAntigravityProjectResolver({
  endpoint = process.env.DOCKYARD_ANTIGRAVITY_PROJECT_ENDPOINT || DEFAULT_PROJECT_ENDPOINT,
  env = process.env,
  home = homedir(),
  timeoutMs = 20_000,
  fetchImpl = fetch,
  tokenResolver = resolveAntigravityAccessToken,
  project = undefined,
  userAgent = process.env.DOCKYARD_ANTIGRAVITY_USER_AGENT || detectAntigravityUserAgent(),
} = {}) {
  const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID });
  const configuredProject = typeof project === "string" && project.trim() ? project.trim() : null;
  const cache = new Map();
  return async ({ credential = null, account = null, context = {} } = {}) => {
    if (configuredProject) return configuredProject;
    const cacheKey = account?.accountId ?? context.accountId ?? "default";
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const auth = await tokenResolver({
      credential,
      env: { ...env, ...(context.env ?? {}) },
      home,
    });
    if (!auth?.token) {
      const error = nativeProviderError(PROVIDER_ID, "Antigravity OAuth token is unavailable; authorize Antigravity first");
      error.authExpired = true;
      throw error;
    }
    const headers = {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (userAgent) headers["user-agent"] = userAgent;
    const response = await fetchNativeResponse(safeEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: context.signal,
    }, { providerId: PROVIDER_ID, timeoutMs, fetchImpl });
    const raw = typeof response.json === "function"
      ? await response.json()
      : JSON.parse(await response.text());
    const resolved = projectIdFromLoadCodeAssist(raw);
    if (!resolved) {
      throw nativeProviderError(PROVIDER_ID, "Antigravity did not return a Code Assist project for the selected account", { body: raw });
    }
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

async function geminiParts(content, attachments) {
  const values = Array.isArray(content) ? content : [content];
  const parts = [];
  for (const part of values) {
    if (typeof part === "string") {
      if (part) parts.push({ text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (part.type === "image") {
      const image = await resolveImageData(part, attachments);
      if (!image) throw nativeProviderError(PROVIDER_ID, "image attachment could not be resolved");
      parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
      continue;
    }
    if (part.type === "tool-result" || part.type === "tool_result") {
      parts.push({ text: `[Tool Result ${part.toolCallId ?? part.id ?? ""}]\n${textFromContent(part.content ?? part.output ?? part.result ?? part.text)}` });
      continue;
    }
    if (part.type === "tool-call" || part.type === "tool_call" || part.type === "function-call") {
      parts.push({ functionCall: { name: part.name ?? part.function?.name ?? "tool", args: parseToolArguments(part.arguments ?? part.input ?? part.function?.arguments) } });
      continue;
    }
    const text = textFromContent(part);
    if (text) parts.push({ text });
  }
  return parts;
}

async function buildGeminiContents(request, attachments) {
  const contents = [];
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    const parts = await geminiParts(message?.content ?? message?.text, attachments);
    if (parts.length === 0) continue;
    contents.push({
      role: message?.role === "assistant" ? "model" : "user",
      parts,
    });
  }
  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Continue the conversation." }] });
  return contents;
}

function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (["$schema", "additionalProperties", "strict"].includes(key)) continue;
    result[key] = sanitizeSchema(child);
  }
  return result;
}

function buildGeminiTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const declarations = tools.map((tool) => ({
    name: tool?.name ?? tool?.function?.name ?? "tool",
    ...(tool?.description ? { description: String(tool.description) } : {}),
    parameters: sanitizeSchema(tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? { type: "object" }),
  }));
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

export async function buildAntigravityRequest(request = {}, context = {}) {
  const nativeRequest = {
    contents: await buildGeminiContents(request, context.attachments),
  };
  if (typeof request.system === "string" && request.system.length > 0) {
    nativeRequest.systemInstruction = { parts: [{ text: request.system }] };
  }
  // Keep this payload aligned with CodexSplit's GoogleGeminiAdapter. The
  // selected Antigravity tier is already part of the exact model id; it is
  // not rewritten into a guessed family id or a thinkingConfig field.
  nativeRequest.generationConfig = {
    temperature: request.temperature ?? 0.7,
    maxOutputTokens: request.maxTokens ?? 4096,
  };
  const tools = buildGeminiTools(request.tools);
  if (tools) nativeRequest.tools = tools;
  return nativeRequest;
}

function responsePayload(value) {
  if (!value || typeof value !== "object") return null;
  return value.response && typeof value.response === "object" ? value.response : value;
}

async function* streamAntigravityResponse(response) {
  let text = "";
  let textIndex = 0;
  let textOpen = true;
  let nextIndex = 1;
  let usage = null;
  let stop = "stop";
  let reasoning = null;
  yield { type: "block-start", index: textIndex, blockType: "text" };

  for await (const event of readSseEvents(response)) {
    const payload = responsePayload(event.data);
    if (!payload) continue;
    if (payload.error) {
      throw nativeProviderError(PROVIDER_ID, payload.error.message ?? "Antigravity returned an error", {
        status: payload.error.code,
        body: payload.error,
      });
    }
    usage = normalizeUsage(payload.usageMetadata ?? payload.usage) ?? usage;
    const candidate = payload.candidates?.[0] ?? payload.candidate ?? payload;
    stop = candidate.finishReason ?? stop;
    for (const part of candidate.content?.parts ?? candidate.parts ?? []) {
      if (part?.text) {
        if (part.thought === true || part.thoughtSignature) {
          if (textOpen) {
            yield { type: "block-end", index: textIndex, block: { type: "text", text } };
            textOpen = false;
          }
          if (!reasoning) {
            reasoning = { index: nextIndex++, text: "" };
            yield { type: "block-start", index: reasoning.index, blockType: "reasoning" };
          }
          reasoning.text += part.text;
          yield { type: "reasoning-delta", index: reasoning.index, text: part.text };
          continue;
        }
        if (reasoning) {
          yield { type: "block-end", index: reasoning.index, block: { type: "reasoning", text: reasoning.text } };
          reasoning = null;
        }
        if (!textOpen) {
          textIndex = nextIndex++;
          text = "";
          textOpen = true;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        text += part.text;
        yield { type: "text-delta", index: textIndex, text: part.text };
        continue;
      }
      const call = part?.functionCall ?? part?.function_call;
      if (!call) continue;
      if (reasoning) {
        yield { type: "block-end", index: reasoning.index, block: { type: "reasoning", text: reasoning.text } };
        reasoning = null;
      }
      if (textOpen) {
        yield { type: "block-end", index: textIndex, block: { type: "text", text } };
        textOpen = false;
      }
      const index = nextIndex++;
      const id = firstString(call.id, call.name, `tool-${index}`);
      const name = firstString(call.name, "tool");
      const argumentsValue = JSON.stringify(call.args ?? call.arguments ?? {});
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id, name, argumentsDelta: argumentsValue };
      yield { type: "block-end", index, block: { type: "tool-call", id, name, arguments: argumentsValue } };
      stop = "tool_calls";
    }
  }
  if (reasoning) yield { type: "block-end", index: reasoning.index, block: { type: "reasoning", text: reasoning.text } };
  if (textOpen) yield { type: "block-end", index: textIndex, block: { type: "text", text } };
  if (usage) yield { type: "usage", usage };
  yield { type: "finish", reason: finishReason(stop) };
}

export function createAntigravityNativeExecutor({
  endpoint = process.env.DOCKYARD_ANTIGRAVITY_ENDPOINT || DEFAULT_ENDPOINT,
  project = process.env.DOCKYARD_ANTIGRAVITY_PROJECT || "default-cli-project",
  env = process.env,
  timeoutMs = 300_000,
  fetchImpl = fetch,
  tokenResolver = resolveAntigravityAccessToken,
  projectResolver = null,
  userAgent = process.env.DOCKYARD_ANTIGRAVITY_USER_AGENT || detectAntigravityUserAgent(),
} = {}) {
  const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID });
  const executor = async ({ request = {}, invocation, context = {} } = {}) => {
    let credential = null;
    if (context.secretStore) {
      const ref = invocation?.auth?.credentialRef ?? invocation?.account?.auth?.credentialRef ?? invocation?.account?.credentialRef;
      if (ref) credential = await context.secretStore.read(ref);
    }
    const auth = await tokenResolver({ credential, env: { ...env, ...(context.env ?? {}) }, home: homedir() });
    if (!auth?.token) {
      const error = nativeProviderError(PROVIDER_ID, "Antigravity OAuth token is unavailable; authorize Antigravity first");
      error.authExpired = true;
      throw error;
    }
    const resolvedProject = typeof projectResolver === "function"
      ? await projectResolver({ credential, account: invocation?.account, context })
      : project;
    if (!resolvedProject) {
      throw nativeProviderError(PROVIDER_ID, "Antigravity Code Assist project is unavailable for the selected account");
    }
    const body = {
      project: resolvedProject,
      model: request.model,
      request: await buildAntigravityRequest(request, context),
    };
    const headers = {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
    };
    const resolvedUserAgent = userAgent ?? context.env?.DOCKYARD_ANTIGRAVITY_USER_AGENT ?? detectAntigravityUserAgent();
    if (resolvedUserAgent) headers["user-agent"] = resolvedUserAgent;
    const response = await fetchNativeResponse(safeEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: context.signal,
    }, { providerId: PROVIDER_ID, timeoutMs, fetchImpl });
    return streamAntigravityResponse(response);
  };
  executor.nativeTransport = "gemini-stream-generate-content";
  return executor;
}

/**
 * Read the same first-party quota summary used by `agy /quota`, without
 * starting a new CLI process. The response is intentionally returned raw;
 * the provider driver owns the live quota schema and can keep it dynamic.
 */
export function createAntigravityNativeQuotaReader({
  endpoint = process.env.DOCKYARD_ANTIGRAVITY_QUOTA_ENDPOINT || DEFAULT_QUOTA_ENDPOINT,
  env = process.env,
  home = homedir(),
  timeoutMs = 20_000,
  fetchImpl = fetch,
  tokenResolver = resolveAntigravityAccessToken,
  project = env.DOCKYARD_ANTIGRAVITY_PROJECT,
  projectResolver = null,
  userAgent = env.DOCKYARD_ANTIGRAVITY_USER_AGENT || detectAntigravityUserAgent(),
} = {}) {
  const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID });
  return async ({ credential = null, account = null, context = {} } = {}) => {
    const auth = await tokenResolver({
      credential,
      env: { ...env, ...(context.env ?? {}) },
      home,
    });
    if (!auth?.token) {
      const error = nativeProviderError(PROVIDER_ID, "Antigravity OAuth token is unavailable; authorize Antigravity first");
      error.authExpired = true;
      throw error;
    }
    const resolvedProject = typeof projectResolver === "function"
      ? await projectResolver({ credential, account, context })
      : project;
    const body = resolvedProject ? { project: resolvedProject } : {};
    const resolvedUserAgent = userAgent ?? context.env?.DOCKYARD_ANTIGRAVITY_USER_AGENT ?? detectAntigravityUserAgent();
    const headers = {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (resolvedUserAgent) headers["user-agent"] = resolvedUserAgent;
    const response = await fetchNativeResponse(safeEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: context.signal,
    }, { providerId: PROVIDER_ID, timeoutMs, fetchImpl });
    const raw = typeof response.json === "function"
      ? await response.json()
      : JSON.parse(await response.text());
    if (!raw || typeof raw !== "object") {
      throw nativeProviderError(PROVIDER_ID, "quota summary response was not an object");
    }
    return raw;
  };
}

export const antigravityNativeTransportConstants = Object.freeze({
  providerId: PROVIDER_ID,
  endpoint: DEFAULT_ENDPOINT,
  quotaEndpoint: DEFAULT_QUOTA_ENDPOINT,
});
