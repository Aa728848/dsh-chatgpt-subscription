import { createRequire } from "node:module";
import * as LlmModule from "@deepseek-ai/dsh-llm";
import { CallId, HarnessError, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, attributionHeaders, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { WebError } from "@deepseek-ai/dsh-web";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http, { createServer } from "node:http";
import { execSync, spawn } from "node:child_process";
import { ProxyAgent, fetch as fetch$1 } from "undici";
import * as SettingsModule from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import fs, { constants } from "node:fs";
import fsPromises, { chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import os, { homedir } from "node:os";
import path, { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { URL as URL$1, URLSearchParams as URLSearchParams$1 } from "node:url";
//#region src/compat.ts
/**
* Compatibility constants for the ChatGPT-backed Codex flow. The backend and
* OAuth parameters are not a public third-party API contract, so every such
* value is isolated here for review and rollback.
*/
const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_CALLBACK_HOST = "localhost";
const OAUTH_CALLBACK_PORT = 1455;
const OAUTH_REDIRECT_URI = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}/auth/callback`;
const OAUTH_SCOPE = "openid profile email offline_access";
const OAUTH_ORIGINATOR = "opencode";
const ROUTE_PREFIX = "/api/dsh-chatgpt-subscription";
const PLUGIN_VERSION = "0.1.0-alpha.0";
const CODEX_CHATGPT_PROVIDER_ID = "codex-chatgpt";
const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex";
const CODEX_RESPONSES_URL = `${CODEX_API_BASE}/responses`;
const CODEX_IMAGE_GENERATION_URL = `${CODEX_API_BASE}/images/generations`;
const CODEX_SEARCH_URL = `${CODEX_API_BASE}/alpha/search`;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
const CODEX_ORIGINATOR = "opencode";
const CODEX_IMAGE_TOOL_NAME = "codex_image_generate";
const CODEX_IMAGE_MODEL = "gpt-image-2";
const CODEX_SEARCH_PROVIDER_ID = "codex-subscription";
const CODEX_FETCH_PROVIDER_ID = "codex-subscription";
const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15e3;
const OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
//#endregion
//#region src/shared/model-catalog.ts
const GPT_56_MAX_CONTEXT_WINDOW = 1e6;
const GPT_6_ASTRA_MAX_CONTEXT_WINDOW = 872e3;
const CODEX_MODEL_CATALOG = [
	{
		id: "gpt-5.6-sol",
		name: "5.6 Sol",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-5.6",
		supportsReasoningSummary: true,
		fallbackModelId: "gpt-5.6-terra"
	},
	{
		id: "gpt-6-astra",
		name: "6 Astra",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-6-astra",
		supportsReasoningSummary: true
	},
	{
		id: "gpt-5.6-terra",
		name: "5.6 Terra",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-5.6",
		supportsReasoningSummary: true,
		fallbackModelId: "gpt-5.5"
	},
	{
		id: "gpt-5.6-luna",
		name: "5.6 Luna",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-5.6",
		supportsReasoningSummary: true,
		fallbackModelId: "gpt-5.5"
	},
	{
		id: "gpt-5.5",
		name: "5.5",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "standard",
		supportsReasoningSummary: true
	},
	{
		id: "gpt-5.4",
		name: "5.4",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "none",
		reasoningProfile: "standard",
		supportsReasoningSummary: true,
		fallbackModelId: "gpt-5.4-mini"
	},
	{
		id: "gpt-5.4-mini",
		name: "5.4 Mini",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "none",
		reasoningProfile: "standard",
		supportsReasoningSummary: true
	},
	{
		id: "gpt-5.3-codex-spark",
		name: "5.3 Codex Spark",
		contextWindow: 258e3,
		inputModalities: ["text"],
		defaultReasoningEffort: "high",
		reasoningProfile: "standard",
		supportsReasoningSummary: false
	}
];
const DEFAULT_VISIBLE_CODEX_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-6-astra",
	"gpt-5.6-terra",
	"gpt-5.6-luna"
];
const DEFAULT_CODEX_MODEL = CODEX_MODEL_CATALOG[0];
const CONFIGURABLE_CONTEXT_MODEL_IDS = [
	"gpt-6-astra",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna"
];
const STANDARD_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh"
];
const GPT_56_REASONING_EFFORTS = [...STANDARD_REASONING_EFFORTS, "max"];
const GPT_6_ASTRA_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function reasoningEffortsForModel(model) {
	const profile = resolveCodexCatalogEntry(model).reasoningProfile;
	if (profile === "gpt-6-astra") return GPT_6_ASTRA_REASONING_EFFORTS;
	return profile === "gpt-5.6" ? GPT_56_REASONING_EFFORTS : STANDARD_REASONING_EFFORTS;
}
function isCodexModelId(model) {
	return typeof model === "string" && CODEX_MODEL_CATALOG.some((entry) => entry.id === model);
}
function isConfigurableContextModelId(model) {
	return typeof model === "string" && CONFIGURABLE_CONTEXT_MODEL_IDS.some((id) => id === model);
}
function contextWindowLimitForModel(model) {
	return model === "gpt-6-astra" ? GPT_6_ASTRA_MAX_CONTEXT_WINDOW : GPT_56_MAX_CONTEXT_WINDOW;
}
function resolveCodexCatalogEntry(model) {
	return CODEX_MODEL_CATALOG.find((entry) => entry.id === model) ?? DEFAULT_CODEX_MODEL;
}
function codexModelSupportsImageInput(model) {
	return resolveCodexCatalogEntry(model).inputModalities.includes("image");
}
function codexModelSupportsReasoningSummary(model) {
	return resolveCodexCatalogEntry(model).supportsReasoningSummary;
}
function resolveCodexFallbackModel(model) {
	const entry = resolveCodexCatalogEntry(model);
	if (!entry.fallbackModelId) return void 0;
	return CODEX_MODEL_CATALOG.find((cand) => cand.id === entry.fallbackModelId);
}
//#endregion
//#region src/host/model-catalog.ts
const PROVIDER_ID$1 = CODEX_CHATGPT_PROVIDER_ID;
const PROVIDER_NAME$1 = "Codex（ChatGPT 订阅）";
function listCodexModels(preferences) {
	const visible = new Set(preferences?.status().visibleModelIds ?? CODEX_MODEL_CATALOG.map((entry) => entry.id));
	return CODEX_MODEL_CATALOG.filter((entry) => visible.has(entry.id)).map((entry) => ({
		provider: PROVIDER_ID$1,
		id: entry.id,
		name: entry.name,
		inputModalities: [...entry.inputModalities]
	}));
}
function resolveCodexModel(model, preferences) {
	const entry = resolveCodexCatalogEntry(model);
	const status = preferences?.status();
	const configuredContextWindow = isConfigurableContextModelId(model) ? status?.contextWindowOverrides[model] : void 0;
	const efforts = reasoningEffortsForModel(model);
	return {
		provider: PROVIDER_ID$1,
		id: model,
		name: entry.id === model ? entry.name : model,
		inputModalities: [...entry.inputModalities],
		context: { contextWindow: configuredContextWindow ?? entry.contextWindow },
		defaultMaxTokens: 32768,
		reasoning: {
			efforts: efforts.map((effort) => ({
				id: ReasoningEffortId(effort),
				name: effort
			})),
			defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort)
		}
	};
}
//#endregion
//#region src/host/adapter.ts
const RETRY_POLICY = resolveRetryPolicy({
	mode: "normal",
	maxRetries: 3,
	retryableCodes: [
		"RATE_LIMIT",
		"SERVER_ERROR",
		"SERVER",
		"NETWORK",
		"TIMEOUT",
		"TRANSPORT"
	],
	backoff: {
		initialDelayMs: 1500,
		maxDelayMs: 15e3,
		jitterRatio: .2
	}
}, "dsh-chatgpt-subscription.retry");
var CodexChatGptAdapter = class extends LlmAdapter {
	client;
	preferences;
	constructor(client, preferences) {
		super();
		this.client = client;
		this.preferences = preferences;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: PROVIDER_NAME$1
		};
	}
	providerRetryPolicy() {
		return RETRY_POLICY;
	}
	imageRequestPricing(_provider, _model) {}
	async listModels() {
		return listCodexModels(this.preferences);
	}
	async resolveModel(_provider, model, signal) {
		return resolveCodexModel(model, this.preferences);
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	stream(options) {
		return this.client.stream(options);
	}
};
//#endregion
//#region src/host/codex-fetch.ts
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BODY_CHARS = 1e5;
function createCodexFetchProvider(options = {}) {
	const fetchFn = options.fetchFn ?? fetch;
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
	return {
		id: CODEX_FETCH_PROVIDER_ID,
		available: () => true,
		async fetch(request, signal) {
			const targetUrl = request.url.trim();
			let parsedUrl;
			try {
				parsedUrl = new URL(targetUrl);
			} catch (error) {
				throw new WebError(`invalid URL: ${targetUrl}`, "WEB_INVALID_URL", { cause: error });
			}
			if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new WebError(`unsupported URL scheme "${parsedUrl.protocol}" (only http and https are allowed)`, "WEB_INVALID_URL");
			let response;
			try {
				response = await fetchFn(targetUrl, {
					method: "GET",
					headers: {
						"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
					},
					redirect: "follow",
					signal
				});
			} catch (error) {
				if (signal?.aborted) throw new WebError("web fetch aborted", "WEB_ABORTED", { cause: error });
				throw new WebError(`web fetch failed: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
			}
			const contentType = response.headers.get("content-type") || "";
			const mime = contentType.replace(/;.*$/s, "").trim().toLowerCase();
			const kind = mime === "text/html" || mime === "application/xhtml+xml" ? "html" : "text";
			let charset = "utf-8";
			const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
			if (match?.[1]) charset = match[1].trim().toLowerCase();
			let decoder;
			try {
				decoder = new TextDecoder(charset);
			} catch {
				decoder = new TextDecoder("utf-8");
			}
			let rawBytes;
			let truncatedByBytes = false;
			try {
				const buffer = await response.arrayBuffer();
				if (buffer.byteLength > maxResponseBytes) {
					rawBytes = new Uint8Array(buffer.slice(0, maxResponseBytes));
					truncatedByBytes = true;
				} else rawBytes = new Uint8Array(buffer);
			} catch (error) {
				throw new WebError(`failed to read response body: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
			}
			const decodedText = decoder.decode(rawBytes);
			const truncatedByChars = decodedText.length > maxBodyChars;
			const finalContent = truncatedByChars ? decodedText.slice(0, maxBodyChars) : decodedText;
			return {
				url: response.url || targetUrl,
				statusCode: response.status,
				body: {
					kind,
					content: finalContent
				},
				truncated: truncatedByBytes || truncatedByChars
			};
		}
	};
}
//#endregion
//#region src/host/wire-auth.ts
function codexHeaders(credentials, sessionId) {
	const dshAgent = attributionHeaders()["user-agent"] ?? "dsh/unknown";
	return {
		authorization: `Bearer ${credentials.accessToken}`,
		...credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {},
		originator: CODEX_ORIGINATOR,
		"user-agent": `dsh-chatgpt-subscription/${PLUGIN_VERSION} (${dshAgent})`,
		...sessionId ? { "session-id": sessionId } : {}
	};
}
function stableSessionId(value) {
	const source = value === void 0 || value === "" ? randomUUID() : value;
	return `dsh-${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}
function retryAfterMs(headers) {
	const raw = headers.get("retry-after");
	if (raw === null) return void 0;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1e3, 10 * 6e4);
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp)) return void 0;
	return Math.min(Math.max(0, timestamp - Date.now()), 10 * 6e4);
}
//#endregion
//#region src/host/codex-images.ts
const PNG_SIGNATURE = [
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
];
function createCodexImageTool(oauth, attachments, options = {}) {
	const fetchFn = options.fetchFn ?? fetch;
	return defineTool({
		name: CODEX_IMAGE_TOOL_NAME,
		description: "Generate a PNG image using the signed-in ChatGPT subscription-backed Codex image endpoint.",
		parameters: { prompt: {
			type: "string",
			required: true,
			description: "A detailed image generation prompt."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					prompt: {
						type: "string",
						required: true
					},
					model: {
						type: "string",
						required: true
					},
					image: {
						type: "object",
						required: true,
						additionalProperties: true,
						properties: {
							attachmentId: {
								type: "string",
								required: true
							},
							mediaType: {
								type: "string",
								enum: ["image/png"],
								required: true
							},
							bytes: {
								type: "integer",
								required: true
							},
							width: {
								type: "integer",
								required: true
							},
							height: {
								type: "integer",
								required: true
							},
							name: { type: "string" }
						}
					}
				}
			},
			render: (_args, value) => {
				const output = value;
				return [{
					type: "text",
					text: `Generated image for: ${output.prompt}`
				}, {
					type: "image",
					attachment: output.image
				}];
			}
		},
		timeoutMs: 5 * 6e4,
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			kind: "other",
			title: "Generate image",
			rawInput: args
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: result.isError ? "Image generation failed" : "Generated image",
			content: result.content
		}),
		async execute(args, exec) {
			const prompt = args.prompt.trim();
			if (prompt === "") throw new HarnessError("Image prompt cannot be empty.", "CODEX_IMAGE_INVALID_PROMPT");
			if (!attachments.imageLimits.mediaTypes.includes("image/png")) throw new HarnessError("PNG image attachments are not enabled in this DSH environment.", "CODEX_IMAGE_ATTACHMENT_UNSUPPORTED");
			let credentials = await imageCredentials(oauth);
			let response = await requestImage(fetchFn, credentials, prompt, String(exec.callId), exec.signal);
			if (response.status === 401) {
				await response.body?.cancel().catch(() => void 0);
				credentials = await imageCredentials(oauth, true);
				response = await requestImage(fetchFn, credentials, prompt, String(exec.callId), exec.signal);
			}
			if (response.status === 429) {
				await response.body?.cancel().catch(() => void 0);
				throw new HarnessError("Codex image generation was rate limited.", "CODEX_IMAGE_RATE_LIMITED");
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => void 0);
				throw new HarnessError(`Codex image generation failed (${response.status}).`, "CODEX_IMAGE_FAILED");
			}
			const bytes = decodeImageBytes(readBase64Image(await response.json()), maxGeneratedImageBytes(attachments));
			const image = await attachments.saveImage({
				data: bytes,
				mediaType: "image/png",
				name: "codex-generated-image.png"
			});
			const output = {
				prompt,
				model: CODEX_IMAGE_MODEL,
				image: {
					attachmentId: image.attachmentId,
					mediaType: "image/png",
					bytes: image.bytes,
					width: image.width,
					height: image.height,
					...image.name !== void 0 ? { name: image.name } : {}
				}
			};
			if (exec.parent !== void 0) exec.deferContext(createUserMessage({
				content: [{
					type: "image",
					attachment: image
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-chatgpt-subscription",
					form: "notice",
					summary: "Generated image from Codex image tool."
				}
			}));
			return output;
		}
	});
}
async function imageCredentials(oauth, force = false) {
	try {
		return await oauth.credentials(force);
	} catch (error) {
		throw new HarnessError("ChatGPT subscription credentials are required for Codex image generation.", "CODEX_IMAGE_CREDENTIAL_MISSING", { cause: error });
	}
}
function requestImage(fetchFn, credentials, prompt, turnId, signal) {
	return fetchFn(CODEX_IMAGE_GENERATION_URL, {
		method: "POST",
		headers: {
			...codexHeaders(credentials),
			originator: "pi",
			accept: "application/json",
			"content-type": "application/json",
			"x-codex-image-turn-id": turnId
		},
		body: JSON.stringify({
			prompt,
			background: "auto",
			model: CODEX_IMAGE_MODEL,
			quality: "auto",
			size: "auto"
		}),
		signal
	});
}
function readBase64Image(value) {
	const root = record$4(value);
	const data = Array.isArray(root?.data) ? root.data[0] : null;
	const image = string$2(record$4(data)?.b64_json) ?? string$2(record$4(data)?.image_base64) ?? string$2(root?.b64_json) ?? string$2(root?.image);
	if (image === null) throw new HarnessError("Codex image response did not include image data.", "CODEX_IMAGE_RESPONSE_INVALID");
	return image;
}
function decodeImageBytes(base64, maxBytes) {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new HarnessError("Codex image response was not valid base64.", "CODEX_IMAGE_RESPONSE_INVALID");
	const buffer = Buffer.from(base64, "base64");
	if (buffer.length > maxBytes) throw new HarnessError("Generated image exceeds the configured attachment size limit.", "CODEX_IMAGE_TOO_LARGE");
	for (const [index, byte] of PNG_SIGNATURE.entries()) if (buffer[index] !== byte) throw new HarnessError("Codex image response was not a PNG image.", "CODEX_IMAGE_RESPONSE_INVALID");
	return buffer;
}
function maxGeneratedImageBytes(attachments) {
	return Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
}
function record$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function string$2(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
//#endregion
//#region src/host/codex-search.ts
const DEFAULT_SEARCH_MODEL = "gpt-5.6-luna";
function createCodexSearchProvider(oauth, options = {}) {
	const fetchFn = options.fetchFn ?? fetch;
	const model = options.model ?? DEFAULT_SEARCH_MODEL;
	const idFactory = options.idFactory ?? randomUUID;
	return {
		id: CODEX_SEARCH_PROVIDER_ID,
		available: () => true,
		async search(request, signal) {
			const query = request.query.trim();
			if (query === "") return {
				sources: [],
				truncated: false
			};
			let credentials = await searchCredentials(oauth);
			let response = await sendSearch(fetchFn, credentials, query, model, idFactory(), signal);
			if (response.status === 401) {
				await response.body?.cancel().catch(() => void 0);
				credentials = await searchCredentials(oauth, true);
				response = await sendSearch(fetchFn, credentials, query, model, idFactory(), signal);
			}
			if (response.status === 429) {
				await response.body?.cancel().catch(() => void 0);
				throw new WebError("Codex subscription search was rate limited.", "WEB_PROVIDER_RATE_LIMITED");
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => void 0);
				throw new WebError(`Codex subscription search failed (${response.status}).`, "WEB_PROVIDER_ERROR");
			}
			return normalizeSearchResult(await response.json(), request.maxResults);
		}
	};
}
async function searchCredentials(oauth, force = false) {
	try {
		return await oauth.credentials(force);
	} catch (error) {
		throw new WebError("ChatGPT subscription credentials are required for Codex search.", "WEB_PROVIDER_CREDENTIAL_MISSING", { cause: error });
	}
}
function sendSearch(fetchFn, credentials, query, model, id, signal) {
	return fetchFn(CODEX_SEARCH_URL, {
		method: "POST",
		headers: {
			...codexHeaders(credentials),
			originator: "pi",
			accept: "application/json",
			"content-type": "application/json"
		},
		body: JSON.stringify({
			id,
			model,
			input: query,
			commands: { search_query: [{ q: query }] },
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true
			},
			max_output_tokens: 4096
		}),
		signal
	});
}
function normalizeSearchResult(data, maxResults) {
	const sources = dedupeSources(readSources(data));
	const limit = typeof maxResults === "number" && Number.isFinite(maxResults) && maxResults >= 0 ? Math.floor(maxResults) : void 0;
	const truncated = limit !== void 0 && sources.length > limit;
	return {
		content: readContent(data),
		sources: limit !== void 0 ? sources.slice(0, limit) : sources,
		truncated
	};
}
function readSources(data) {
	const root = record$3(data);
	if (root === null) return [];
	const candidates = [
		root.sources,
		root.results,
		record$3(root.search_result)?.sources,
		record$3(root.web_search)?.sources
	];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;
		const sources = candidate.map(readSource).filter(isSource);
		if (sources.length > 0) return sources;
	}
	return [];
}
function readSource(value) {
	const data = record$3(value);
	if (data === null) return null;
	const url = string$1(data.url) ?? string$1(data.link) ?? string$1(data.uri);
	if (url === null || !isHttpUrl(url)) return null;
	const title = string$1(data.title) ?? string$1(data.name);
	const snippet = string$1(data.snippet) ?? string$1(data.text) ?? string$1(data.description);
	const publishedAt = string$1(data.published_at) ?? string$1(data.publishedAt);
	return {
		url,
		...title !== null ? { title } : {},
		...snippet !== null ? { snippet } : {},
		...publishedAt !== null ? { publishedAt } : {}
	};
}
function readContent(data) {
	const root = record$3(data);
	if (root === null) return void 0;
	return string$1(root.content) ?? string$1(root.output_text) ?? string$1(root.summary) ?? void 0;
}
function dedupeSources(sources) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const source of sources) {
		const key = source.url.trim().toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(source);
	}
	return result;
}
function record$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function string$1(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function isHttpUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
function isSource(value) {
	return value !== null;
}
//#endregion
//#region src/host/callback-server.ts
/** One-shot localhost OAuth callback listener. */
var OAuthCallbackServer = class {
	options;
	abortController = new AbortController();
	server = null;
	settled = false;
	resolveCompletion;
	rejectCompletion;
	completion = new Promise((resolve, reject) => {
		this.resolveCompletion = resolve;
		this.rejectCompletion = reject;
	});
	constructor(options) {
		this.options = options;
	}
	async listen() {
		if (this.server !== null) throw new Error("OAuth callback server already started");
		const server = http.createServer((request, response) => {
			this.handle(request, response);
		});
		this.server = server;
		await new Promise((resolve, reject) => {
			const onError = (error) => reject(error);
			server.once("error", onError);
			server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
				server.off("error", onError);
				resolve();
			});
		}).catch((error) => {
			this.server = null;
			server.close();
			throw error;
		});
	}
	cancel(reason) {
		this.finish(reason);
	}
	dispose() {
		if (!this.settled) this.finish(/* @__PURE__ */ new Error("OAuth callback listener disposed"));
		else this.close();
	}
	async handle(request, response) {
		if (this.settled) {
			await writeHtml(response, 410, "This sign-in attempt is no longer active.");
			return;
		}
		if (!isLoopback(request.socket.remoteAddress)) {
			await writeHtml(response, 403, "OAuth callback rejected.");
			return;
		}
		const url = new URL(request.url ?? "/", `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}`);
		if (url.pathname !== "/auth/callback") {
			await writeHtml(response, 404, "Not found.");
			return;
		}
		const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (providerError !== null || code === null || code === "" || state !== this.options.expectedState) {
			await writeHtml(response, 400, "ChatGPT returned an invalid OAuth callback.");
			this.finish(/* @__PURE__ */ new Error(providerError === null ? "invalid OAuth callback" : "OAuth provider rejected sign-in"));
			return;
		}
		try {
			await this.options.exchange(code, this.abortController.signal);
			await writeHtml(response, 200, "ChatGPT sign-in completed. You can close this window.");
			this.finish();
		} catch (error) {
			await writeHtml(response, 500, "ChatGPT sign-in could not be completed. Return to DSH for details.");
			this.finish(error instanceof Error ? error : /* @__PURE__ */ new Error("OAuth token exchange failed"));
		}
	}
	finish(error) {
		if (this.settled) return;
		this.settled = true;
		this.abortController.abort();
		this.close();
		if (error === void 0) this.resolveCompletion();
		else this.rejectCompletion(error);
	}
	close() {
		const server = this.server;
		this.server = null;
		server?.close();
		server?.closeAllConnections();
	}
};
function isLoopback(address) {
	if (address === void 0) return false;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function writeHtml(response, status, message) {
	const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		connection: "close"
	});
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		response.once("finish", done);
		response.once("close", done);
		response.end(`<!doctype html><meta charset="utf-8"><title>DSH Codex sign-in</title><h1>${escaped}</h1>`);
	});
}
//#endregion
//#region src/host/oauth-service.ts
var OAuthServiceError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "OAuthServiceError";
	}
};
var OAuthService = class {
	store;
	fetchFn;
	now;
	random;
	logger;
	loginTimeoutMs;
	loginEvents = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Map();
	activeLogin = null;
	refreshPromise = null;
	lastLoginError;
	disposed = false;
	constructor(store, options = {}) {
		this.store = store;
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? randomBytes;
		this.logger = options.logger ?? console;
		this.loginTimeoutMs = options.loginTimeoutMs ?? 3e5;
	}
	async status() {
		try {
			const credentials = await this.store.load();
			return this.statusFromCredentials(credentials);
		} catch {
			return {
				...this.statusFromCredentials(null, false),
				error: publicError(new OAuthServiceError("storage-failed", "Secure credential storage could not be read."))
			};
		}
	}
	async startLogin() {
		this.assertAvailable();
		await this.store.load().catch(() => {
			throw new OAuthServiceError("storage-failed", "Secure credential storage is unavailable. Fix its ownership or permissions before signing in.");
		});
		if (this.activeLogin !== null) throw new OAuthServiceError("login-active", "A ChatGPT sign-in is already in progress.");
		this.lastLoginError = void 0;
		const loginId = this.random(24).toString("base64url");
		const verifier = this.random(48).toString("base64url");
		const state = this.random(32).toString("base64url");
		const expiresAt = this.now() + this.loginTimeoutMs;
		const server = new OAuthCallbackServer({
			expectedState: state,
			exchange: async (code, signal) => this.exchangeCode(code, verifier, signal)
		});
		try {
			await server.listen();
		} catch {
			server.completion.catch(() => void 0);
			server.dispose();
			throw new OAuthServiceError("internal", "The localhost OAuth callback listener could not start on port 1455.");
		}
		const timeout = setTimeout(() => {
			this.cancelActive(new OAuthServiceError("login-expired", "ChatGPT sign-in timed out."), "failed");
		}, this.loginTimeoutMs);
		timeout.unref?.();
		this.activeLogin = {
			id: loginId,
			expiresAt,
			server,
			timeout
		};
		this.publish({
			type: "pending",
			loginId
		});
		server.completion.then(() => {
			this.completeLogin(loginId);
		}).catch((error) => {
			this.failLogin(loginId, error);
		});
		this.logger.info("[dsh-chatgpt-subscription] OAuth login started");
		return {
			loginId,
			authUrl: buildAuthorizationUrl(verifier, state),
			expiresAt
		};
	}
	cancelLogin(loginId) {
		if (this.activeLogin === null || this.activeLogin.id !== loginId) throw new OAuthServiceError("bad-request", "The requested sign-in is not active.");
		this.cancelActive(new OAuthServiceError("login-cancelled", "ChatGPT sign-in was cancelled."), "cancelled");
	}
	subscribe(loginId, listener) {
		const current = this.loginEvents.get(loginId);
		if (current === void 0) return null;
		let set = this.listeners.get(loginId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			this.listeners.set(loginId, set);
		}
		set.add(listener);
		listener(current);
		return () => {
			set?.delete(listener);
			if (set?.size === 0) this.listeners.delete(loginId);
		};
	}
	async refresh() {
		this.assertAvailable();
		const stored = await this.loadAuthenticated();
		await this.refreshCredentials(stored);
		return this.status();
	}
	async logout() {
		if (this.activeLogin !== null) this.cancelActive(new OAuthServiceError("login-cancelled", "ChatGPT sign-in was cancelled."), "cancelled");
		await this.store.clear().catch(() => {
			throw new OAuthServiceError("storage-failed", "Secure credentials could not be deleted.");
		});
		this.lastLoginError = void 0;
		this.logger.info("[dsh-chatgpt-subscription] OAuth credentials cleared");
	}
	async credentials(forceRefresh = false) {
		const stored = await this.loadAuthenticated();
		if (forceRefresh || stored.expiresAt - this.now() <= 6e4) return this.refreshCredentials(stored);
		return stored;
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.activeLogin !== null) this.cancelActive(new OAuthServiceError("login-cancelled", "ChatGPT sign-in was cancelled."), "cancelled");
		this.listeners.clear();
		this.loginEvents.clear();
	}
	async exchangeCode(code, verifier, signal) {
		const response = await this.fetchFn(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: OAUTH_REDIRECT_URI,
				client_id: CHATGPT_OAUTH_CLIENT_ID,
				code_verifier: verifier
			}).toString(),
			signal
		}).catch(() => {
			throw new OAuthServiceError("oauth-token-exchange-failed", "ChatGPT token exchange could not be reached.");
		});
		if (!response.ok) {
			const detail = await oauthErrorIdentifier(response);
			throw new OAuthServiceError("oauth-token-exchange-failed", `ChatGPT token exchange failed (${response.status}${detail === null ? "" : `, ${detail}`}).`);
		}
		const credentials = credentialsFromTokenResponse(await response.json(), this.now());
		await this.store.save(credentials).catch(() => {
			throw new OAuthServiceError("storage-failed", "ChatGPT credentials could not be saved securely.");
		});
	}
	refreshCredentials(stored) {
		if (this.refreshPromise !== null) return this.refreshPromise;
		this.refreshPromise = this.performRefresh(stored).finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}
	async performRefresh(stored) {
		const response = await this.fetchFn(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: stored.refreshToken,
				client_id: CHATGPT_OAUTH_CLIENT_ID
			}).toString()
		}).catch(() => {
			throw new OAuthServiceError("refresh-failed", "ChatGPT token refresh could not be reached.");
		});
		if (!response.ok) {
			const detail = await oauthErrorIdentifier(response);
			if (response.status === 400 || response.status === 401) await this.store.clear().catch(() => {
				throw new OAuthServiceError("storage-failed", "Expired ChatGPT credentials could not be deleted securely.");
			});
			throw new OAuthServiceError("refresh-failed", `ChatGPT token refresh failed (${response.status}${detail === null ? "" : `, ${detail}`}). Sign in again.`);
		}
		const fresh = credentialsFromTokenResponse(await response.json(), this.now(), stored);
		await this.store.save(fresh).catch(() => {
			throw new OAuthServiceError("storage-failed", "Refreshed credentials could not be saved securely.");
		});
		this.logger.info("[dsh-chatgpt-subscription] OAuth credentials refreshed");
		return fresh;
	}
	async loadAuthenticated() {
		const stored = await this.store.load().catch(() => {
			throw new OAuthServiceError("storage-failed", "Secure credential storage could not be read.");
		});
		if (stored === null) throw new OAuthServiceError("not-authenticated", "Sign in with ChatGPT first.");
		return stored;
	}
	statusFromCredentials(credentials, storageAvailable = true) {
		const active = this.activeLogin;
		if (credentials === null) return {
			authenticated: false,
			account: null,
			storage: {
				...this.store.storage,
				available: storageAvailable
			},
			login: {
				active: active !== null,
				loginId: active?.id ?? null,
				expiresAt: active === null ? null : Math.floor(active.expiresAt / 1e3)
			},
			...this.lastLoginError === void 0 ? {} : { error: this.lastLoginError }
		};
		const identity = extractIdentity(credentials);
		return {
			authenticated: true,
			account: {
				email: maskEmail(credentials.email ?? identity.email),
				planType: credentials.planType ?? identity.planType ?? null,
				accountIdSuffix: maskAccountId(credentials.accountId ?? identity.accountId),
				tokenExpiresAt: Math.floor(credentials.expiresAt / 1e3)
			},
			storage: {
				...this.store.storage,
				available: storageAvailable
			},
			login: {
				active: active !== null,
				loginId: active?.id ?? null,
				expiresAt: active === null ? null : Math.floor(active.expiresAt / 1e3)
			},
			...this.lastLoginError === void 0 ? {} : { error: this.lastLoginError }
		};
	}
	completeLogin(loginId) {
		if (this.activeLogin?.id !== loginId) return;
		clearTimeout(this.activeLogin.timeout);
		this.activeLogin = null;
		this.lastLoginError = void 0;
		this.publish({
			type: "completed",
			loginId
		});
		this.logger.info("[dsh-chatgpt-subscription] OAuth login completed");
	}
	failLogin(loginId, error) {
		if (this.activeLogin?.id !== loginId) return;
		clearTimeout(this.activeLogin.timeout);
		this.activeLogin = null;
		const mapped = publicError(error, "oauth-callback-invalid");
		this.lastLoginError = mapped;
		this.publish({
			type: "failed",
			loginId,
			error: mapped
		});
		this.logger.warn(`[dsh-chatgpt-subscription] OAuth login failed (${mapped.code}): ${mapped.message}`);
	}
	cancelActive(error, outcome) {
		const active = this.activeLogin;
		if (active === null) return;
		clearTimeout(active.timeout);
		this.activeLogin = null;
		active.server.cancel(error);
		this.publish(outcome === "cancelled" ? {
			type: "cancelled",
			loginId: active.id
		} : {
			type: "failed",
			loginId: active.id,
			error: publicError(error)
		});
	}
	publish(event) {
		this.loginEvents.set(event.loginId, event);
		for (const listener of this.listeners.get(event.loginId) ?? []) listener(event);
	}
	assertAvailable() {
		if (this.disposed) throw new OAuthServiceError("internal", "The OAuth service has been disposed.");
	}
};
function buildAuthorizationUrl(verifier, state) {
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return `${OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
		response_type: "code",
		client_id: CHATGPT_OAUTH_CLIENT_ID,
		redirect_uri: OAUTH_REDIRECT_URI,
		scope: OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state,
		originator: OAUTH_ORIGINATOR
	}).toString()}`;
}
function parseJwtClaims(token) {
	if (token === void 0) return void 0;
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	try {
		const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return typeof value === "object" && value !== null ? value : void 0;
	} catch {
		return;
	}
}
function publicError(error, fallback = "internal") {
	if (error instanceof OAuthServiceError) return {
		code: error.code,
		message: error.message
	};
	return {
		code: fallback,
		message: "The ChatGPT sign-in operation failed."
	};
}
function credentialsFromTokenResponse(response, now, previous) {
	if (typeof response.access_token !== "string" || response.access_token === "") throw new OAuthServiceError("oauth-token-exchange-failed", "ChatGPT returned no access token.");
	const refreshToken = typeof response.refresh_token === "string" && response.refresh_token !== "" ? response.refresh_token : previous?.refreshToken;
	if (refreshToken === void 0) throw new OAuthServiceError("oauth-token-exchange-failed", "ChatGPT returned no refresh token.");
	const seconds = Number(response.expires_in);
	const expiresIn = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
	const base = {
		accessToken: response.access_token,
		refreshToken,
		idToken: typeof response.id_token === "string" ? response.id_token : previous?.idToken,
		expiresAt: now + expiresIn * 1e3
	};
	const identity = extractIdentity(base);
	return {
		...base,
		accountId: identity.accountId ?? previous?.accountId,
		email: identity.email ?? previous?.email,
		planType: identity.planType ?? previous?.planType
	};
}
function extractIdentity(credentials) {
	const result = {};
	for (const token of [credentials.idToken, credentials.accessToken]) {
		const claims = parseJwtClaims(token);
		if (claims === void 0) continue;
		const nested = claims["https://api.openai.com/auth"];
		result.email ??= stringClaim(claims.email);
		result.planType ??= stringClaim(claims.chatgpt_plan_type) ?? stringClaim(nested?.chatgpt_plan_type);
		result.accountId ??= stringClaim(claims.chatgpt_account_id) ?? stringClaim(nested?.chatgpt_account_id) ?? stringClaim(claims.organizations?.[0]?.id) ?? stringClaim(nested?.organizations?.[0]?.id);
	}
	return result;
}
function stringClaim(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function maskEmail(email) {
	if (email === void 0) return null;
	const at = email.indexOf("@");
	if (at <= 0 || at === email.length - 1) return "***";
	return `${email.slice(0, 1)}***${email.slice(at)}`;
}
function maskAccountId(accountId) {
	if (accountId === void 0) return null;
	return `…${accountId.slice(-4)}`;
}
async function oauthErrorIdentifier(response) {
	const payload = await response.json().catch(() => null);
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const error = payload.error;
	const candidates = typeof error === "object" && error !== null && !Array.isArray(error) ? [error.code, error.type] : [error];
	for (const candidate of candidates) if (typeof candidate === "string" && /^[a-z0-9_.-]{1,64}$/i.test(candidate)) return candidate;
	return null;
}
//#endregion
//#region src/host/proxy-manager.ts
const SYSTEM_PROXY_CACHE_TTL_MS = 5e3;
function normalizeProxyUrl(rawUrl) {
	const trimmed = rawUrl.trim();
	if (!trimmed) return "";
	if (/^https?:\/\//i.test(trimmed) || /^socks5?:\/\//i.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}
function parseWindowsProxyRegistry(stdout) {
	const enableMatch = stdout.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i);
	if (!enableMatch) return null;
	if ((enableMatch[1].startsWith("0x") ? parseInt(enableMatch[1], 16) : parseInt(enableMatch[1], 10)) !== 1) return null;
	const serverMatch = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
	if (!serverMatch) return null;
	const rawServer = serverMatch[1].trim();
	if (!rawServer) return null;
	if (rawServer.includes("=")) {
		const pairs = rawServer.split(";");
		const map = {};
		for (const pair of pairs) {
			const [proto, addr] = pair.split("=").map((s) => s.trim());
			if (proto && addr) map[proto.toLowerCase()] = addr;
		}
		const target = map.https || map.http || map.socks;
		if (target) {
			if (map.socks && !map.https && !map.http) return normalizeProxyUrl(target.startsWith("socks") ? target : `socks5://${target}`);
			return normalizeProxyUrl(target);
		}
		return null;
	}
	return normalizeProxyUrl(rawServer);
}
function parseMacOsScutilProxy(stdout) {
	const httpsEnable = /HTTPSEnable\s*:\s*1/i.test(stdout);
	const httpEnable = /HTTPEnable\s*:\s*1/i.test(stdout);
	const socksEnable = /SOCKSEnable\s*:\s*1/i.test(stdout);
	if (httpsEnable) {
		const host = stdout.match(/HTTPSProxy\s*:\s*([^\s\r\n]+)/i)?.[1];
		const port = stdout.match(/HTTPSPort\s*:\s*(\d+)/i)?.[1];
		if (host && port) return normalizeProxyUrl(`${host}:${port}`);
	}
	if (httpEnable) {
		const host = stdout.match(/HTTPProxy\s*:\s*([^\s\r\n]+)/i)?.[1];
		const port = stdout.match(/HTTPPort\s*:\s*(\d+)/i)?.[1];
		if (host && port) return normalizeProxyUrl(`${host}:${port}`);
	}
	if (socksEnable) {
		const host = stdout.match(/SOCKSProxy\s*:\s*([^\s\r\n]+)/i)?.[1];
		const port = stdout.match(/SOCKSPort\s*:\s*(\d+)/i)?.[1];
		if (host && port) return normalizeProxyUrl(`socks5://${host}:${port}`);
	}
	return null;
}
function parseEnvProxy(env = process.env) {
	const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
	if (!proxy || !proxy.trim()) return null;
	return normalizeProxyUrl(proxy);
}
function detectSystemProxy(platform = process.platform, env = process.env) {
	try {
		if (platform === "win32") {
			const detected = parseWindowsProxyRegistry(execSync("reg query \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\"", {
				timeout: 1500,
				encoding: "utf-8",
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				]
			}));
			if (detected) return detected;
		} else if (platform === "darwin") {
			const detected = parseMacOsScutilProxy(execSync("scutil --proxy", {
				timeout: 1500,
				encoding: "utf-8",
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				]
			}));
			if (detected) return detected;
		}
	} catch {}
	return parseEnvProxy(env);
}
var ProxyManager = class {
	getPreferences;
	baseFetch;
	systemProxyDetector;
	logger;
	cachedSystemProxy = null;
	lastSystemProxyCheck = 0;
	agents = /* @__PURE__ */ new Map();
	constructor(options) {
		this.getPreferences = options.getPreferences;
		this.baseFetch = options.baseFetch ?? fetch;
		this.systemProxyDetector = options.systemProxyDetector ?? (() => detectSystemProxy());
		this.logger = options.logger;
	}
	getSystemProxy(force = false) {
		const now = Date.now();
		if (!force && now - this.lastSystemProxyCheck < SYSTEM_PROXY_CACHE_TTL_MS) return this.cachedSystemProxy;
		this.lastSystemProxyCheck = now;
		try {
			this.cachedSystemProxy = this.systemProxyDetector();
		} catch (error) {
			this.cachedSystemProxy = null;
			this.logger?.warn?.(`[dsh-chatgpt-subscription] Failed to detect system proxy: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.cachedSystemProxy;
	}
	resolveActiveProxyUrl() {
		const prefs = this.getPreferences();
		const mode = prefs.proxyMode ?? "auto";
		if (mode === "direct") return null;
		if (mode === "custom") return prefs.customProxyUrl ? normalizeProxyUrl(prefs.customProxyUrl) : null;
		return this.getSystemProxy();
	}
	getOrCreateAgent(proxyUrl) {
		let agent = this.agents.get(proxyUrl);
		if (!agent) {
			agent = new ProxyAgent(proxyUrl);
			this.agents.set(proxyUrl, agent);
		}
		return agent;
	}
	createFetch() {
		return async (input, init) => {
			const activeProxy = this.resolveActiveProxyUrl();
			if (!activeProxy) return this.baseFetch(input, init);
			try {
				const agent = this.getOrCreateAgent(activeProxy);
				return await fetch$1(input, {
					...init,
					dispatcher: agent
				});
			} catch (error) {
				throw error;
			}
		};
	}
	dispose() {
		for (const agent of this.agents.values()) agent.destroy().catch(() => void 0);
		this.agents.clear();
	}
};
//#endregion
//#region src/shared/preferences.ts
const PREFERENCES_NAMESPACE = "dsh-chatgpt-subscription";
const DEFAULT_PREFERENCES = {
	quickQuotaVisible: false,
	fastMode: false,
	outputVerbosity: null,
	reasoningSummary: null,
	visibleModelIds: [...DEFAULT_VISIBLE_CODEX_MODEL_IDS],
	searchProvider: "dsh",
	contextWindowOverrides: {
		"gpt-6-astra": 272e3,
		"gpt-5.6-sol": 272e3,
		"gpt-5.6-terra": 272e3,
		"gpt-5.6-luna": 272e3
	},
	subagentContextWindow: null,
	subagentMaxDepth: null,
	proxyMode: "auto",
	customProxyUrl: null
};
const SEARCH_PROVIDER_CODEX = "codex";
function isSearchProviderPreference(value) {
	return value === "dsh" || value === "codex";
}
function isCodexOutputVerbosity(value) {
	return value === "low" || value === "medium" || value === "high";
}
function isCodexReasoningSummary(value) {
	return value === "auto" || value === "concise" || value === "detailed" || value === "none";
}
function isProxyMode(value) {
	return value === "auto" || value === "custom" || value === "direct";
}
//#endregion
//#region src/host/preferences.ts
function registerPreferenceStore(settings) {
	const ns = SettingsModule.settingsNamespace ? SettingsModule.settingsNamespace(PREFERENCES_NAMESPACE) : PREFERENCES_NAMESPACE;
	return new SettingsPreferenceStore(settings.register.call(settings, ns, z.object({
		quickQuotaVisible: z.boolean().default(DEFAULT_PREFERENCES.quickQuotaVisible),
		fastMode: z.boolean().default(DEFAULT_PREFERENCES.fastMode),
		outputVerbosity: z.union([
			z.const("low"),
			z.const("medium"),
			z.const("high"),
			z.const(null)
		]).default(DEFAULT_PREFERENCES.outputVerbosity),
		reasoningSummary: z.union([
			z.const("auto"),
			z.const("concise"),
			z.const("detailed"),
			z.const("none"),
			z.const(null)
		]).default(DEFAULT_PREFERENCES.reasoningSummary),
		visibleModelIds: z.array(z.string()).default(DEFAULT_PREFERENCES.visibleModelIds),
		searchProvider: z.union([z.const("dsh"), z.const(SEARCH_PROVIDER_CODEX)]).default(DEFAULT_PREFERENCES.searchProvider),
		contextWindowOverrides: z.object({
			"gpt-6-astra": z.number().step(1).min(1).max(GPT_6_ASTRA_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-6-astra"]),
			"gpt-5.6-sol": z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-5.6-sol"]),
			"gpt-5.6-terra": z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-5.6-terra"]),
			"gpt-5.6-luna": z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-5.6-luna"])
		}).default(DEFAULT_PREFERENCES.contextWindowOverrides),
		subagentContextWindow: z.union([z.number().step(1).min(1), z.const(null)]).default(DEFAULT_PREFERENCES.subagentContextWindow),
		subagentMaxDepth: z.union([z.number().step(1).min(0).max(3), z.const(null)]).default(DEFAULT_PREFERENCES.subagentMaxDepth),
		proxyMode: z.union([
			z.const("auto"),
			z.const("custom"),
			z.const("direct")
		]).default(DEFAULT_PREFERENCES.proxyMode),
		customProxyUrl: z.union([z.string(), z.const(null)]).default(DEFAULT_PREFERENCES.customProxyUrl)
	})));
}
var SettingsPreferenceStore = class {
	scope;
	constructor(scope) {
		this.scope = scope;
	}
	status() {
		return withWritable(this.scope.get());
	}
	async update(patch) {
		const normalized = {};
		if (patch.quickQuotaVisible !== void 0) normalized.quickQuotaVisible = patch.quickQuotaVisible;
		if (patch.fastMode !== void 0) normalized.fastMode = patch.fastMode;
		if (patch.outputVerbosity !== void 0) {
			if (patch.outputVerbosity !== null && !isCodexOutputVerbosity(patch.outputVerbosity)) throw new PreferenceError("Unsupported output verbosity preference.");
			normalized.outputVerbosity = patch.outputVerbosity;
		}
		if (patch.reasoningSummary !== void 0) {
			if (patch.reasoningSummary !== null && !isCodexReasoningSummary(patch.reasoningSummary)) throw new PreferenceError("Unsupported reasoning summary preference.");
			normalized.reasoningSummary = patch.reasoningSummary;
		}
		if (patch.visibleModelIds !== void 0) {
			if (patch.visibleModelIds.length === 0 || !patch.visibleModelIds.every(isCodexModelId)) throw new PreferenceError("At least one supported Codex model must be visible.");
			normalized.visibleModelIds = [...new Set(patch.visibleModelIds)];
		}
		if (patch.searchProvider !== void 0) {
			if (!isSearchProviderPreference(patch.searchProvider)) throw new PreferenceError("Unsupported search provider preference.");
			normalized.searchProvider = patch.searchProvider;
		}
		if (patch.contextWindowOverrides !== void 0) normalized.contextWindowOverrides = {
			...this.scope.get().contextWindowOverrides,
			...patch.contextWindowOverrides
		};
		if (patch.subagentContextWindow !== void 0) normalized.subagentContextWindow = patch.subagentContextWindow;
		if (patch.subagentMaxDepth !== void 0) normalized.subagentMaxDepth = patch.subagentMaxDepth;
		if (patch.proxyMode !== void 0) {
			if (!isProxyMode(patch.proxyMode)) throw new PreferenceError("Unsupported proxy mode preference.");
			normalized.proxyMode = patch.proxyMode;
		}
		if (patch.customProxyUrl !== void 0) if (patch.customProxyUrl !== null) {
			const trimmed = patch.customProxyUrl.trim();
			if (trimmed.length > 0 && !/^https?:\/\//i.test(trimmed) && !/^socks5?:\/\//i.test(trimmed)) normalized.customProxyUrl = `http://${trimmed}`;
			else normalized.customProxyUrl = trimmed.length === 0 ? null : trimmed;
		} else normalized.customProxyUrl = null;
		await this.scope.update(normalized);
		return this.status();
	}
	watch(callback) {
		return this.scope.watch((next, prev) => callback(withWritable(next), withWritable(prev)));
	}
};
var PreferenceError = class extends Error {
	constructor(message) {
		super(message);
	}
};
function withWritable(value) {
	return {
		...value,
		writable: true
	};
}
//#endregion
//#region node_modules/@deepseek-ai/dsh-timeout/lib/index.js
/**
* Shared timeout arithmetic, signal fusion, and classification. The library
* only notifies through abort signals; each capability still owns the mechanism
* that stops its work and translates timeout reasons into public outcomes.
* @module @deepseek-ai/dsh-timeout
*/
/**
* Internal abort reason carrying a capability-owned code and elapsed deadline.
* Providers translate it through {@link timeoutOf} before returning to callers.
*/
var TimeoutReason = class extends Error {
	code;
	timeoutMs;
	name = "TimeoutReason";
	/**
	* @param code Capability-owned timeout code (e.g. `BASH_TIMEOUT`).
	* @param timeoutMs The deadline that elapsed, in milliseconds.
	*/
	constructor(code, timeoutMs) {
		super(`${code} after ${timeoutMs}ms`);
		this.code = code;
		this.timeoutMs = timeoutMs;
	}
};
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
function assertTimerDelay(timeoutMs, name) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/**
* Create a rearmable idle watchdog for an async iterator. The timer exists only
* while {@link IdleWatchdog.next} is outstanding, so consumer think time does
* not count as provider idle time. The returned signal is stable for the whole
* call and only notifies; the iterator must observe it to terminate its work.
*
* @param upstream - caller cancellation fused into the stable signal.
* @param timeoutMs - positive finite idle interval in milliseconds.
* @param code - capability-owned code carried by the timeout reason.
* @returns a stable signal, guarded next operation, and timer disposer.
*/
function idleWatchdog(upstream, timeoutMs, code) {
	assertTimerDelay(timeoutMs, "idleWatchdog timeoutMs");
	const timeout = new AbortController();
	const signal = upstream === void 0 ? timeout.signal : AbortSignal.any([upstream, timeout.signal]);
	let timer;
	let outstanding = false;
	let disposed = false;
	const arm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			timeout.abort(new TimeoutReason(code, timeoutMs));
		}, timeoutMs);
	};
	return {
		signal,
		async next(iterator) {
			if (disposed) throw new Error("idleWatchdog is disposed");
			if (outstanding) throw new Error("idleWatchdog next is already outstanding");
			outstanding = true;
			arm();
			try {
				return await iterator.next();
			} finally {
				clearTimeout(timer);
				timer = void 0;
				outstanding = false;
			}
		},
		pulse() {
			if (disposed || !outstanding) return;
			arm();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			if (timer !== void 0) clearTimeout(timer);
			timer = void 0;
		}
	};
}
/**
* Recover a timeout reason from a reason-bearing object. Supplying `code`
* distinguishes this deadline from a nested upstream deadline; a foreign code
* follows the ordinary cancellation path.
*
* @param x An {@link AbortSignal} or any `{ reason }` carrier (e.g. a caught abort error).
* @param code When provided, only a {@link TimeoutReason} with this exact `code` matches.
* @returns The matching {@link TimeoutReason}, else `undefined`.
*/
function timeoutOf(x, code) {
	const reason = x.reason;
	if (!(reason instanceof TimeoutReason)) return void 0;
	return code === void 0 || reason.code === code ? reason : void 0;
}
//#endregion
//#region src/host/common/idle-watchdog.ts
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
const STREAM_IDLE_TIMEOUT_CODE$1 = "LLM_STREAM_IDLE_TIMEOUT";
/**
* 为异步流包裹可复位的空闲超时看门狗。
* 当流式 chunk 产出之间的间隔超过指定阈值时，主动终止并抛出带有 TIMEOUT 的 LlmError。
*/
async function* wrapStreamWithWatchdog(source, upstreamSignal, timeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS, timeoutCode = STREAM_IDLE_TIMEOUT_CODE$1, providerTag = "llm") {
	const consumer = new AbortController();
	const watchdog = idleWatchdog(upstreamSignal === void 0 ? consumer.signal : AbortSignal.any([upstreamSignal, consumer.signal]), timeoutMs, timeoutCode);
	const iterator = source(watchdog.signal)[Symbol.asyncIterator]();
	let exhausted = false;
	try {
		while (true) {
			const result = await watchdog.next(iterator);
			if (timeoutOf(watchdog.signal, timeoutCode) !== void 0) throw new LlmError(`${providerTag} stream idle timeout after ${timeoutMs}ms`, "TIMEOUT");
			if (result.done) {
				exhausted = true;
				return;
			}
			yield result.value;
		}
	} catch (error) {
		if (timeoutOf(watchdog.signal, timeoutCode) !== void 0) throw new LlmError(`${providerTag} stream idle timeout after ${timeoutMs}ms`, "TIMEOUT", { cause: error });
		if (upstreamSignal?.aborted) throw new LlmError(`${providerTag} request aborted by caller`, "ABORTED", { cause: error });
		throw error;
	} finally {
		consumer.abort(`${providerTag} stream consumer stopped`);
		if (!exhausted) try {
			await iterator.return?.(void 0);
		} catch {}
		watchdog[Symbol.dispose]();
	}
}
//#endregion
//#region src/host/responses-mapper.ts
function hiddenSandboxControlToolNames(options) {
	const retryTools = recentSandboxRetryToolNames(options.messages);
	return new Set(options.tools?.filter((tool) => hasSandboxControls(tool.parameters) && !retryTools.has(tool.name)).map((tool) => tool.name) ?? []);
}
function createCallIdNormalizer() {
	const normalizedByOriginal = /* @__PURE__ */ new Map();
	const originalByNormalized = /* @__PURE__ */ new Map();
	return (value) => {
		const original = String(value);
		const existing = normalizedByOriginal.get(original);
		if (existing !== void 0) return existing;
		const claim = (candidate) => {
			const owner = originalByNormalized.get(candidate);
			if (owner !== void 0 && owner !== original) return false;
			normalizedByOriginal.set(original, candidate);
			originalByNormalized.set(candidate, original);
			return true;
		};
		if (original.length <= 64 && claim(original)) return original;
		for (let attempt = 0;; attempt++) {
			const material = attempt === 0 ? original : `${original}\0${attempt}`;
			const candidate = `dsh_${createHash("sha256").update(material).digest("hex").slice(0, 60)}`;
			if (claim(candidate)) return candidate;
		}
	};
}
function normalizeReplayCallIds(items, normalizeCallId) {
	if (items === null) return null;
	return items.map((item) => typeof item.call_id === "string" ? {
		...item,
		call_id: normalizeCallId(item.call_id)
	} : item);
}
async function buildResponsesPayload(options, attachments, localRawImages = {}, outputVerbosity = null, fastMode = false, reasoningSummary = null) {
	const sandboxRetryTools = recentSandboxRetryToolNames(options.messages);
	const resolveLocalRawImages = supportsImageInput(options);
	const normalizeCallId = createCallIdNormalizer();
	const instructionParts = [
		options.system?.trim(),
		...options.messages.filter((message) => message.role === "system").map((message) => blocksToText(message.content).trim()),
		progressExplanationInstruction(options.tools),
		sandboxToolInstruction(options.tools, sandboxRetryTools),
		commandToolInstruction(options.tools),
		runCodeInstruction(options.tools)
	].filter((value) => Boolean(value));
	const input = [];
	const knownToolCalls = /* @__PURE__ */ new Map();
	const localImageStats = {
		attempted: 0,
		resolved: 0,
		failed: 0
	};
	for (const message of options.messages) {
		if (message.role === "system") continue;
		const replayItems = normalizeReplayCallIds(replayOutputItems(message), normalizeCallId);
		if (message.role === "assistant" && replayItems !== null) {
			input.push(...replayItems);
			for (const item of replayItems) if (item.type === "function_call" && typeof item.call_id === "string") knownToolCalls.set(item.call_id, typeof item.name === "string" ? item.name : void 0);
			if (!replayItems.some((item) => item.type === "message")) {
				const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages);
				if (content.length > 0) input.push({
					role: message.role,
					content
				});
			}
			appendMissingToolCalls(input, knownToolCalls, message, normalizeCallId);
			continue;
		}
		const toolResult = message.content.find((block) => block.type === "tool-result");
		if (toolResult?.type === "tool-result") {
			const originalCallId = String(toolResult.toolCallId);
			const callId = normalizeCallId(originalCallId);
			const rawOutput = blocksToText(toolResult.content);
			if (knownToolCalls.has(callId)) {
				const output = toolResult.isError && knownToolCalls.get(callId) === "run_code" ? runCodeErrorOutput(rawOutput) : rawOutput;
				input.push({
					type: "function_call_output",
					call_id: callId,
					output
				});
			} else input.push({
				role: "user",
				content: [{
					type: "input_text",
					text: `Tool result for unavailable call ${originalCallId}${toolResult.isError ? " (error)" : ""}:\n${rawOutput}`
				}]
			});
			continue;
		}
		const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages);
		if (content.length > 0) input.push({
			role: message.role,
			content
		});
		if (message.role === "assistant") appendMissingToolCalls(input, knownToolCalls, message, normalizeCallId);
	}
	const payload = {
		model: options.model,
		input,
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"]
	};
	const instructions = [...instructionParts, localRawImageInstruction(localImageStats)].filter((value) => Boolean(value));
	if (instructions.length > 0) payload.instructions = instructions.join("\n\n");
	if (options.tools?.length) {
		payload.tools = options.tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: toolDescriptionForCodex(tool.name, tool.description),
			parameters: toolParametersForCodex(tool.name, tool.parameters, sandboxRetryTools.has(tool.name))
		}));
		payload.tool_choice = "auto";
		payload.parallel_tool_calls = true;
	}
	if (outputVerbosity !== null) payload.text = { verbosity: outputVerbosity };
	if (fastMode) payload.service_tier = "priority";
	if (options.reasoningEffort !== void 0) {
		const effort = options.model === "gpt-6-astra" && ["none", "minimal"].includes(options.reasoningEffort) ? "low" : options.reasoningEffort;
		payload.reasoning = codexModelSupportsReasoningSummary(options.model) ? {
			effort,
			summary: reasoningSummary ?? "auto"
		} : { effort };
	}
	return payload;
}
function progressExplanationInstruction(tools) {
	if (!tools?.length) return void 0;
	return "Progress and tool execution rule: when executing multi-step tasks or invoking tools, output 1-2 concise sentences of progress, intent, or intermediate findings before each tool call. Keep progress text brief, professional, and factual. Only present the comprehensive final answer and summary in the final turn after all tool operations are completed.";
}
function runCodeInstruction(tools) {
	if (!tools?.some((tool) => tool.name === "run_code")) return void 0;
	return "run_code compatibility rule: its code is parsed as strict JavaScript/TypeScript before execution. Shell commands are nested string data: JavaScript template literals may consume ${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them. On Windows, avoid embedding PowerShell containing $, ${...}, backslashes, or here-strings in template literals; String.raw does not disable ${...} interpolation. On Linux, prefer ordinary quoted strings or write a script file before invoking bash/sh, especially for commands containing backticks or ${...}. Prefer arrays of ordinary quoted strings joined with \"\\n\", escaping backslashes, or use a file-write tool for large scripts.";
}
function localRawImageInstruction(stats) {
	if (stats.failed === 0) return void 0;
	return "Image attachment rule: a user message contains a markdown image link to a local/raw session URL but no structured image attachment. That link is not accessible image bytes for the provider. Do not claim to see the image; ask the user to resend it as an actual image attachment if visual inspection is required.";
}
function supportsImageInput(options) {
	return options.provider === "codex-chatgpt" && codexModelSupportsImageInput(options.model);
}
function toolDescriptionForCodex(name, description) {
	if (name === "run_code") return `${description}\n\nCompatibility: code is strict JavaScript/TypeScript and nested shell commands are string data. Template literals may consume \${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them. Prefer ordinary quoted string arrays joined with "\\n", or write a script file with a dedicated file tool before invoking the shell.`;
	if (isCommandTool(name)) return `${description}\n\n${commandToolCompatibilityText(name)}`;
	return description;
}
function commandToolInstruction(tools) {
	const names = tools?.filter((tool) => isCommandTool(tool.name)).map((tool) => tool.name);
	if (!names?.length) return void 0;
	const uniqueNames = [...new Set(names)];
	const normalized = uniqueNames.map((name) => name.toLowerCase());
	const shellGuidance = [
		normalized.some((name) => name === "pwsh" || name.includes("powershell")) ? "For pwsh/PowerShell, use native PowerShell syntax and native Windows paths." : void 0,
		normalized.includes("bash") ? "For bash, use native POSIX paths and Bash syntax in a fresh non-interactive process." : void 0,
		normalized.some((name) => name === "sh" || name === "shell") ? "For sh/generic shell, prefer portable POSIX syntax and avoid Bash-only arrays, [[ ... ]], process substitution, and source." : void 0
	].filter((value) => value !== void 0).join(" ");
	return `Command tool compatibility rule (${uniqueNames.join(", ")}): each command call runs in a fresh process, so do not rely on cd, aliases, functions, or variables from previous calls; set workdir when the tool supports it. ${shellGuidance} For deletion or move operations, first resolve and verify exact absolute target paths, then operate on those literal paths only; avoid dynamically deleting paths built from home-directory expansion, wildcards, command substitution, or another shell's output. Treat [auto-mode hard deny] and similar policy denials as non-retriable; choose a safer non-destructive inspection or report the limitation instead of repeating the same command or adding sandbox escalation. If downloads fail with TLS credential or connection-closed errors, treat that as an environment/network failure and use local sources or report the limitation instead of cycling through equivalent download commands.`;
}
function commandToolCompatibilityText(name) {
	const shell = name.toLowerCase();
	return `Compatibility: command execution is stateless between calls.${shell === "pwsh" || shell.includes("powershell") ? " Use native PowerShell syntax and native Windows paths." : shell === "bash" ? " Use Bash syntax and native POSIX paths." : " Use portable POSIX syntax and native POSIX paths; avoid Bash-only arrays, [[ ... ]], process substitution, and source."} Prefer workdir over cd because every call starts a fresh process. For destructive operations, verify exact absolute targets first and use literal paths; policy hard-deny results require a safer command shape, not sandbox escalation.`;
}
function sandboxToolInstruction(tools, sandboxRetryTools) {
	if (!tools?.some((tool) => hasSandboxControls(tool.parameters))) return void 0;
	if (sandboxRetryTools.size === 0) return "Tool sandbox rule: this is not a sandbox-escalation retry. Omit sandbox_permissions and justification from every tool call. First run the tool with the session's current access.";
	return `Tool sandbox rule: sandbox_permissions and justification may only be used to retry the exact denied call for: ${[...sandboxRetryTools].join(", ")}. Omit both fields from every other tool call, and request a strictly wider mode with a non-empty justification sentence.`;
}
function toolParametersForCodex(toolName, parameters, allowSandboxRetry) {
	const hideSandboxControls = !allowSandboxRetry && hasSandboxControls(parameters);
	const augmentCommandTool = isCommandTool(toolName);
	if (!hideSandboxControls && toolName !== "run_code" && !augmentCommandTool) return parameters;
	const cloned = structuredClone(parameters);
	const properties = record$2(cloned.properties);
	if (properties !== null && hideSandboxControls) {
		delete properties.sandbox_permissions;
		delete properties.justification;
	}
	if (hideSandboxControls && Array.isArray(cloned.required)) cloned.required = cloned.required.filter((name) => name !== "sandbox_permissions" && name !== "justification");
	if (toolName === "run_code" && properties !== null) {
		const code = record$2(properties.code);
		if (code !== null) {
			const current = typeof code.description === "string" ? code.description.trim() : "";
			const compatibility = "Strict JavaScript/TypeScript source. Nested shell commands are string data: template literals may consume ${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them; String.raw still performs ${...} interpolation. Prefer ordinary quoted string arrays joined with \"\\n\", or write a script file with a dedicated file tool.";
			code.description = current ? `${current}\n\n${compatibility}` : compatibility;
		}
	}
	if (augmentCommandTool && properties !== null) {
		appendPropertyDescription(properties.command, "Single command for a fresh process; do not rely on state from earlier calls.");
		appendPropertyDescription(properties.workdir, "Use a native absolute working directory instead of embedding cd in the command.");
		appendPropertyDescription(properties.timeoutMs, "Positive finite timeout in milliseconds for bounded commands.");
		appendPropertyDescription(properties.run_in_background, "Use only for long-running servers or watchers whose output will be checked later.");
		appendPropertyDescription(properties.sandbox_permissions, "Only set when retrying the exact previous sandbox-denied call; it does not bypass hard-deny policy results.");
		appendPropertyDescription(properties.justification, "Required only for an allowed sandbox retry; explain why the wider access is needed.");
	}
	return cloned;
}
function appendPropertyDescription(value, addition) {
	const property = record$2(value);
	if (property === null) return;
	const current = typeof property.description === "string" ? property.description.trim() : "";
	if (current.includes(addition)) return;
	property.description = current ? `${current}\n\n${addition}` : addition;
}
function isCommandTool(name) {
	const normalized = name.toLowerCase();
	return normalized === "pwsh" || normalized === "powershell" || normalized === "bash" || normalized === "sh" || normalized === "shell";
}
function hasSandboxControls(parameters) {
	const properties = record$2(parameters.properties);
	return properties !== null && ("sandbox_permissions" in properties || "justification" in properties);
}
function recentSandboxRetryToolNames(messages) {
	const deniedCallIds = /* @__PURE__ */ new Set();
	let assistant;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			assistant = message;
			break;
		}
		for (const block of message.content) {
			if (block.type !== "tool-result") continue;
			if (isSandboxDenial(blocksToText(block.content))) deniedCallIds.add(String(block.toolCallId));
		}
	}
	const result = /* @__PURE__ */ new Set();
	if (assistant === void 0 || deniedCallIds.size === 0) return result;
	for (const block of assistant.content) if (block.type === "tool-call" && deniedCallIds.has(String(block.id))) result.add(block.name);
	return result;
}
function isSandboxDenial(output) {
	return /\[sandbox:\s*file access denied\b/i.test(output) || /\bsandbox\b.*\b(?:access denied|denied access|EPERM)\b/i.test(output);
}
function appendMissingToolCalls(input, knownToolCalls, message, normalizeCallId) {
	for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		const callId = normalizeCallId(block.id);
		if (knownToolCalls.has(callId)) continue;
		input.push({
			type: "function_call",
			call_id: callId,
			name: block.name,
			arguments: block.arguments
		});
		knownToolCalls.set(callId, block.name);
	}
}
function runCodeErrorOutput(output) {
	if (!isRunCodeParserError(output)) return output;
	return `${output}\n\nCompatibility hint: run_code failed while parsing strict JavaScript/TypeScript, before the nested tool ran. Shell commands are nested string data; template literals can consume \${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them, and String.raw does not prevent \${...} interpolation. Build the script from ordinary quoted strings joined with "\\n", or write a script file with a dedicated file tool and then invoke the shell.`;
}
function isRunCodeParserError(output) {
	return /(?:Legacy octal escape is not permitted in strict mode|Unexpected token|Invalid or unexpected token|Unterminated template|Expected ['"]?\}['"]?)/i.test(output);
}
async function mapContent(message, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages) {
	const result = [];
	for (const block of message.content) if (block.type === "text") if (message.role === "user") result.push(...await mapUserText(block.text, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages));
	else result.push({
		type: "output_text",
		text: block.text
	});
	else if (block.type === "image") {
		if (message.role !== "user") continue;
		result.push({
			type: "input_image",
			image_url: await imageDataUrl(block.attachment, attachments, signal)
		});
	}
	return result;
}
async function mapUserText(text, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages) {
	const links = markdownImageLinks(text);
	if (links.length === 0) return [{
		type: "input_text",
		text
	}];
	if (!resolveLocalRawImages) {
		localImageStats.failed += links.length;
		return [{
			type: "input_text",
			text
		}];
	}
	const result = [];
	let cursor = 0;
	for (const match of links) {
		if (match.start > cursor) pushInputText(result, text.slice(cursor, match.start));
		localImageStats.attempted++;
		const image = await localRawImageDataUrl(match.url, localRawImages, attachments.imageLimits?.maxImageBytes, signal);
		if (image === null) {
			localImageStats.failed++;
			pushInputText(result, text.slice(match.start, match.end));
		} else {
			localImageStats.resolved++;
			result.push({
				type: "input_image",
				image_url: image
			});
		}
		cursor = match.end;
	}
	if (cursor < text.length) pushInputText(result, text.slice(cursor));
	return result.length > 0 ? result : [{
		type: "input_text",
		text
	}];
}
function pushInputText(content, text) {
	if (text === "") return;
	const previous = content.at(-1);
	if (previous?.type === "input_text" && typeof previous.text === "string") previous.text += text;
	else content.push({
		type: "input_text",
		text
	});
}
function markdownImageLinks(text) {
	const links = [];
	for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/gi)) {
		const url = match[1];
		if (match.index === void 0 || !isLocalRawImageReference(url)) continue;
		links.push({
			start: match.index,
			end: match.index + match[0].length,
			url
		});
	}
	return links;
}
async function localRawImageDataUrl(rawUrl, options, maxBytes, signal) {
	const url = localRawImageUrl(rawUrl, options.baseUrl);
	if (url === null) return null;
	let response;
	try {
		response = await (options.fetchFn ?? fetch)(url, {
			signal,
			redirect: "error"
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const contentLength = Number(response.headers.get("content-length") ?? NaN);
	if (maxBytes !== void 0 && Number.isFinite(contentLength) && contentLength > maxBytes) return null;
	let bytes;
	try {
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch {
		return null;
	}
	if (maxBytes !== void 0 && bytes.byteLength > maxBytes) return null;
	const mediaType = supportedImageMediaType(response.headers.get("content-type")) ?? sniffImageMediaType(bytes);
	if (mediaType === null) return null;
	return bytesToDataUrl(mediaType, bytes);
}
function localRawImageUrl(rawUrl, baseUrl) {
	if (!isLocalRawImageReference(rawUrl)) return null;
	try {
		const url = rawUrl.startsWith("/") ? baseUrl === void 0 ? null : new URL(rawUrl, baseUrl) : new URL(rawUrl);
		if (url === null || !isLoopbackHost(url.hostname)) return null;
		return url.toString();
	} catch {
		return null;
	}
}
function isLocalRawImageReference(url) {
	return /(?:^|\/)raw\/sha256:[a-f0-9]{32,}/i.test(url);
}
function isLoopbackHost(hostname) {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
function supportedImageMediaType(value) {
	const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp" || mediaType === "image/gif") return mediaType;
	return null;
}
function sniffImageMediaType(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
	if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
	return null;
}
function ascii(bytes, start, end) {
	return String.fromCharCode(...bytes.slice(start, end));
}
async function imageDataUrl(ref, attachments, signal) {
	const stored = await attachments.readImage(ref, signal);
	return bytesToDataUrl(stored.ref.mediaType, stored.data);
}
function bytesToDataUrl(mediaType, data) {
	return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
}
function blocksToText(blocks) {
	return blocks.map((block) => {
		if (block.type === "text" || block.type === "reasoning") return block.text;
		if (block.type === "image") return `[image: ${block.attachment.name ?? block.attachment.attachmentId}]`;
		if (block.type === "tool-result") return blocksToText(block.content);
		return "";
	}).filter(Boolean).join("\n");
}
function replayOutputItems(message) {
	if (message.source.kind !== "model") return null;
	const replay = message.source.replayState;
	if (typeof replay !== "object" || replay === null || Array.isArray(replay)) return null;
	const envelope = replay;
	const items = Array.isArray(envelope.outputItems) ? envelope.outputItems : Array.isArray(record$2(envelope.response)?.outputItems) ? record$2(envelope.response).outputItems : null;
	if (!Array.isArray(items)) return null;
	return structuredClone(items.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item)));
}
function record$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
//#endregion
//#region src/host/responses-client.ts
const toToolCallId = (id) => {
	const mod = LlmModule;
	return (mod.ToolCallId ?? mod.CallId ?? ((x) => x))(id);
};
const MAX_VISIBLE_REASONING_CHARS = 12e3;
const REASONING_DELTA_FLUSH_CHARS = 768;
const REASONING_TRUNCATED_NOTICE = "\n\n[Reasoning summary truncated to keep the DSH web UI responsive.]";
var ResponsesClient = class {
	oauth;
	attachments;
	fetchFn;
	onGenerationFinished;
	outputVerbosity;
	fastMode;
	reasoningSummary;
	constructor(oauth, attachments, options = {}) {
		this.oauth = oauth;
		this.attachments = attachments;
		this.fetchFn = options.fetchFn ?? fetch;
		this.localRawImages = options.localRawImages ?? {};
		this.onGenerationFinished = options.onGenerationFinished ?? (() => void 0);
		this.outputVerbosity = options.outputVerbosity ?? (() => null);
		this.fastMode = options.fastMode ?? (() => false);
		this.reasoningSummary = options.reasoningSummary ?? (() => null);
	}
	localRawImages;
	async *stream(options) {
		const hiddenSandboxControls = hiddenSandboxControlToolNames(options);
		const sessionId = stableSessionId(options.sessionId);
		let currentModel = options.model;
		let attemptOptions = options;
		let response;
		while (true) {
			const payload = await buildResponsesPayload(attemptOptions, this.attachments, this.localRawImages, this.outputVerbosity(), this.fastMode(), this.reasoningSummary());
			try {
				response = await this.send(payload, sessionId, options.signal);
				break;
			} catch (error) {
				if (error instanceof LlmError && (error.code === "NOT_FOUND" || error.status === 404)) {
					const fallback = resolveCodexFallbackModel(currentModel);
					if (fallback && fallback.id !== currentModel) {
						currentModel = fallback.id;
						attemptOptions = {
							...attemptOptions,
							model: fallback.id
						};
						continue;
					}
				}
				throw error;
			}
		}
		try {
			yield* wrapStreamWithWatchdog((watchdogSignal) => parseResponsesStream(response, watchdogSignal, hiddenSandboxControls), options.signal, 3e5, "LLM_STREAM_IDLE_TIMEOUT", "Codex");
		} finally {
			this.onGenerationFinished();
		}
	}
	async send(payload, sessionId, signal) {
		let credentials = await this.oauth.credentials();
		let response = await this.request(payload, credentials, sessionId, signal);
		if (response.status === 401) {
			await response.body?.cancel().catch(() => void 0);
			credentials = await this.oauth.credentials(true);
			response = await this.request(payload, credentials, sessionId, signal);
		}
		if (!response.ok) throw await responseError(response);
		return response;
	}
	async request(payload, credentials, sessionId, signal) {
		try {
			return await this.fetchFn(CODEX_RESPONSES_URL, {
				method: "POST",
				headers: {
					...codexHeaders(credentials, sessionId),
					"content-type": "application/json",
					accept: "text/event-stream"
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (cause) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			throw new LlmError("Codex could not be reached.", "NETWORK", { cause });
		}
	}
};
async function* parseResponsesStream(response, signal, hiddenSandboxControls = /* @__PURE__ */ new Set()) {
	if (response.body === null) throw new LlmError("Codex returned no response stream.", "PROVIDER_ERROR");
	const reader = response.body.getReader();
	const abortReader = () => {
		reader.cancel(signal?.reason).catch(() => void 0);
	};
	signal?.addEventListener("abort", abortReader, { once: true });
	const decoder = new TextDecoder();
	let buffer = "";
	let nextIndex = 0;
	let textIndex = null;
	let reasoningIndex = null;
	let text = "";
	let reasoning = "";
	let pendingReasoningDelta = "";
	let reasoningTruncated = false;
	let terminal = null;
	let usage = null;
	let replayOutput = [];
	const tools = /* @__PURE__ */ new Map();
	const toolFor = (event, item) => {
		const itemId = string(event.item_id) ?? string(item?.id);
		const outputIndex = number(event.output_index);
		const key = itemId ?? (outputIndex === void 0 ? `tool-${tools.size}` : `index-${outputIndex}`);
		let tool = tools.get(key);
		if (tool === void 0) {
			tool = {
				index: nextIndex++,
				id: acceptIdentity(`call_${key}`, item?.call_id ?? event.call_id),
				itemId,
				name: acceptIdentity("", item?.name ?? event.name),
				arguments: "",
				started: false
			};
			tools.set(key, tool);
		}
		return tool;
	};
	const consume = async function* (event) {
		const type = string(event.type);
		if (type === "response.output_text.delta" || type === "response.refusal.delta") {
			const delta = string(event.delta) ?? "";
			if (textIndex === null) {
				textIndex = nextIndex++;
				yield {
					type: "block-start",
					index: textIndex,
					blockType: "text"
				};
			}
			text += delta;
			if (delta) yield {
				type: "text-delta",
				index: textIndex,
				text: delta
			};
			return;
		}
		if (type === "response.reasoning_summary_text.delta") {
			const delta = string(event.delta) ?? "";
			if (reasoningIndex === null) {
				reasoningIndex = nextIndex++;
				yield {
					type: "block-start",
					index: reasoningIndex,
					blockType: "reasoning"
				};
			}
			const visibleDelta = visibleReasoningDelta(delta, reasoning.length, reasoningTruncated);
			reasoningTruncated ||= visibleDelta.truncated;
			if (visibleDelta.text !== "") {
				reasoning += visibleDelta.text;
				pendingReasoningDelta += visibleDelta.text;
			}
			if (pendingReasoningDelta.length >= REASONING_DELTA_FLUSH_CHARS) {
				yield {
					type: "reasoning-delta",
					index: reasoningIndex,
					text: pendingReasoningDelta
				};
				pendingReasoningDelta = "";
			}
			return;
		}
		if (type === "response.output_item.added" || type === "response.output_item.done") {
			const item = record$1(event.item);
			if (item !== null && type === "response.output_item.done") replayOutput.push(structuredClone(item));
			if (string(item?.type) !== "function_call") return;
			const tool = toolFor(event, item ?? void 0);
			tool.id = acceptIdentity(tool.id, item?.call_id);
			tool.name = acceptIdentity(tool.name, item?.name);
			const initial = string(item?.arguments) ?? "";
			if (!tool.started) {
				tool.started = true;
				yield {
					type: "block-start",
					index: tool.index,
					blockType: "tool-call"
				};
				yield {
					type: "tool-call-delta",
					index: tool.index,
					id: toToolCallId(tool.id),
					name: tool.name || void 0,
					argumentsDelta: initial
				};
				tool.arguments = initial;
			} else if (type === "response.output_item.done" && initial !== "") tool.arguments = initial;
			return;
		}
		if (type === "response.function_call_arguments.delta") {
			const tool = toolFor(event);
			tool.id = acceptIdentity(tool.id, event.call_id);
			tool.name = acceptIdentity(tool.name, event.name);
			const delta = string(event.delta) ?? "";
			if (!tool.started) {
				tool.started = true;
				yield {
					type: "block-start",
					index: tool.index,
					blockType: "tool-call"
				};
			}
			tool.arguments += delta;
			yield {
				type: "tool-call-delta",
				index: tool.index,
				id: toToolCallId(tool.id),
				name: tool.name || void 0,
				argumentsDelta: delta
			};
			return;
		}
		if (type === "response.function_call_arguments.done") {
			const tool = toolFor(event);
			tool.id = acceptIdentity(tool.id, event.call_id);
			tool.name = acceptIdentity(tool.name, event.name);
			const finalArguments = string(event.arguments);
			if (finalArguments !== void 0) tool.arguments = finalArguments;
			return;
		}
		if (type === "response.completed" || type === "response.incomplete") {
			const completed = record$1(event.response);
			usage = mapUsage(record$1(completed?.usage));
			const output = completed?.output;
			if (Array.isArray(output)) replayOutput = output.filter((item) => record$1(item) !== null).map((item) => structuredClone(item));
			terminal = type === "response.incomplete" ? { kind: "max-tokens" } : { kind: "stop" };
			return;
		}
		if (type === "response.failed" || type === "error") {
			const error = record$1(event.error) ?? record$1(record$1(event.response)?.error);
			const message = string(error?.message) ?? "Codex generation failed.";
			const rawCode = string(error?.code)?.toLowerCase();
			const isOverload = message.toLowerCase().includes("overload") || message.toLowerCase().includes("server error") || rawCode === "server_error" || rawCode === "service_unavailable" || rawCode === "internal_error";
			throw new LlmError(message, message.toLowerCase().includes("rate limit") || rawCode === "rate_limit" ? "RATE_LIMIT" : isOverload ? "SERVER_ERROR" : string(error?.code)?.toUpperCase() ?? "PROVIDER_ERROR");
		}
	};
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
				if (data === "" || data === "[DONE]") continue;
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					throw new LlmError("Codex returned malformed streaming JSON.", "PROTOCOL_ERROR");
				}
				const valueRecord = record$1(event);
				if (valueRecord !== null) yield* consume(valueRecord);
			}
		}
	} finally {
		signal?.removeEventListener("abort", abortReader);
		reader.releaseLock();
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
	if (terminal === null) throw new LlmError("Codex stream ended before a terminal event.", "PROTOCOL_ERROR");
	if (reasoningIndex !== null) {
		if (pendingReasoningDelta !== "") {
			yield {
				type: "reasoning-delta",
				index: reasoningIndex,
				text: pendingReasoningDelta
			};
			pendingReasoningDelta = "";
		}
		yield {
			type: "block-end",
			index: reasoningIndex,
			block: {
				type: "reasoning",
				text: reasoning
			}
		};
	}
	if (textIndex !== null) yield {
		type: "block-end",
		index: textIndex,
		block: {
			type: "text",
			text
		}
	};
	for (const item of replayOutput) if (item.type === "function_call" && typeof item.name === "string" && hiddenSandboxControls.has(item.name) && typeof item.arguments === "string") item.arguments = stripSandboxControls(item.arguments);
	let validToolCount = 0;
	const replayedToolCallIds = new Set(replayOutput.flatMap((item) => item.type === "function_call" && typeof item.call_id === "string" ? [item.call_id] : []));
	for (const tool of tools.values()) {
		if (!tool.started) continue;
		if (hiddenSandboxControls.has(tool.name)) tool.arguments = stripSandboxControls(tool.arguments);
		if (!isSafeJsonArguments(tool.arguments) || tool.name === "") throw new LlmError(`Codex returned invalid JSON arguments for tool ${tool.name || "(unnamed)"}.`, "INVALID_TOOL_ARGUMENTS");
		validToolCount++;
		if (!replayedToolCallIds.has(tool.id)) {
			replayOutput.push({
				type: "function_call",
				call_id: tool.id,
				name: tool.name,
				arguments: tool.arguments
			});
			replayedToolCallIds.add(tool.id);
		}
		yield {
			type: "block-end",
			index: tool.index,
			block: {
				type: "tool-call",
				id: toToolCallId(tool.id),
				name: tool.name,
				arguments: tool.arguments
			}
		};
	}
	if (usage !== null) yield {
		type: "usage",
		usage
	};
	yield {
		type: "finish",
		reason: validToolCount > 0 ? { kind: "tool-calls" } : terminal,
		replayState: { response: { outputItems: replayOutput } }
	};
}
function visibleReasoningDelta(delta, currentVisibleChars, alreadyTruncated) {
	if (delta === "" || alreadyTruncated) return {
		text: "",
		truncated: alreadyTruncated
	};
	const remaining = MAX_VISIBLE_REASONING_CHARS - currentVisibleChars;
	if (remaining <= 0) return {
		text: REASONING_TRUNCATED_NOTICE,
		truncated: true
	};
	if (delta.length <= remaining) return {
		text: delta,
		truncated: false
	};
	return {
		text: `${delta.slice(0, remaining)}${REASONING_TRUNCATED_NOTICE}`,
		truncated: true
	};
}
function mapUsage(value) {
	if (value === null) return null;
	const totalInput = number(value.input_tokens) ?? 0;
	const outputTokens = number(value.output_tokens) ?? 0;
	const cached = number(record$1(value.input_tokens_details)?.cached_tokens) ?? 0;
	const reasoning = number(record$1(value.output_tokens_details)?.reasoning_tokens);
	return {
		inputTokens: Math.max(0, totalInput - cached),
		outputTokens,
		...cached > 0 ? { cacheReadTokens: cached } : {},
		...reasoning === void 0 ? {} : { reasoningTokens: reasoning }
	};
}
function isSafeJsonArguments(value) {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}
function stripSandboxControls(value) {
	try {
		const parsedRecord = record$1(JSON.parse(value));
		if (parsedRecord === null) return value;
		let changed = false;
		for (const name of ["sandbox_permissions", "justification"]) if (name in parsedRecord) {
			delete parsedRecord[name];
			changed = true;
		}
		return changed ? JSON.stringify(parsedRecord) : value;
	} catch {
		return value;
	}
}
async function responseError(response) {
	const requestId = response.headers.get("x-request-id");
	const detail = (await response.text().catch(() => "")).slice(0, 500);
	const options = {
		status: response.status,
		...requestId ? { requestId: ProviderRequestId(requestId) } : {},
		...response.status === 429 ? { providerRetryAfterMs: retryAfterMs(response.headers) } : {}
	};
	if (response.status === 401) return new LlmError("ChatGPT sign-in has expired. Sign in again.", "AUTH", options);
	if (response.status === 404) return new LlmError(`Codex model or resource not found (${response.status})${detail ? `: ${detail}` : "."}`, "NOT_FOUND", options);
	if (response.status === 429) return new LlmError("Codex rate limit reached.", "RATE_LIMIT", options);
	if (response.status >= 500) return new LlmError(`Codex service error (${response.status}).`, "SERVER_ERROR", options);
	return new LlmError(`Codex request failed (${response.status})${detail ? `: ${detail}` : "."}`, "PROVIDER_ERROR", options);
}
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function string(value) {
	return typeof value === "string" ? value : void 0;
}
function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function acceptIdentity(current, incoming) {
	return typeof incoming === "string" && incoming.length > 0 ? incoming : current;
}
//#endregion
//#region src/host/usage-service.ts
const EMPTY_USAGE = {
	buckets: [],
	credits: null,
	individualLimit: null,
	spendControlReached: null,
	resetCredits: null
};
var UsageService = class {
	oauth;
	fetchFn;
	now;
	cache = null;
	lastUpstreamAt = 0;
	blockedUntil = 0;
	invalidated = false;
	inFlight = null;
	resetConsumeInFlight = null;
	constructor(oauth, options = {}) {
		this.oauth = oauth;
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
	}
	async status(authenticated, force = false) {
		if (!authenticated) return {
			state: "signed-out",
			...EMPTY_USAGE,
			fetchedAt: null,
			stale: false
		};
		const now = this.now();
		let credentials;
		try {
			credentials = await this.oauth.credentials();
		} catch {
			return this.failure({
				code: "quota-failed",
				message: "ChatGPT credentials could not be refreshed."
			});
		}
		const accountKey = identityKey(credentials);
		if (this.cache !== null && this.cache.accountKey !== accountKey) this.clear();
		if (!force && !this.invalidated && this.cache !== null && now - this.cache.fetchedAt < 6e4) return this.fromCache(false);
		if (this.cache !== null && now - this.lastUpstreamAt < 15e3) return this.fromCache(this.invalidated || now - this.cache.fetchedAt >= 6e4);
		if (now < this.blockedUntil) return this.failure({
			code: "rate-limited",
			message: "Quota refresh is temporarily rate limited."
		});
		if (this.inFlight !== null) return this.inFlight;
		this.inFlight = this.refreshUpstream(credentials, accountKey).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}
	invalidate() {
		this.invalidated = true;
	}
	clear() {
		this.cache = null;
		this.blockedUntil = 0;
		this.invalidated = false;
	}
	async consumeResetCredit() {
		if (this.resetConsumeInFlight !== null) return this.resetConsumeInFlight;
		this.resetConsumeInFlight = this.consumeResetCreditUpstream().finally(() => {
			this.resetConsumeInFlight = null;
		});
		return this.resetConsumeInFlight;
	}
	async consumeResetCreditUpstream() {
		let credentials;
		try {
			credentials = await this.oauth.credentials();
			let creditsResponse = await this.fetchResetCredits(credentials);
			if (creditsResponse.status === 401) {
				await creditsResponse.body?.cancel().catch(() => void 0);
				credentials = await this.oauth.credentials(true);
				creditsResponse = await this.fetchResetCredits(credentials);
			}
			if (!creditsResponse.ok) {
				const status = creditsResponse.status;
				await creditsResponse.body?.cancel().catch(() => void 0);
				throw new UsageServiceError({
					code: status === 429 ? "rate-limited" : "quota-failed",
					message: status === 429 ? "Reset credit request was rate limited." : `Reset credit request failed (${status}).`
				});
			}
			const creditId = parseResetCredits(await creditsResponse.json()).availableCreditIds[0];
			if (creditId === void 0) throw new UsageServiceError({
				code: "bad-request",
				message: "No reset credits are currently available."
			});
			const redeemRequestId = randomUUID();
			let consumeResponse = await this.fetchFn(CODEX_RESET_CREDITS_CONSUME_URL, {
				method: "POST",
				headers: {
					...codexHeaders(credentials),
					accept: "application/json",
					"content-type": "application/json"
				},
				body: JSON.stringify({
					credit_id: creditId,
					redeem_request_id: redeemRequestId
				})
			});
			if (consumeResponse.status === 401) {
				await consumeResponse.body?.cancel().catch(() => void 0);
				credentials = await this.oauth.credentials(true);
				consumeResponse = await this.fetchFn(CODEX_RESET_CREDITS_CONSUME_URL, {
					method: "POST",
					headers: {
						...codexHeaders(credentials),
						accept: "application/json",
						"content-type": "application/json"
					},
					body: JSON.stringify({
						credit_id: creditId,
						redeem_request_id: redeemRequestId
					})
				});
			}
			if (!consumeResponse.ok) {
				const status = consumeResponse.status;
				await consumeResponse.body?.cancel().catch(() => void 0);
				throw new UsageServiceError({
					code: status === 429 ? "rate-limited" : "quota-failed",
					message: status === 429 ? "Using the reset credit was rate limited." : `Using the reset credit failed (${status}).`
				});
			}
			await consumeResponse.body?.cancel().catch(() => void 0);
			this.clear();
			const refreshed = await this.refreshUpstream(credentials, identityKey(credentials));
			if (refreshed.error !== void 0) throw new UsageServiceError({
				code: "quota-failed",
				message: "The reset credit was used, but usage could not be refreshed."
			});
			return refreshed;
		} catch (error) {
			if (error instanceof UsageServiceError) throw error;
			throw new UsageServiceError({
				code: "quota-failed",
				message: "The reset credit could not be used."
			});
		}
	}
	async testConnection() {
		const started = this.now();
		const result = await this.status(true, true);
		if (result.state === "error" || result.error !== void 0) throw new UsageServiceError(result.error ?? {
			code: "connection-failed",
			message: "Codex connection test failed."
		});
		return {
			connected: true,
			latencyMs: Math.max(0, this.now() - started),
			checkedAt: Math.floor(this.now() / 1e3)
		};
	}
	async refreshUpstream(initialCredentials, initialAccountKey) {
		this.lastUpstreamAt = this.now();
		try {
			let credentials = initialCredentials;
			let accountKey = initialAccountKey;
			let response = await this.fetch(credentials);
			if (response.status === 401) {
				await response.body?.cancel().catch(() => void 0);
				credentials = await this.oauth.credentials(true);
				accountKey = identityKey(credentials);
				response = await this.fetch(credentials);
			}
			if (response.status === 429) {
				const delay = retryAfterMs(response.headers) ?? 15e3;
				this.blockedUntil = this.now() + Math.max(QUOTA_MIN_UPSTREAM_INTERVAL_MS, delay);
				await response.body?.cancel().catch(() => void 0);
				return this.failure({
					code: "rate-limited",
					message: "Quota refresh was rate limited. Existing data was kept."
				});
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => void 0);
				return this.failure({
					code: "quota-failed",
					message: `Quota request failed (${response.status}).`
				});
			}
			const usage = parseCodexUsage(await response.json());
			if ((usage.resetCredits?.availableCount ?? 0) > 0) {
				const resetResponse = await this.fetchResetCredits(credentials).catch(() => null);
				if (resetResponse?.ok === true) {
					const reset = parseResetCredits(await resetResponse.json());
					usage.resetCredits = {
						availableCount: reset.availableCount,
						expiresAt: reset.expiresAt
					};
				} else await resetResponse?.body?.cancel().catch(() => void 0);
			}
			this.cache = {
				usage,
				fetchedAt: this.now(),
				accountKey
			};
			this.invalidated = false;
			return this.fromCache(false);
		} catch (error) {
			const publicError = error instanceof UsageServiceError ? error.publicError : {
				code: "quota-failed",
				message: "Quota information could not be refreshed."
			};
			return this.failure(publicError);
		}
	}
	fetch(credentials) {
		return this.fetchFn(CODEX_USAGE_URL, { headers: {
			...codexHeaders(credentials),
			accept: "application/json"
		} });
	}
	fetchResetCredits(credentials) {
		return this.fetchFn(CODEX_RESET_CREDITS_URL, { headers: {
			...codexHeaders(credentials),
			accept: "application/json"
		} });
	}
	fromCache(stale, error) {
		if (this.cache === null) return {
			state: error ? "error" : "empty",
			...EMPTY_USAGE,
			fetchedAt: null,
			stale,
			...error ? { error } : {}
		};
		return {
			state: error ? "stale" : this.cache.usage.buckets.length > 0 ? "ready" : "empty",
			...structuredClone(this.cache.usage),
			fetchedAt: Math.floor(this.cache.fetchedAt / 1e3),
			stale,
			...error ? { error } : {}
		};
	}
	failure(error) {
		return this.fromCache(this.cache !== null, error);
	}
};
var UsageServiceError = class extends Error {
	publicError;
	constructor(publicError) {
		super(publicError.message);
		this.publicError = publicError;
	}
};
function mapCodexUsage(value) {
	return parseCodexUsage(value).buckets;
}
function parseCodexUsage(value) {
	const data = record(value);
	if (data === null) return structuredClone(EMPTY_USAGE);
	const planType = typeof data.plan_type === "string" ? data.plan_type : null;
	const buckets = [];
	const usedIds = /* @__PURE__ */ new Set();
	addBucket(buckets, usedIds, "codex", "Codex", planType, data.rate_limit);
	addBucket(buckets, usedIds, "code-review", "Code review", planType, data.code_review_rate_limit);
	const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
	for (const [index, value] of additional.entries()) {
		const limit = record(value);
		if (limit === null) continue;
		const idSource = text(limit.limit_name) ?? text(limit.metered_feature) ?? `additional-${index + 1}`;
		addBucket(buckets, usedIds, uniqueId(slug(idSource), usedIds), readableLimitName(text(limit.limit_name) ?? text(limit.metered_feature) ?? idSource), planType, limit.rate_limit);
	}
	return {
		buckets,
		credits: mapCredits(data.credits),
		individualLimit: mapIndividualLimit(record(data.spend_control)?.individual_limit),
		spendControlReached: boolean(record(data.spend_control)?.reached),
		resetCredits: mapResetCredits(data.rate_limit_reset_credits)
	};
}
function addBucket(result, usedIds, id, name, planType, value) {
	const source = record(value);
	if (source === null) return;
	const primary = mapWindow(source.primary_window);
	const secondary = mapWindow(source.secondary_window);
	if (primary === null && secondary === null) return;
	result.push({
		id,
		name,
		planType,
		primary,
		secondary,
		windows: [primary, secondary].filter(isWindow)
	});
	usedIds.add(id);
}
function mapWindow(value) {
	const data = record(value);
	if (data === null) return null;
	const used = numeric(data.used_percent);
	if (used === void 0) return null;
	const seconds = numeric(data.limit_window_seconds);
	const reset = numeric(data.reset_at);
	return {
		usedPercent: Math.min(100, Math.max(0, used)),
		windowDurationMins: seconds !== void 0 && seconds > 0 ? seconds / 60 : null,
		resetsAt: reset !== void 0 && reset > 0 ? reset : null
	};
}
function mapCredits(value) {
	const data = record(value);
	if (data === null) return null;
	const hasCredits = boolean(data.has_credits);
	const unlimited = boolean(data.unlimited);
	const balance = decimalText(data.balance);
	if (hasCredits === null && unlimited === null && balance === null) return null;
	return {
		hasCredits: hasCredits ?? (balance !== null || unlimited === true),
		unlimited: unlimited ?? false,
		balance
	};
}
function mapIndividualLimit(value) {
	const data = record(value);
	if (data === null) return null;
	const remaining = numeric(data.remaining_percent);
	const reset = numeric(data.reset_at);
	const limit = decimalText(data.limit);
	const used = decimalText(data.used);
	if (remaining === void 0 && reset === void 0 && limit === null && used === null) return null;
	return {
		limit,
		used,
		remainingPercent: remaining !== void 0 ? Math.min(100, Math.max(0, remaining)) : null,
		resetsAt: reset !== void 0 && reset > 0 ? reset : null
	};
}
function mapResetCredits(value) {
	const data = record(value);
	if (data === null) return null;
	const available = numeric(data.available_count);
	if (available === void 0) return null;
	return {
		availableCount: Math.max(0, Math.floor(available)),
		expiresAt: null
	};
}
function parseResetCredits(value) {
	const data = record(value);
	if (data === null) return {
		availableCount: 0,
		expiresAt: null,
		availableCreditIds: []
	};
	const available = (Array.isArray(data.credits) ? data.credits : []).map(record).filter((credit) => credit !== null && credit.status === "available").map((credit) => ({
		id: text(credit.id),
		expiresAt: timestamp(credit.expires_at)
	})).filter((credit) => credit.id !== null).sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER));
	const reported = numeric(data.available_count);
	return {
		availableCount: reported === void 0 ? available.length : Math.max(0, Math.floor(reported)),
		expiresAt: available.map((credit) => credit.expiresAt).find((expiresAt) => expiresAt !== null) ?? null,
		availableCreditIds: available.map((credit) => credit.id)
	};
}
function timestamp(value) {
	const numericValue = numeric(value);
	if (numericValue !== void 0 && numericValue > 0) return numericValue > 1e10 ? Math.floor(numericValue / 1e3) : Math.floor(numericValue);
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.floor(parsed / 1e3) : null;
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function boolean(value) {
	return typeof value === "boolean" ? value : null;
}
function numeric(value) {
	if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return void 0;
	const number = Number(value);
	return Number.isFinite(number) ? number : void 0;
}
function decimalText(value) {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed !== "" ? trimmed : null;
}
function text(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function slug(value) {
	return value.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "") || "additional";
}
function uniqueId(base, usedIds) {
	let candidate = base;
	let suffix = 2;
	while (usedIds.has(candidate)) {
		candidate = `${base}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}
function readableLimitName(value) {
	return value.replace(/^codex[_-]/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (match) => match.toUpperCase()) || "Additional limit";
}
function isWindow(value) {
	return value !== null;
}
function identityKey(credentials) {
	return credentials.accountId ?? credentials.email ?? credentials.planType ?? "signed-in";
}
//#endregion
//#region src/host/routes.ts
const MAX_BODY_BYTES = 64 * 1024;
function registerRoutes(ctx, oauth, usage, preferences, proxyManager) {
	const handler = async (request, response) => {
		const url = new URL(request.url ?? "/", "http://dsh.local");
		if (request.method === "GET" && url.pathname === `/api/dsh-chatgpt-subscription/status`) {
			const oauthStatus = await oauth.status();
			json(response, {
				ok: true,
				value: {
					...oauthStatus,
					quota: await usage.status(oauthStatus.authenticated),
					preferences: preferences.status(),
					detectedProxy: proxyManager?.getSystemProxy() ?? null,
					activeProxy: proxyManager?.resolveActiveProxyUrl() ?? null
				}
			});
			return;
		}
		if (request.method === "GET" && url.pathname === `/api/dsh-chatgpt-subscription/mermaid.min.js`) {
			try {
				const mermaidPath = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
				response.writeHead(200, {
					"Content-Type": "application/javascript; charset=utf-8",
					"Cache-Control": "public, max-age=86400"
				});
				fs.createReadStream(mermaidPath).pipe(response);
			} catch {
				response.writeHead(404, { "Content-Type": "text/plain" });
				response.end("Not found");
			}
			return;
		}
		if (request.method !== "POST") {
			jsonError(response, 405, {
				code: "bad-request",
				message: "Method not allowed."
			});
			return;
		}
		if (!isSameOriginMutation(request)) {
			jsonError(response, 403, {
				code: "csrf-rejected",
				message: "Cross-origin request rejected."
			});
			return;
		}
		const contentType = request.headers["content-type"];
		if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
			jsonError(response, 415, {
				code: "bad-request",
				message: "A JSON request body is required."
			});
			return;
		}
		const body = await readJson(request);
		if (body === null) {
			jsonError(response, 400, {
				code: "bad-request",
				message: "Malformed JSON request."
			});
			return;
		}
		try {
			switch (url.pathname) {
				case `${ROUTE_PREFIX}/login/start`:
					json(response, {
						ok: true,
						value: await oauth.startLogin()
					});
					return;
				case `${ROUTE_PREFIX}/login/cancel`: {
					const loginId = field(body, "loginId");
					if (loginId === null) throw new Error("missing loginId");
					oauth.cancelLogin(loginId);
					json(response, {
						ok: true,
						value: { cancelled: true }
					});
					return;
				}
				case `${ROUTE_PREFIX}/logout`:
					await oauth.logout();
					usage.clear();
					json(response, {
						ok: true,
						value: { authenticated: false }
					});
					return;
				case `${ROUTE_PREFIX}/token/refresh`: {
					const oauthStatus = await oauth.refresh();
					json(response, {
						ok: true,
						value: {
							...oauthStatus,
							quota: await usage.status(oauthStatus.authenticated),
							preferences: preferences.status()
						}
					});
					return;
				}
				case `${ROUTE_PREFIX}/quota/refresh`:
					if (!(await oauth.status()).authenticated) throw new Error("not authenticated");
					json(response, {
						ok: true,
						value: await usage.status(true, true)
					});
					return;
				case `${ROUTE_PREFIX}/quota/reset-credit/use`:
					if (!(await oauth.status()).authenticated) throw new Error("not authenticated");
					json(response, {
						ok: true,
						value: await usage.consumeResetCredit()
					});
					return;
				case `${ROUTE_PREFIX}/connection/test`:
					json(response, {
						ok: true,
						value: await usage.testConnection()
					});
					return;
				case `${ROUTE_PREFIX}/preferences/update`:
					json(response, {
						ok: true,
						value: await preferences.update(readPreferencesUpdate(body, preferences.status()))
					});
					return;
				default: jsonError(response, 404, {
					code: "bad-request",
					message: "Route not found."
				});
			}
		} catch (error) {
			const mapped = error instanceof UsageServiceError ? error.publicError : error instanceof PreferenceError ? {
				code: "bad-request",
				message: error.message
			} : publicError(error, error instanceof Error && error.message === "missing loginId" ? "bad-request" : error instanceof Error && error.message === "not authenticated" ? "not-authenticated" : "internal");
			jsonError(response, statusFor(mapped), mapped);
		}
	};
	const events = (request, response) => {
		if (request.method !== "GET") {
			response.writeHead(405);
			response.end();
			return;
		}
		const loginId = new URL(request.url ?? "/", "http://dsh.local").searchParams.get("loginId");
		if (loginId === null || loginId === "") {
			jsonError(response, 400, {
				code: "bad-request",
				message: "loginId is required."
			});
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-content-type-options": "nosniff"
		});
		response.write("retry: 1000\n\n");
		let terminal = false;
		let heartbeat;
		let unsubscribe = null;
		const cleanup = () => {
			if (heartbeat !== void 0) clearInterval(heartbeat);
			unsubscribe?.();
			unsubscribe = null;
		};
		const send = (event) => {
			response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			if (event.type !== "pending") {
				terminal = true;
				queueMicrotask(() => {
					cleanup();
					response.end();
				});
			}
		};
		unsubscribe = oauth.subscribe(loginId, send);
		if (unsubscribe === null) {
			response.end("event: failed\ndata: {\"type\":\"failed\",\"error\":{\"code\":\"bad-request\",\"message\":\"Unknown loginId.\"}}\n\n");
			return;
		}
		if (terminal) {
			unsubscribe();
			response.end();
			return;
		}
		heartbeat = setInterval(() => response.write(": ping\n\n"), 15e3);
		request.once("close", cleanup);
	};
	const disposers = [ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler
	}), ctx.webServer.register({
		kind: "exact",
		path: `${ROUTE_PREFIX}/login/events`,
		handler: events
	})];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
function isSameOriginMutation(request) {
	const host = request.headers.host;
	const origin = request.headers.origin;
	if (typeof host !== "string" || host === "" || typeof origin !== "string" || origin === "") return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}
async function readJson(request) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return null;
		chunks.push(buffer);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}
function field(value, name) {
	const candidate = value[name];
	return typeof candidate === "string" && candidate !== "" ? candidate : null;
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readPreferencesUpdate(value, current) {
	const patch = {};
	if ("visibleModelIds" in value) {
		if (!Array.isArray(value.visibleModelIds) || value.visibleModelIds.length === 0 || !value.visibleModelIds.every(isCodexModelId)) throw new PreferenceError("visibleModelIds must contain at least one supported Codex model.");
		patch.visibleModelIds = [...new Set(value.visibleModelIds)];
	}
	if ("quickQuotaVisible" in value) {
		if (typeof value.quickQuotaVisible !== "boolean") throw new PreferenceError("quickQuotaVisible must be a boolean.");
		patch.quickQuotaVisible = value.quickQuotaVisible;
	}
	if ("fastMode" in value) {
		if (typeof value.fastMode !== "boolean") throw new PreferenceError("fastMode must be a boolean.");
		patch.fastMode = value.fastMode;
	}
	if ("outputVerbosity" in value) {
		if (value.outputVerbosity !== null && value.outputVerbosity !== "low" && value.outputVerbosity !== "medium" && value.outputVerbosity !== "high") throw new PreferenceError("outputVerbosity must be null, low, medium, or high.");
		patch.outputVerbosity = value.outputVerbosity;
	}
	if ("reasoningSummary" in value) {
		if (value.reasoningSummary !== null && !isCodexReasoningSummary(value.reasoningSummary)) throw new PreferenceError("reasoningSummary must be null, auto, concise, detailed, or none.");
		patch.reasoningSummary = value.reasoningSummary;
	}
	if ("searchProvider" in value) {
		if (value.searchProvider !== "dsh" && value.searchProvider !== "codex") throw new PreferenceError("searchProvider must be dsh or codex.");
		patch.searchProvider = value.searchProvider;
	}
	if ("contextWindowOverrides" in value) {
		if (!isRecord$1(value.contextWindowOverrides)) throw new PreferenceError("contextWindowOverrides must be an object.");
		const overrides = {};
		for (const [model, contextWindow] of Object.entries(value.contextWindowOverrides)) {
			if (!isConfigurableContextModelId(model)) throw new PreferenceError("This model does not support a configurable context window.");
			if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > contextWindowLimitForModel(model)) throw new PreferenceError(`contextWindowOverrides.${model} must be a positive integer no greater than the provider limit.`);
			overrides[model] = contextWindow;
		}
		patch.contextWindowOverrides = overrides;
	}
	if ("subagentContextWindow" in value) {
		if (value.subagentContextWindow !== null && (!Number.isSafeInteger(value.subagentContextWindow) || value.subagentContextWindow < 1)) throw new PreferenceError("subagentContextWindow must be null or a positive integer.");
		patch.subagentContextWindow = value.subagentContextWindow;
	}
	if ("subagentMaxDepth" in value) {
		if (value.subagentMaxDepth !== null && (!Number.isSafeInteger(value.subagentMaxDepth) || value.subagentMaxDepth < 0 || value.subagentMaxDepth > 3)) throw new PreferenceError(`subagentMaxDepth must be null or an integer from 0 to 3.`);
		patch.subagentMaxDepth = value.subagentMaxDepth;
	}
	if ("proxyMode" in value) {
		if (value.proxyMode !== "auto" && value.proxyMode !== "custom" && value.proxyMode !== "direct") throw new PreferenceError("proxyMode must be auto, custom, or direct.");
		patch.proxyMode = value.proxyMode;
	}
	if ("customProxyUrl" in value) {
		if (value.customProxyUrl !== null && typeof value.customProxyUrl !== "string") throw new PreferenceError("customProxyUrl must be a string or null.");
		patch.customProxyUrl = value.customProxyUrl;
	}
	return patch;
}
function json(response, envelope, status = 200) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	response.end(JSON.stringify(envelope));
}
function jsonError(response, status, error) {
	json(response, {
		ok: false,
		error
	}, status);
}
function statusFor(error) {
	if (error.code === "csrf-rejected") return 403;
	if (error.code === "not-authenticated") return 401;
	if (error.code === "rate-limited") return 429;
	if (error.code === "login-active") return 409;
	if (error.code === "bad-request") return 400;
	return 502;
}
//#endregion
//#region src/host/token-store.ts
function parseStoredCredentials(value) {
	if (typeof value !== "object" || value === null) throw new Error("credential bundle is not an object");
	const record = value;
	if (typeof record.accessToken !== "string" || record.accessToken === "") throw new Error("access token is missing");
	if (typeof record.refreshToken !== "string" || record.refreshToken === "") throw new Error("refresh token is missing");
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) throw new Error("expiry is invalid");
	const optional = (key) => {
		const candidate = record[key];
		if (candidate === void 0) return void 0;
		if (typeof candidate !== "string") throw new Error(`${key} is invalid`);
		return candidate;
	};
	return {
		accessToken: record.accessToken,
		refreshToken: record.refreshToken,
		expiresAt: record.expiresAt,
		idToken: optional("idToken"),
		accountId: optional("accountId"),
		email: optional("email"),
		planType: optional("planType")
	};
}
//#endregion
//#region src/host/token-store-macos.ts
const DEFAULT_SERVICE = "dsh-chatgpt-subscription";
const DEFAULT_ACCOUNT = "oauth";
/**
* macOS credential storage backed by the login Keychain through the built-in
* `security` command-line tool. The payload is encrypted at rest by the
* Keychain, so this store reports itself as encrypted like Windows DPAPI.
*/
var MacKeychainCredentialStore = class {
	service;
	account;
	parse;
	storage = {
		kind: "macos-keychain",
		encrypted: true
	};
	constructor(service, account, parse) {
		this.service = service;
		this.account = account;
		this.parse = parse;
		if (process.platform !== "darwin") throw new Error("macOS Keychain storage requires macOS");
	}
	async load() {
		const result = await runSecurity([
			"find-generic-password",
			"-a",
			this.account,
			"-s",
			this.service,
			"-w"
		]);
		if (result.code === 44) return null;
		if (result.code !== 0) throw new Error("Keychain credential read failed");
		try {
			const payload = result.stdout.replace(/\r?\n$/, "");
			return this.parse(JSON.parse(payload));
		} catch {
			throw new Error("Keychain credential payload is invalid");
		}
	}
	async save(value) {
		if ((await runSecurity([
			"add-generic-password",
			"-a",
			this.account,
			"-s",
			this.service,
			"-w",
			JSON.stringify(value),
			"-U"
		])).code !== 0) throw new Error("Keychain credential write failed");
	}
	async clear() {
		const result = await runSecurity([
			"delete-generic-password",
			"-a",
			this.account,
			"-s",
			this.service
		]);
		if (result.code !== 0 && result.code !== 44) throw new Error("Keychain credential deletion failed");
	}
};
var MacKeychainTokenStore = class extends MacKeychainCredentialStore {
	constructor(service = DEFAULT_SERVICE, account = DEFAULT_ACCOUNT) {
		super(service, account, parseStoredCredentials);
	}
};
function runSecurity(args) {
	return new Promise((resolve, reject) => {
		const child = spawn("security", args, {
			env: { ...process.env },
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderrLength = 0;
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error("Keychain helper timed out"));
		}, 1e4);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 1 << 20) child.kill();
		});
		child.stderr.on("data", (chunk) => {
			stderrLength += chunk.length;
			if (stderrLength > 1 << 20) child.kill();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({
				code: code ?? 1,
				stdout
			});
		});
	});
}
//#endregion
//#region src/host/token-store-linux.ts
const DIRECTORY_MODE = 448;
const FILE_MODE = 384;
function defaultLinuxCredentialPath() {
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "storages", "dsh-chatgpt-subscription", "oauth.json");
}
/**
* Linux credential storage protected by owner-only filesystem permissions.
* The payload is not encrypted at rest, so callers must report that distinction
* instead of presenting this store as equivalent to Windows DPAPI.
*/
var LinuxFileTokenStore = class {
	path;
	storage = {
		kind: "linux-file",
		encrypted: false
	};
	noFollow = constants.O_NOFOLLOW;
	constructor(path = defaultLinuxCredentialPath()) {
		this.path = path;
		if (process.platform !== "linux") throw new Error("Linux credential storage requires Linux");
		if (this.noFollow === void 0) throw new Error("Linux credential storage requires O_NOFOLLOW support");
		if (dirname(path) === path) throw new Error("invalid Linux credential path");
	}
	async load() {
		let handle;
		try {
			handle = await open(this.path, constants.O_RDONLY | this.noFollow);
		} catch (error) {
			if (isMissing(error)) return null;
			throw new Error("Linux credential read failed", { cause: error });
		}
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) throw new Error("credential path is not a regular file");
			if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("credential file is owned by another user");
			if ((stats.mode & 511) !== FILE_MODE) throw new Error("credential file permissions must be 0600");
			const payload = await handle.readFile({ encoding: "utf8" });
			return parseStoredCredentials(JSON.parse(payload));
		} catch (error) {
			throw new Error("Linux credential payload is invalid or insecure", { cause: error });
		} finally {
			await handle.close();
		}
	}
	async save(value) {
		const directory = dirname(this.path);
		const temporary = `${this.path}.tmp-${randomUUID()}`;
		try {
			const existing = await lstat(this.path);
			if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("credential path is not a regular file");
			assertOwnedByCurrentUser(existing.uid, "credential file");
		} catch (error) {
			if (!isMissing(error)) throw new Error("Linux credential write failed", { cause: error });
		}
		await mkdir(directory, {
			recursive: true,
			mode: DIRECTORY_MODE
		});
		const directoryStats = await stat(directory);
		if (!directoryStats.isDirectory()) throw new Error("Linux credential directory is invalid");
		assertOwnedByCurrentUser(directoryStats.uid, "credential directory");
		await chmod(directory, DIRECTORY_MODE);
		let handle;
		try {
			handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
			await handle.writeFile(JSON.stringify(value), { encoding: "utf8" });
			await handle.sync();
			await handle.close();
			handle = void 0;
			await rename(temporary, this.path);
			await chmod(this.path, FILE_MODE);
		} catch (error) {
			await handle?.close().catch(() => void 0);
			await unlink(temporary).catch(() => void 0);
			throw new Error("Linux credential write failed", { cause: error });
		}
	}
	async clear() {
		try {
			await unlink(this.path);
		} catch (error) {
			if (isMissing(error)) return;
			throw new Error("Linux credential deletion failed", { cause: error });
		}
	}
};
function assertOwnedByCurrentUser(owner, label) {
	if (typeof process.getuid === "function" && owner !== process.getuid()) throw new Error(`${label} is owned by another user`);
}
function isMissing(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//#endregion
//#region src/host/token-store-windows.ts
const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_CODEX_TOKEN_PATH
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$directory = [IO.Path]::GetDirectoryName($path)
[IO.Directory]::CreateDirectory($directory) | Out-Null
$temporary = $path + '.tmp-' + [Guid]::NewGuid().ToString('N')
try {
  [IO.File]::WriteAllBytes($temporary, $cipher)
  if ([IO.File]::Exists($path)) {
    [IO.File]::Replace($temporary, $path, [System.Management.Automation.Language.NullString]::Value)
  } else {
    [IO.File]::Move($temporary, $path)
  }
} finally {
  if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
`;
const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_CODEX_TOKEN_PATH
if (-not [IO.File]::Exists($path)) { exit 3 }
$cipher = [IO.File]::ReadAllBytes($path)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;
const CLEAR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:DSH_CODEX_TOKEN_PATH
if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
`;
function defaultDpapiCredentialPath() {
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "storages", "dsh-chatgpt-subscription", "oauth.dpapi");
}
var WindowsDpapiCredentialStore = class {
	path;
	parse;
	storage = {
		kind: "windows-dpapi",
		encrypted: true
	};
	constructor(path, parse) {
		this.path = path;
		this.parse = parse;
		if (process.platform !== "win32") throw new Error("Windows DPAPI storage requires Windows");
		if (dirname(path) === path) throw new Error("invalid DPAPI credential path");
	}
	async load() {
		const result = await runPowerShell(UNPROTECT_SCRIPT, this.path, "");
		if (result.code === 3) return null;
		if (result.code !== 0) throw new Error("DPAPI credential read failed");
		try {
			return this.parse(JSON.parse(result.stdout));
		} catch {
			throw new Error("DPAPI credential payload is invalid");
		}
	}
	async save(value) {
		if ((await runPowerShell(PROTECT_SCRIPT, this.path, JSON.stringify(value))).code !== 0) throw new Error("DPAPI credential write failed");
	}
	async clear() {
		if ((await runPowerShell(CLEAR_SCRIPT, this.path, "")).code !== 0) throw new Error("DPAPI credential deletion failed");
	}
};
var WindowsDpapiTokenStore = class extends WindowsDpapiCredentialStore {
	constructor(path = defaultDpapiCredentialPath()) {
		super(path, parseStoredCredentials);
	}
};
function runPowerShell(script, path, stdin) {
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			env: {
				...process.env,
				DSH_CODEX_TOKEN_PATH: path
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let stdout = "";
		let stderrLength = 0;
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error("DPAPI helper timed out"));
		}, 1e4);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 1 << 20) child.kill();
		});
		child.stderr.on("data", (chunk) => {
			stderrLength += chunk.length;
			if (stderrLength > 1 << 20) child.kill();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({
				code: code ?? 1,
				stdout
			});
		});
		child.stdin.end(stdin);
	});
}
//#endregion
//#region src/host/platform-token-store.ts
function createPlatformTokenStore(platform = process.platform) {
	if (platform === "win32") return new WindowsDpapiTokenStore();
	if (platform === "darwin") return new MacKeychainTokenStore();
	if (platform === "linux") return new LinuxFileTokenStore();
	throw new Error(`Unsupported platform ${platform}; dsh-chatgpt-subscription supports Windows, macOS, and Linux.`);
}
//#endregion
//#region src/host/search-provider-switcher.ts
var SearchProviderSwitcher = class {
	loader;
	originalSearchProvider;
	originalFetchProvider;
	initialized = false;
	constructor(loader) {
		this.loader = loader;
	}
	async select(preference) {
		const entry = this.findWebEntry();
		if (entry === null) return;
		const config = currentConfig(entry);
		if (!this.initialized) {
			this.originalSearchProvider = typeof config.searchProvider === "string" && config.searchProvider !== "codex-subscription" ? config.searchProvider : void 0;
			this.originalFetchProvider = typeof config.fetchProvider === "string" && config.fetchProvider !== "codex-subscription" ? config.fetchProvider : void 0;
			this.initialized = true;
		}
		const selected = preference === "codex" ? CODEX_SEARCH_PROVIDER_ID : void 0;
		const nextSearch = selected ?? this.originalSearchProvider;
		const nextFetch = selected ? CODEX_FETCH_PROVIDER_ID : this.originalFetchProvider;
		if (config.searchProvider === nextSearch && config.fetchProvider === nextFetch) return;
		const nextConfig = { ...config };
		if (nextSearch === void 0) delete nextConfig.searchProvider;
		else nextConfig.searchProvider = nextSearch;
		if (nextFetch === void 0) delete nextConfig.fetchProvider;
		else nextConfig.fetchProvider = nextFetch;
		await entry.update({ config: nextConfig }, true);
	}
	findWebEntry() {
		for (const entry of this.loader.entries()) {
			if (entry.options.id === "web") return entry;
			if (entry.options.name === "@deepseek-ai/dsh-web") return entry;
		}
		return null;
	}
};
function currentConfig(entry) {
	const config = entry.options.config;
	return typeof config === "object" && config !== null && !Array.isArray(config) ? config : {};
}
//#endregion
//#region src/host/antigravity/types.ts
const PROVIDER_NAME = "Antigravity";
const PROVIDER_ID = "antigravity";
const STREAM_IDLE_TIMEOUT_MS = 3e5;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const DISCOVERY_TIMEOUT_MS = 8e3;
const PROJECT_CACHE_TTL_MS = 1800 * 1e3;
const OAUTH_CALLBACK_TIMEOUT_MS = 300 * 1e3;
const ENDPOINT_FALLBACKS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
const REDIRECT_PATH = "/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
	"https://www.googleapis.com/auth/aicode",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs"
];
const DEFAULT_CLIENT_ID = Buffer.from("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==", "base64").toString("utf8");
const DEFAULT_CLIENT_SECRET = Buffer.from("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");
const ANTIGRAVITY_SYSTEM_INSTRUCTION = "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION = "CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.";
const GEMINI_ROLE = {
	user: "user",
	model: "model"
};
const TOOL_CALLING_MODE = {
	none: "NONE",
	any: "ANY",
	auto: "AUTO",
	validated: "VALIDATED"
};
const ROUTING = {
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-tiered",
		routing: {
			minimal: "gemini-3.8-flash-tiered",
			low: "gemini-3.8-flash-tiered",
			medium: "gemini-3.8-flash-tiered",
			high: "gemini-3.8-flash-tiered",
			xhigh: "gemini-3.8-flash-tiered"
		},
		defaultRequestId: "gemini-3.8-flash-tiered",
		fallbackCandidates: ["gemini-3.7-flash-tiered", "gemini-3.6-flash-low"]
	},
	"claude-opus-4-6": {
		off: "claude-opus-4-6-thinking",
		routing: {
			minimal: "claude-opus-4-6-thinking",
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
			xhigh: "claude-opus-4-6-thinking"
		},
		defaultRequestId: "claude-opus-4-6-thinking",
		fallbackCandidates: ["claude-sonnet-4-6"]
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		routing: {
			minimal: "claude-sonnet-4-6",
			low: "claude-sonnet-4-6",
			medium: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6",
			xhigh: "claude-sonnet-4-6"
		},
		defaultRequestId: "claude-sonnet-4-6"
	},
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-tiered",
		routing: {
			minimal: "gemini-3.7-flash-tiered",
			low: "gemini-3.7-flash-tiered",
			medium: "gemini-3.7-flash-tiered",
			high: "gemini-3.7-flash-tiered",
			xhigh: "gemini-3.7-flash-tiered"
		},
		defaultRequestId: "gemini-3.7-flash-tiered",
		fallbackCandidates: ["gemini-3.6-flash-low"]
	},
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		routing: {
			minimal: "gemini-3.6-flash-low",
			low: "gemini-3.6-flash-low",
			medium: "gemini-3.6-flash-medium",
			high: "gemini-3.6-flash-high",
			xhigh: "gemini-3.6-flash-high"
		},
		defaultRequestId: "gemini-3.6-flash-high"
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: {
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
			xhigh: "gemini-3-flash-agent"
		},
		defaultRequestId: "gemini-3-flash-agent"
	},
	"gemini-3.1-pro": {
		off: "gemini-3.1-pro-low",
		routing: {
			minimal: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			medium: "gemini-pro-agent",
			high: "gemini-pro-agent",
			xhigh: "gemini-pro-agent"
		},
		defaultRequestId: "gemini-pro-agent"
	},
	"gemini-3.1-flash-image": {
		off: "gemini-3.1-flash-image",
		routing: {
			minimal: "gemini-3.1-flash-image",
			low: "gemini-3.1-flash-image",
			medium: "gemini-3.1-flash-image",
			high: "gemini-3.1-flash-image",
			xhigh: "gemini-3.1-flash-image"
		},
		defaultRequestId: "gemini-3.1-flash-image"
	},
	"gemini-3-flash": {
		off: "gemini-3-flash",
		routing: {
			minimal: "gemini-3-flash",
			low: "gemini-3-flash",
			medium: "gemini-3-flash",
			high: "gemini-3-flash",
			xhigh: "gemini-3-flash"
		},
		defaultRequestId: "gemini-3-flash"
	},
	"gemini-2.5-pro": {
		off: "gemini-2.5-pro",
		routing: {
			minimal: "gemini-2.5-pro",
			low: "gemini-2.5-pro",
			medium: "gemini-2.5-pro",
			high: "gemini-2.5-pro",
			xhigh: "gemini-2.5-pro"
		},
		defaultRequestId: "gemini-2.5-pro"
	},
	"gemini-2.5-flash": {
		off: "gemini-2.5-flash",
		routing: {
			minimal: "gemini-2.5-flash",
			low: "gemini-2.5-flash",
			medium: "gemini-2.5-flash",
			high: "gemini-2.5-flash",
			xhigh: "gemini-2.5-flash"
		},
		defaultRequestId: "gemini-2.5-flash"
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		routing: {
			minimal: "gpt-oss-120b-medium",
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
			xhigh: "gpt-oss-120b-medium"
		},
		defaultRequestId: "gpt-oss-120b-medium"
	}
};
const RUNTIME_MAX_OUTPUT_TOKENS = {
	"gemini-3.8-flash": 65536,
	"gemini-3.8-flash-tiered": 65536,
	"gemini-3.7-flash": 65536,
	"gemini-3.7-flash-tiered": 65536,
	"gemini-3.7-flash-low": 65536,
	"gemini-3.7-flash-medium": 65536,
	"gemini-3.7-flash-high": 65536,
	"gemini-3.6-flash": 65536,
	"gemini-3.6-flash-low": 65536,
	"gemini-3.6-flash-medium": 65536,
	"gemini-3.6-flash-high": 65536,
	"gemini-3.5-flash": 65536,
	"gemini-3.5-flash-extra-low": 65536,
	"gemini-3.5-flash-low": 65536,
	"gemini-3-flash-agent": 65536,
	"gemini-3.1-pro": 65535,
	"gemini-3.1-pro-low": 65535,
	"gemini-3.1-pro-high": 65535,
	"gemini-pro-agent": 65535,
	"claude-opus-4-6": 64e3,
	"claude-opus-4-6-thinking": 64e3,
	"claude-sonnet-4-6": 64e3,
	"gpt-oss-120b": 32768,
	"gpt-oss-120b-medium": 32768
};
const MODELS = [
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65535,
		reasoningEfforts: ["low", "high"]
	},
	{
		id: "gemini-3.1-flash-image",
		name: "Gemini 3.1 Flash Image",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 8192
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65535
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 64e3,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		inputModalities: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 64e3,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		inputModalities: ["text"],
		contextWindow: 262144,
		maxTokens: 32768,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		]
	}
];
//#endregion
//#region src/host/credential-store-secret-service.ts
const UNAVAILABLE = "Linux encrypted credential storage requires secret-tool (libsecret) and an unlocked Secret Service keyring.";
/** Secrets travel over stdin/stdout; command arguments contain only lookup attributes. */
var SecretServiceCredentialStore = class {
	service;
	account;
	parse;
	constructor(service, account, parse) {
		this.service = service;
		this.account = account;
		this.parse = parse;
	}
	attributes() {
		return [
			"service",
			this.service,
			"account",
			this.account
		];
	}
	async load() {
		const result = await runSecretTool(["lookup", ...this.attributes()]);
		if (result.code === 1 && !result.hasStderr && result.stdout === "") return null;
		if (result.code !== 0) throw new Error(UNAVAILABLE);
		try {
			return this.parse(JSON.parse(result.stdout));
		} catch {
			throw new Error("Secret Service credential payload is invalid");
		}
	}
	async save(value) {
		const payload = JSON.stringify(value);
		if (Buffer.byteLength(payload, "utf8") >= 8192) throw new Error("Secret Service credential payload is too large");
		if ((await runSecretTool([
			"store",
			"--label=DSH Antigravity OAuth",
			...this.attributes()
		], payload)).code !== 0) throw new Error(UNAVAILABLE);
	}
	async clear() {
		const result = await runSecretTool(["clear", ...this.attributes()]);
		if (result.code !== 0 && !(result.code === 1 && !result.hasStderr)) throw new Error(UNAVAILABLE);
	}
};
function runSecretTool(args, stdin = "") {
	return new Promise((resolve, reject) => {
		const child = spawn("secret-tool", args, {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let stdout = "";
		let stderrLength = 0;
		let settled = false;
		const fail = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			reject(/* @__PURE__ */ new Error(UNAVAILABLE));
		};
		const timer = setTimeout(fail, 1e4);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 1 << 20) fail();
		});
		child.stderr.on("data", (chunk) => {
			stderrLength += chunk.length;
			if (stderrLength > 1 << 20) fail();
		});
		child.once("error", fail);
		child.stdin.once("error", fail);
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: code ?? 1,
				stdout,
				hasStderr: stderrLength > 0
			});
		});
		child.stdin.end(stdin);
	});
}
//#endregion
//#region src/host/antigravity/token-store.ts
const ANTIGRAVITY_PREFERENCES_NAMESPACE = "dsh-antigravity";
function registerAntigravityPreferenceStore(settings, fallbackStore = new FileModelSettingsStore()) {
	if (!settings) return {
		status: () => ({
			enabledModelIds: MODELS.map((m) => m.id),
			catalogModels: [],
			contextWindowOverrides: {},
			defaultReasoningEffort: null
		}),
		update: async (patch) => fallbackStore.updateSettings(patch)
	};
	const ns = SettingsModule.settingsNamespace ? SettingsModule.settingsNamespace(ANTIGRAVITY_PREFERENCES_NAMESPACE) : ANTIGRAVITY_PREFERENCES_NAMESPACE;
	const scope = settings.register.call(settings, ns, z.object({
		enabledModelIds: z.array(z.string()).default(MODELS.map((m) => m.id)),
		contextWindowOverrides: z.dict(z.number()).default({}),
		defaultReasoningEffort: z.union([
			z.const("low"),
			z.const("medium"),
			z.const("high"),
			z.const(null)
		]).default(null)
	}));
	return {
		status: () => {
			const val = scope.get();
			return {
				enabledModelIds: val.enabledModelIds,
				catalogModels: [],
				contextWindowOverrides: val.contextWindowOverrides,
				defaultReasoningEffort: val.defaultReasoningEffort
			};
		},
		update: async (patch) => {
			const current = scope.get();
			const normalized = {
				enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
				contextWindowOverrides: patch.contextWindowOverrides ? {
					...current.contextWindowOverrides,
					...patch.contextWindowOverrides
				} : current.contextWindowOverrides,
				defaultReasoningEffort: patch.defaultReasoningEffort !== void 0 ? patch.defaultReasoningEffort : current.defaultReasoningEffort
			};
			await scope.update(normalized);
			fallbackStore.updateSettings(patch).catch(() => void 0);
			return {
				...normalized,
				catalogModels: []
			};
		}
	};
}
function dshHomeDir() {
	return process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
}
function credentialPath() {
	return path.join(dshHomeDir(), "storages", "antigravity-oauth.json");
}
function modelSettingsPath() {
	return path.join(dshHomeDir(), "storages", "antigravity-models.json");
}
function parseAntigravityCredentials(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Antigravity credential payload is invalid");
	const record = value;
	const credentials = {};
	for (const key of [
		"access",
		"access_token",
		"refresh",
		"refresh_token",
		"email",
		"projectId"
	]) {
		if (record[key] === void 0) continue;
		if (typeof record[key] !== "string") throw new Error("Antigravity credential payload is invalid");
		credentials[key] = record[key];
	}
	for (const key of ["expires", "expires_at"]) {
		if (record[key] === void 0) continue;
		if (typeof record[key] !== "number" || !Number.isFinite(record[key])) throw new Error("Antigravity credential expiry is invalid");
		credentials[key] = record[key];
	}
	if (!(credentials.access || credentials.access_token || credentials.refresh || credentials.refresh_token)) throw new Error("Antigravity credential tokens are missing");
	return credentials;
}
function credentialAccount(filePath) {
	return createHash("sha256").update(path.resolve(filePath)).digest("hex");
}
function createCredentialBackend(filePath) {
	if (process.platform === "win32") return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseAntigravityCredentials);
	if (process.platform === "darwin") return new MacKeychainCredentialStore("dsh-antigravity", credentialAccount(filePath), parseAntigravityCredentials);
	if (process.platform === "linux") return new SecretServiceCredentialStore("dsh-antigravity", credentialAccount(filePath), parseAntigravityCredentials);
	throw new Error("Antigravity encrypted credential storage requires Windows, macOS, or Linux.");
}
const credentialOperations = /* @__PURE__ */ new Map();
/** Keeps the public API; filePath identifies the legacy JSON that is migrated on first use. */
var FileCredentialStore = class {
	filePath;
	backend;
	constructor(filePath = credentialPath(), backend = createCredentialBackend(filePath)) {
		this.filePath = filePath;
		this.backend = backend;
	}
	path() {
		if (process.platform === "win32") return `${this.filePath}.dpapi`;
		return `${process.platform === "darwin" ? "Keychain" : "Secret Service"}: dsh-antigravity/${credentialAccount(this.filePath)}`;
	}
	serialize(operation) {
		const key = path.resolve(this.filePath);
		const result = (credentialOperations.get(key) || Promise.resolve()).then(operation);
		const settled = result.then(() => void 0, () => void 0);
		credentialOperations.set(key, settled);
		settled.then(() => {
			if (credentialOperations.get(key) === settled) credentialOperations.delete(key);
		});
		return result;
	}
	async removeLegacy() {
		try {
			await fsPromises.unlink(this.filePath);
		} catch (error) {
			if (error.code !== "ENOENT") throw new Error("Antigravity legacy credential removal failed");
		}
	}
	async saveVerified(credentials) {
		await this.backend.save(credentials);
		if (!isDeepStrictEqual(await this.backend.load(), credentials)) throw new Error("Antigravity encrypted credential verification failed");
		await this.removeLegacy();
	}
	read() {
		return this.serialize(async () => {
			const current = await this.backend.load();
			if (current !== null) {
				await this.removeLegacy();
				return current;
			}
			let legacy;
			try {
				const stats = await fsPromises.lstat(this.filePath);
				if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid credential file");
				if (process.getuid && stats.uid !== process.getuid()) throw new Error("Invalid credential owner");
				if (process.platform !== "win32") await fsPromises.chmod(this.filePath, 384);
				legacy = await fsPromises.readFile(this.filePath, "utf8");
			} catch (error) {
				if (error.code === "ENOENT") return null;
				throw new Error("Antigravity legacy credential read failed");
			}
			let credentials;
			try {
				credentials = parseAntigravityCredentials(JSON.parse(legacy));
			} catch {
				throw new Error("Antigravity legacy credential payload is invalid");
			}
			await this.saveVerified(credentials);
			return credentials;
		});
	}
	write(credentials) {
		return this.serialize(() => this.saveVerified(parseAntigravityCredentials(credentials)));
	}
	delete() {
		return this.serialize(async () => {
			await this.removeLegacy();
			await this.backend.clear();
		});
	}
};
var FileModelSettingsStore = class {
	filePath;
	constructor(filePath = modelSettingsPath()) {
		this.filePath = filePath;
	}
	path() {
		return this.filePath;
	}
	async read() {
		try {
			const content = await fsPromises.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(content);
			if (typeof parsed === "object" && parsed !== null) {
				const record = parsed;
				return {
					enabledModelIds: Array.isArray(record.enabledModelIds) ? record.enabledModelIds.filter((id) => typeof id === "string") : MODELS.map((m) => m.id),
					catalogModels: Array.isArray(record.catalogModels) ? record.catalogModels : [],
					contextWindowOverrides: typeof record.contextWindowOverrides === "object" && record.contextWindowOverrides !== null ? record.contextWindowOverrides : {},
					defaultReasoningEffort: record.defaultReasoningEffort === "low" || record.defaultReasoningEffort === "medium" || record.defaultReasoningEffort === "high" ? record.defaultReasoningEffort : null
				};
			}
		} catch {}
		return {
			enabledModelIds: MODELS.map((m) => m.id),
			catalogModels: [],
			contextWindowOverrides: {},
			defaultReasoningEffort: null
		};
	}
	async write(settings) {
		await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp.${Date.now()}`;
		await fsPromises.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
		await fsPromises.rename(tmp, this.filePath);
	}
	async updateSettings(patch) {
		const current = await this.read();
		const next = {
			...current,
			...patch.enabledModelIds !== void 0 ? { enabledModelIds: patch.enabledModelIds } : {},
			...patch.contextWindowOverrides !== void 0 ? { contextWindowOverrides: {
				...current.contextWindowOverrides || {},
				...patch.contextWindowOverrides
			} } : {},
			...patch.defaultReasoningEffort !== void 0 ? { defaultReasoningEffort: patch.defaultReasoningEffort } : {}
		};
		await this.write(next);
		return next;
	}
	async setEnabledModelIds(enabledModelIds) {
		return this.updateSettings({ enabledModelIds });
	}
	async setCatalogModels(catalogModels, options) {
		const current = await this.read();
		const next = {
			...current,
			enabledModelIds: options?.enabledModelIds ?? current.enabledModelIds,
			catalogModels
		};
		await this.write(next);
		return next;
	}
};
//#endregion
//#region src/host/antigravity/client.ts
const projectCache = /* @__PURE__ */ new Map();
let cachedQuota;
const PLATFORM = process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
function defaultUserAgent() {
	return `antigravity/1.15.8 ${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}/${process.arch === "x64" ? "amd64" : process.arch}`;
}
function antigravityHeaders(token) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"User-Agent": process.env.DSH_ANTIGRAVITY_USER_AGENT || defaultUserAgent(),
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform: PLATFORM,
			pluginType: "GEMINI"
		})
	};
}
function jsonHeaders(token) {
	return {
		...antigravityHeaders(token),
		Accept: "application/json"
	};
}
function endpointCandidates() {
	const custom = process.env.DSH_ANTIGRAVITY_ENDPOINT?.trim();
	if (custom) return [custom];
	return ENDPOINT_FALLBACKS;
}
function extractProjectId(data) {
	if (typeof data !== "object" || data === null) return void 0;
	const record = data;
	const direct = record.antigravityProjectId ?? record.projectId ?? record.backendProjectId ?? record.userDefinedCloudaicompanionProject ?? record.cloudaicompanionProject ?? record.project;
	if (typeof direct === "string" && direct.length > 0) return direct;
	if (typeof direct === "object" && direct !== null && "id" in direct && typeof direct.id === "string") return direct.id;
	for (const key of [
		"projects",
		"projectIds",
		"cloudaicompanionProjects"
	]) {
		const list = record[key];
		if (Array.isArray(list)) for (const item of list) {
			const nested = extractProjectId(item);
			if (nested) return nested;
			if (typeof item === "string" && item.length > 0) return item;
		}
	}
}
async function listCloudAICompanionProjects(token, fetchFn = fetch) {
	for (const endpoint of endpointCandidates()) try {
		const response = await fetchFn(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
			method: "POST",
			headers: antigravityHeaders(token),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
		if (!response.ok) continue;
		return extractProjectId(await response.json());
	} catch {}
}
async function loadCodeAssist(token, fetchFn = fetch) {
	const cached = projectCache.get(token);
	if (cached && cached.expiresAt > Date.now()) return cached.projectId;
	const body = JSON.stringify({ metadata: {
		ideType: "ANTIGRAVITY",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI"
	} });
	for (const endpoint of endpointCandidates()) try {
		const response = await fetchFn(`${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: antigravityHeaders(token),
			body,
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
		if (!response.ok) continue;
		const project = extractProjectId(await response.json());
		if (project) {
			projectCache.set(token, {
				projectId: project,
				expiresAt: Date.now() + PROJECT_CACHE_TTL_MS
			});
			return project;
		}
		const listProj = await listCloudAICompanionProjects(token, fetchFn);
		if (listProj) {
			projectCache.set(token, {
				projectId: listProj,
				expiresAt: Date.now() + PROJECT_CACHE_TTL_MS
			});
			return listProj;
		}
	} catch {}
}
async function postJson(path, token, body, fetchFn = fetch) {
	for (const endpoint of endpointCandidates()) try {
		const response = await fetchFn(`${endpoint}${path}`, {
			method: "POST",
			headers: jsonHeaders(token),
			body: JSON.stringify(body)
		});
		if (response.ok) return {
			endpoint,
			status: response.status,
			data: await response.json()
		};
	} catch {}
	throw new Error(`Failed to call Antigravity API ${path}`);
}
function parseQuotaSummary(data) {
	const summary = typeof data === "object" && data !== null ? data : {};
	const rawGroups = Array.isArray(summary.groups) ? summary.groups : [];
	const groups = [];
	for (const group of rawGroups) {
		if (typeof group !== "object" || group === null) continue;
		const groupRec = group;
		const buckets = [];
		const rawBuckets = Array.isArray(groupRec.buckets) ? groupRec.buckets : [];
		for (const bucket of rawBuckets) {
			if (typeof bucket !== "object" || bucket === null) continue;
			const bRec = bucket;
			const remaining = typeof bRec.remainingFraction === "number" ? Math.max(0, Math.min(1, bRec.remainingFraction)) : 0;
			buckets.push({
				bucketId: String(bRec.bucketId || bRec.displayName || "limit"),
				displayName: String(bRec.displayName || bRec.bucketId || "Limit"),
				window: typeof bRec.window === "string" ? bRec.window : void 0,
				resetTime: typeof bRec.resetTime === "string" ? bRec.resetTime : void 0,
				description: typeof bRec.description === "string" ? bRec.description : void 0,
				remainingFraction: remaining
			});
		}
		if (buckets.length > 0 || groupRec.displayName) groups.push({
			displayName: String(groupRec.displayName || "Quota group"),
			description: typeof groupRec.description === "string" ? groupRec.description : void 0,
			buckets
		});
	}
	return {
		groups,
		description: typeof summary.description === "string" ? summary.description : void 0
	};
}
function parseCatalogModels(data) {
	if (typeof data !== "object" || data === null) return [];
	const record = data;
	const rawModels = typeof record.models === "object" && record.models !== null ? record.models : {};
	const list = [];
	for (const [modelId, info] of Object.entries(rawModels)) {
		if (typeof info !== "object" || info === null) continue;
		const rec = info;
		if (rec.isInternal || modelId.startsWith("chat_")) continue;
		list.push({
			id: modelId,
			name: typeof rec.displayName === "string" ? rec.displayName : modelId,
			description: typeof rec.description === "string" ? rec.description : void 0
		});
	}
	return list;
}
async function fetchAccountQuota(store = new FileCredentialStore(), modelSettings, fetchFn = fetch) {
	const { token, projectId: credentialProjectId } = await ensureApiKey(store, fetchFn);
	const [assistResult, summaryResult] = await Promise.all([postJson("/v1internal:loadCodeAssist", token, { metadata: {
		ideType: "ANTIGRAVITY",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI"
	} }, fetchFn).catch(() => null), postJson("/v1internal:retrieveUserQuotaSummary", token, {}, fetchFn).catch(() => null)]);
	const discoveredProject = assistResult ? extractProjectId(assistResult.data) : void 0;
	const projectId = credentialProjectId || discoveredProject || "antigravity-default";
	const modelsData = (await postJson("/v1internal:fetchAvailableModels", token, { project: projectId }, fetchFn).catch(() => null))?.data;
	const { groups, description } = summaryResult ? parseQuotaSummary(summaryResult.data) : { groups: [] };
	const catalogModels = modelsData ? parseCatalogModels(modelsData) : [];
	const assistData = assistResult?.data || {};
	const currentTier = assistData.currentTier;
	const paidTier = assistData.paidTier;
	const planLabel = paidTier?.name || currentTier?.name || void 0;
	cachedQuota = {
		projectId,
		endpoint: summaryResult?.endpoint || ENDPOINT_FALLBACKS[0],
		planLabel,
		productTier: currentTier,
		paidTier,
		groups,
		groupDescription: description,
		models: catalogModels.map((m) => ({
			modelId: m.id,
			displayName: m.name,
			description: m.description
		})),
		catalogModels,
		fetchedAt: Date.now()
	};
	if (modelSettings && catalogModels.length > 0) {
		const current = await modelSettings.read();
		const isFirstTime = current.catalogModels.length === 0 && current.enabledModelIds.length === 0;
		const catalogIds = new Set(catalogModels.map((m) => m.id));
		const mergedEnabled = isFirstTime ? catalogModels.map((m) => m.id) : current.enabledModelIds.filter((id) => catalogIds.has(id));
		await modelSettings.setCatalogModels(catalogModels, { enabledModelIds: mergedEnabled });
	}
	return cachedQuota;
}
function getCachedQuota() {
	return cachedQuota;
}
//#endregion
//#region src/host/antigravity/oauth.ts
let webLoginFlow = { status: "idle" };
function antigravityEnv(namePart) {
	const full = `DSH_ANTIGRAVITY_${namePart}`;
	return process.env[full];
}
function callbackPort() {
	const configured = Number(antigravityEnv("CALLBACK_PORT"));
	if (Number.isInteger(configured) && configured > 0 && configured <= 65535) return configured;
	return 51121;
}
function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")) {
	const host = (raw || "localhost").trim().toLowerCase();
	if (host === "localhost" || host === "127.0.0.1" || host === "::1") return host;
	return "localhost";
}
function redirectUri() {
	return `http://${resolveCallbackHost()}:${callbackPort()}${"/oauth-callback".startsWith("/"), REDIRECT_PATH}`;
}
function clientId() {
	return antigravityEnv("CLIENT_ID")?.trim() || DEFAULT_CLIENT_ID;
}
function clientSecret() {
	return antigravityEnv("CLIENT_SECRET")?.trim() || DEFAULT_CLIENT_SECRET;
}
function base64Url(buffer) {
	return buffer.toString("base64url");
}
function generatePKCE() {
	const verifier = base64Url(randomBytes(32));
	return {
		verifier,
		challenge: base64Url(createHash("sha256").update(verifier).digest())
	};
}
function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function sanitizeOAuthProviderError(text) {
	return escapeHtml(text.slice(0, 300).replace(/[\r\n\t]+/g, " "));
}
function openBrowser(url) {
	try {
		if (process.platform === "darwin") spawn("open", [url], {
			stdio: "ignore",
			detached: true
		});
		else if (process.platform === "win32") spawn("cmd", [
			"/c",
			"start",
			"",
			url
		], {
			stdio: "ignore",
			detached: true
		});
		else spawn("xdg-open", [url], {
			stdio: "ignore",
			detached: true
		});
	} catch {}
}
async function getUserEmail(token, fetchFn = fetch) {
	try {
		const response = await fetchFn("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", { headers: { Authorization: `Bearer ${token}` } });
		if (!response.ok) return void 0;
		const data = await response.json();
		return typeof data.email === "string" ? data.email : void 0;
	} catch {
		return;
	}
}
function startCallbackServer(expectedState) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout;
		let resolveCode;
		let rejectCode;
		const codePromise = new Promise((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});
		const finish = (fn) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			fn();
		};
		const callbackUrl = redirectUri();
		const server = createServer((request, response) => {
			if (request.method !== "GET" && request.method !== "HEAD") {
				response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Method Not Allowed");
				return;
			}
			const url = new URL$1(request.url || "", callbackUrl);
			if (url.pathname !== "/oauth-callback") {
				response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				response.end("Antigravity OAuth callback route not found.");
				return;
			}
			const providerError = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (providerError) {
				const safe = escapeHtml(providerError.slice(0, 200));
				response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				response.end(`Antigravity authentication failed: ${safe}`);
				finish(() => rejectCode(/* @__PURE__ */ new Error(`OAuth error: ${providerError.slice(0, 200)}`)));
				return;
			}
			if (!code || !state) {
				response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				response.end("Antigravity authentication failed: missing code or state.");
				finish(() => rejectCode(/* @__PURE__ */ new Error("Missing code or state in OAuth callback")));
				return;
			}
			if (state !== expectedState) {
				response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				response.end("Antigravity authentication failed: invalid state.");
				finish(() => rejectCode(/* @__PURE__ */ new Error("OAuth state mismatch")));
				return;
			}
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end("Antigravity authentication complete. You can close this window and return to DSH.");
			finish(() => resolveCode({
				code,
				state
			}));
		});
		server.on("error", reject);
		server.listen(callbackPort(), resolveCallbackHost(), () => {
			timeout = setTimeout(() => {
				finish(() => rejectCode(/* @__PURE__ */ new Error("OAuth callback timed out waiting for browser login")));
				server.close();
			}, OAUTH_CALLBACK_TIMEOUT_MS);
			resolve({
				server,
				waitForCode: () => codePromise
			});
		});
	});
}
async function exchangeOAuthCode(code, verifier, callbackUrl, fetchFn = fetch) {
	const tokenResponse = await fetchFn(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams$1({
			client_id: clientId(),
			client_secret: clientSecret(),
			code,
			grant_type: "authorization_code",
			redirect_uri: callbackUrl,
			code_verifier: verifier
		}).toString()
	});
	if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`);
	const tokenData = await tokenResponse.json();
	const refreshToken = typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : void 0;
	const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
	const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;
	if (!refreshToken) throw new Error("No refresh token received. Re-run login and allow offline access.");
	const [email, discoveredProject] = await Promise.all([getUserEmail(accessToken, fetchFn), loadCodeAssist(accessToken, fetchFn).catch(() => void 0)]);
	return {
		refresh: refreshToken,
		refresh_token: refreshToken,
		access: accessToken,
		access_token: accessToken,
		expires: Date.now() + expiresIn * 1e3 - 300 * 1e3,
		expires_at: Date.now() + expiresIn * 1e3 - 300 * 1e3,
		projectId: discoveredProject || void 0,
		email
	};
}
async function beginWebLogin(store, fetchFn = fetch) {
	if (webLoginFlow.status === "pending") return { ...webLoginFlow };
	const { verifier, challenge } = generatePKCE();
	const state = base64Url(randomBytes(32));
	const { server, waitForCode } = await startCallbackServer(state);
	const callbackUrl = redirectUri();
	webLoginFlow = {
		status: "pending",
		authUrl: `${AUTH_URL}?${new URLSearchParams$1({
			client_id: clientId(),
			response_type: "code",
			redirect_uri: callbackUrl,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent"
		}).toString()}`,
		startedAt: Date.now(),
		error: void 0
	};
	(async () => {
		try {
			const { code, state: returnedState } = await waitForCode();
			if (returnedState !== state) throw new Error("OAuth state mismatch");
			const credentials = await exchangeOAuthCode(code, verifier, callbackUrl, fetchFn);
			await store.write(credentials);
			webLoginFlow.status = "complete";
			webLoginFlow.email = credentials.email;
			webLoginFlow.completedAt = Date.now();
		} catch (error) {
			webLoginFlow.status = "error";
			webLoginFlow.error = error instanceof Error ? error.message : String(error);
			webLoginFlow.completedAt = Date.now();
		} finally {
			server.close();
		}
	})();
	return { ...webLoginFlow };
}
function getWebLoginStatus() {
	return { ...webLoginFlow };
}
async function refreshAntigravityToken(credentials, fetchFn = fetch) {
	const refreshToken = credentials.refresh || credentials.refresh_token;
	if (!refreshToken) throw new Error("Missing Antigravity refresh token.");
	const response = await fetchFn(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams$1({
			client_id: clientId(),
			client_secret: clientSecret(),
			refresh_token: refreshToken,
			grant_type: "refresh_token"
		}).toString()
	});
	if (!response.ok) throw new Error(`Token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`);
	const data = await response.json();
	const accessToken = typeof data.access_token === "string" ? data.access_token : "";
	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
	const nextRefreshToken = typeof data.refresh_token === "string" ? data.refresh_token : refreshToken;
	return {
		...credentials,
		refresh: nextRefreshToken,
		refresh_token: nextRefreshToken,
		access: accessToken,
		access_token: accessToken,
		expires: Date.now() + expiresIn * 1e3 - 300 * 1e3,
		expires_at: Date.now() + expiresIn * 1e3 - 300 * 1e3
	};
}
async function ensureApiKey(store, fetchFn = fetch) {
	let credentials = await store.read();
	if (!credentials) throw new Error("Not logged into Antigravity. Please log in from Settings > Antigravity.");
	const expires = credentials.expires || credentials.expires_at || 0;
	if (!(credentials.access || credentials.access_token) || expires <= Date.now() + 6e4) {
		credentials = await refreshAntigravityToken(credentials, fetchFn);
		await store.write(credentials);
	}
	return {
		token: credentials.access || credentials.access_token,
		projectId: credentials.projectId
	};
}
async function loginAndSave(store, signal, onUrl, fetchFn = fetch) {
	const { verifier, challenge } = generatePKCE();
	const state = base64Url(randomBytes(32));
	const { server, waitForCode } = await startCallbackServer(state);
	const callbackUrl = redirectUri();
	const authUrl = `${AUTH_URL}?${new URLSearchParams$1({
		client_id: clientId(),
		response_type: "code",
		redirect_uri: callbackUrl,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent"
	}).toString()}`;
	try {
		if (onUrl) onUrl(authUrl);
		openBrowser(authUrl);
		if (signal?.aborted) throw new Error("OAuth login aborted");
		const { code, state: returnedState } = await waitForCode();
		if (returnedState !== state) throw new Error("OAuth state mismatch");
		const credentials = await exchangeOAuthCode(code, verifier, callbackUrl, fetchFn);
		await store.write(credentials);
		return credentials;
	} finally {
		server.close();
	}
}
//#endregion
//#region src/host/antigravity/mapper.ts
let toolCallCounter = 0;
function sanitizeText(text) {
	return text.replace(/\0/g, "");
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
	return typeof value === "string" ? value : void 0;
}
function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
function sanitizeToolCallId(id, fallbackName) {
	return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}
function toolCallIdNeeded(modelId, runtimeModel) {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") || runtimeModel.startsWith("claude-") || runtimeModel.startsWith("gpt-oss-");
}
function parseArguments(raw) {
	if (isRecord(raw)) return raw;
	if (raw === void 0 || raw === null || raw === "") return {};
	const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
	return isRecord(parsed) ? parsed : {};
}
function imageBlockToPart(block) {
	let data = asString(block.data) || asString(block.base64);
	const source = isRecord(block.source) ? block.source : void 0;
	if (!data && source) data = asString(source.data) || asString(source.base64);
	let mimeType = asString(block.mimeType) || asString(block.mediaType) || (source ? asString(source.mimeType) || asString(source.mediaType) : void 0) || "image/png";
	if (data?.startsWith("data:")) {
		const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
		if (match) {
			mimeType = match[1] || mimeType;
			data = match[2] || "";
		}
	}
	return data ? { inlineData: {
		mimeType,
		data
	} } : void 0;
}
function contentToUserParts(content) {
	if (typeof content === "string") return [{ text: sanitizeText(content) }];
	if (!Array.isArray(content)) return [];
	const parts = [];
	for (const block of content) if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push({ text: sanitizeText(block.text) });
	else if (isRecord(block) && block.type === "image") {
		const img = imageBlockToPart(block);
		if (img) parts.push(img);
	}
	return parts;
}
function toolResultText(blocks) {
	if (!Array.isArray(blocks)) return "";
	return blocks.map((block) => {
		if (!isRecord(block)) return "";
		if (block.type === "text" && typeof block.text === "string") return sanitizeText(block.text);
		if (block.type === "tool-result") return toolResultText(block.content);
		return "";
	}).join("");
}
function replayBlockFor(message, index) {
	const source = message.source;
	if (!source || source.kind !== "model" || source.provider !== "antigravity") return void 0;
	const state = source.replayState;
	if (!isRecord(state)) return void 0;
	if (Array.isArray(state.blocks)) return state.blocks[index];
	const resp = isRecord(state.response) ? state.response : void 0;
	if (resp) {
		if (Array.isArray(resp.outputItems)) return resp.outputItems[index];
		if (Array.isArray(resp.blocks)) return resp.blocks[index];
	}
}
function thoughtSignature(part) {
	return asString(part?.thoughtSignature) || asString(part?.thought_signature) || asString(part?.thinkingSignature) || asString(part?.textSignature);
}
function replayPart(part) {
	const copy = { ...part };
	const signature = thoughtSignature(part);
	delete copy.thought_signature;
	delete copy.thinkingSignature;
	if (signature) copy.thoughtSignature = signature;
	if (typeof copy.text === "string") copy.text = sanitizeText(copy.text);
	return copy;
}
function assistantParts(message, model, runtimeModel, toolNames) {
	const parts = [];
	if (!Array.isArray(message.content)) return parts;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (!isRecord(block)) continue;
		const replay = replayBlockFor(message, index);
		const originalParts = Array.isArray(replay?.parts) ? replay.parts.filter(isRecord) : [];
		if ((block.type === "text" || block.type === "reasoning") && originalParts.length > 0 && originalParts.every((part) => !part.functionCall) && originalParts.map((part) => asString(part.text) || "").join("") === sanitizeText(String(block.text || ""))) {
			parts.push(...originalParts.map(replayPart));
			continue;
		}
		if (block.type === "text" && String(block.text || "").trim()) {
			const sig = thoughtSignature(replay) || thoughtSignature(block);
			parts.push({
				text: sanitizeText(String(block.text)),
				...sig ? { thoughtSignature: sig } : {}
			});
		} else if (block.type === "reasoning" && String(block.text || "").trim()) {
			const sig = thoughtSignature(replay) || thoughtSignature(block);
			parts.push({
				thought: true,
				text: sanitizeText(String(block.text)),
				...sig ? { thoughtSignature: sig } : {}
			});
		} else if (block.type === "tool-call") {
			const toolId = String(block.id || "");
			const toolName = String(block.name || "");
			toolNames.set(toolId, toolName);
			const originalCall = originalParts.find((part) => isRecord(part.functionCall));
			const effectiveSignature = thoughtSignature(originalCall) || thoughtSignature(replay) || thoughtSignature(block) || (originalCall ? void 0 : "skip_thought_signature_validator");
			parts.push({
				functionCall: {
					name: toolName,
					args: parseArguments(block.arguments),
					...toolCallIdNeeded(model.id, runtimeModel) ? { id: sanitizeToolCallId(toolId, toolName) } : {}
				},
				...effectiveSignature ? { thoughtSignature: effectiveSignature } : {}
			});
			parts.push(...originalParts.filter((part) => !part.functionCall).map(replayPart));
		}
	}
	return parts;
}
function pushToolResult(contents, result, toolNames, model, runtimeModel) {
	const toolCallId = String(result.toolCallId || "");
	const toolName = toolNames.get(toolCallId) || "unknown";
	const responseText = toolResultText(result.content) || (result.isError ? "Tool failed" : "");
	const part = { functionResponse: {
		name: toolName,
		response: result.isError ? { error: responseText } : { output: responseText },
		...toolCallIdNeeded(model.id, runtimeModel) ? { id: sanitizeToolCallId(toolCallId, toolName) } : {}
	} };
	const last = contents[contents.length - 1];
	if (last?.role === GEMINI_ROLE.user && last.parts.some((entry) => "functionResponse" in entry)) last.parts.push(part);
	else contents.push({
		role: GEMINI_ROLE.user,
		parts: [part]
	});
}
function convertMessages(options, model, runtimeModel) {
	const contents = [];
	const toolNames = /* @__PURE__ */ new Map();
	for (const message of options.messages) {
		const role = message.role || (message.source?.kind === "model" ? "assistant" : "user");
		if (role === "assistant" || message.source?.kind === "model") {
			const parts = assistantParts(message, model, runtimeModel, toolNames);
			if (parts.length) contents.push({
				role: GEMINI_ROLE.model,
				parts
			});
			continue;
		}
		const content = Array.isArray(message.content) ? message.content : [];
		const userParts = contentToUserParts(content.filter((b) => !isRecord(b) || b.type !== "tool-result"));
		if (role === "system") {
			if (userParts.length) contents.push({
				role: GEMINI_ROLE.user,
				parts: userParts
			});
			continue;
		}
		if (userParts.length) contents.push({
			role: GEMINI_ROLE.user,
			parts: userParts
		});
		for (const b of content) if (isRecord(b) && b.type === "tool-result") pushToolResult(contents, b, toolNames, model, runtimeModel);
	}
	return contents;
}
function stripMetaSchema(schema) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const omit = /* @__PURE__ */ new Set([
		"$schema",
		"$id",
		"$anchor",
		"$dynamicAnchor",
		"$vocabulary",
		"$comment",
		"$defs",
		"definitions"
	]);
	const out = {};
	for (const [k, v] of Object.entries(schema)) if (!omit.has(k)) out[k] = stripMetaSchema(v);
	return out;
}
function convertTools(tools) {
	if (!tools || tools.length === 0) return void 0;
	return [{ functionDeclarations: tools.map((tool) => ({
		name: tool.name,
		description: tool.description || "",
		parameters: stripMetaSchema(tool.parameters) || {
			type: "object",
			properties: {}
		}
	})) }];
}
function mapToolChoiceMode(toolChoice) {
	if (toolChoice === "none") return TOOL_CALLING_MODE.none;
	if (toolChoice === "any" || toolChoice === "required") return TOOL_CALLING_MODE.any;
	return TOOL_CALLING_MODE.auto;
}
function getMaxOutputTokens(modelId, runtimeModel) {
	return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] || RUNTIME_MAX_OUTPUT_TOKENS[modelId] || 65536;
}
function buildRequest(options, model, projectId, runtimeModel, effort) {
	const request = {
		contents: convertMessages(options, model, runtimeModel),
		systemInstruction: {
			role: GEMINI_ROLE.user,
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				{ text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
				...options.system ? [{ text: sanitizeText(options.system) }] : []
			]
		}
	};
	const generationConfig = {};
	if (options.temperature !== void 0) generationConfig.temperature = options.temperature;
	const isTiered = runtimeModel === "gemini-3.8-flash-tiered" || runtimeModel === "gemini-3.7-flash-tiered";
	const isSuffixed = /^gemini-.+(?:-(?:extra-)?low|-medium|-high|-xhigh)$/.test(runtimeModel);
	const isGemini25 = runtimeModel.startsWith("gemini-2.5-") || model.id.startsWith("gemini-2.5-");
	const isGemini3 = /^gemini-3[.-]/.test(runtimeModel) && !runtimeModel.includes("image");
	const isGeminiAgent = runtimeModel === "gemini-pro-agent" || runtimeModel === "gemini-3-flash-agent";
	if (isTiered) {
		const selected = (effort || "medium").toLowerCase();
		const isOff = selected === "off" || selected === "none";
		generationConfig.thinkingConfig = {
			thinkingLevel: isOff ? "MINIMAL" : selected === "high" || selected === "xhigh" ? "HIGH" : selected === "medium" ? "MEDIUM" : "LOW",
			includeThoughts: !isOff
		};
	} else if (isSuffixed || isGemini3 || isGeminiAgent) {
		const selected = (effort || "medium").toLowerCase();
		generationConfig.thinkingConfig = { includeThoughts: !(selected === "off" || selected === "none") };
	} else if (isGemini25) {
		const selected = (effort || "medium").toLowerCase();
		const isOff = selected === "off" || selected === "none";
		generationConfig.thinkingConfig = {
			thinkingBudget: isOff ? 0 : selected === "high" || selected === "xhigh" ? 32768 : selected === "medium" ? 16384 : 4096,
			includeThoughts: !isOff
		};
	}
	const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
	generationConfig.maxOutputTokens = options.maxTokens !== void 0 ? Math.min(options.maxTokens, maxAllowed) : maxAllowed;
	request.generationConfig = generationConfig;
	const toolChoice = options.toolChoice;
	const tools = convertTools(options.tools);
	if (tools) {
		request.tools = tools;
		if (toolChoice) request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(toolChoice) } };
	}
	if (options.sessionId) request.sessionId = String(options.sessionId);
	return {
		project: projectId,
		model: runtimeModel,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
	};
}
function createStreamState() {
	return {
		blocks: [],
		replayBlocks: [],
		currentBlock: null,
		hasContent: false,
		hasToolCall: false,
		usageMetadata: null,
		done: false,
		finished: false
	};
}
function closeCurrentBlock(state) {
	if (!state.currentBlock) return [];
	const { index, type, text } = state.currentBlock;
	const block = {
		type,
		text
	};
	state.blocks[index] = block;
	state.currentBlock = null;
	return [{
		type: "block-end",
		index,
		block
	}];
}
const USAGE_FIELDS = [
	"promptTokenCount",
	"cachedContentTokenCount",
	"candidatesTokenCount",
	"thoughtsTokenCount",
	"totalTokenCount"
];
function collectUsage(value, state) {
	if (!isRecord(value)) return;
	for (const key of USAGE_FIELDS) {
		const count = value[key];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
		state.usageMetadata ??= {};
		state.usageMetadata[key] = count;
	}
}
function tokenUsage(u) {
	const prompt = u.promptTokenCount ?? 0;
	const cache = Math.min(prompt, u.cachedContentTokenCount ?? 0);
	const thoughts = u.thoughtsTokenCount ?? 0;
	const explicitOutput = (u.candidatesTokenCount ?? 0) + thoughts;
	const totalOutput = u.totalTokenCount !== void 0 && u.promptTokenCount !== void 0 ? Math.max(0, u.totalTokenCount - prompt) : 0;
	return {
		inputTokens: prompt - cache,
		outputTokens: Math.max(explicitOutput, totalOutput),
		...cache > 0 ? { cacheReadTokens: cache } : {},
		...u.thoughtsTokenCount !== void 0 ? { reasoningTokens: thoughts } : {}
	};
}
function processStreamLine(line, state) {
	if (state.finished || !line.startsWith("data:")) return [];
	const json = line.slice(5).trim();
	if (json === "[DONE]") {
		state.done = true;
		return closeStream(state);
	}
	if (!json) return [];
	const chunk = safeJsonParse(json);
	if (!isRecord(chunk)) return [];
	const responseData = isRecord(chunk.response) ? chunk.response : chunk;
	const candidates = Array.isArray(responseData.candidates) ? responseData.candidates : [];
	const candidate = isRecord(candidates[0]) ? candidates[0] : void 0;
	const content = isRecord(candidate?.content) ? candidate.content : void 0;
	const parts = Array.isArray(content?.parts) ? content.parts : [];
	const out = [];
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (typeof part.text === "string" && part.text !== "") {
			const isThinking = Boolean(part.thought);
			const blockType = isThinking ? "reasoning" : "text";
			if (!state.currentBlock || state.currentBlock.type !== blockType) {
				out.push(...closeCurrentBlock(state));
				const index = state.blocks.length;
				state.currentBlock = {
					index,
					type: blockType,
					text: ""
				};
				state.blocks.push({
					type: blockType,
					text: ""
				});
				state.replayBlocks.push({ parts: [] });
				out.push({
					type: "block-start",
					index,
					blockType
				});
			}
			const delta = sanitizeText(part.text);
			state.currentBlock.text += delta;
			state.hasContent = true;
			state.replayBlocks[state.currentBlock.index].parts.push(replayPart(part));
			out.push({
				type: isThinking ? "reasoning-delta" : "text-delta",
				index: state.currentBlock.index,
				text: delta
			});
		} else if (!isRecord(part.functionCall) && thoughtSignature(part)) {
			if (state.replayBlocks.length === 0) {
				const type = part.thought ? "reasoning" : "text";
				state.blocks.push({
					type,
					text: ""
				});
				state.replayBlocks.push({ parts: [] });
				out.push({
					type: "block-start",
					index: 0,
					blockType: type
				});
				out.push({
					type: "block-end",
					index: 0,
					block: {
						type,
						text: ""
					}
				});
			}
			state.replayBlocks[state.replayBlocks.length - 1].parts.push(replayPart(part));
		}
		if (isRecord(part.functionCall)) {
			out.push(...closeCurrentBlock(state));
			const fc = part.functionCall;
			const toolName = asString(fc.name) || "";
			const toolId = sanitizeToolCallId(asString(fc.id) || "", toolName);
			const argsText = JSON.stringify(isRecord(fc.args) ? fc.args : {});
			const index = state.blocks.length;
			const block = {
				type: "tool-call",
				id: CallId(toolId),
				name: toolName,
				arguments: argsText
			};
			state.blocks.push(block);
			const sig = thoughtSignature(part) || thoughtSignature(fc);
			state.replayBlocks.push({ parts: [{
				...replayPart(part),
				...sig ? { thoughtSignature: sig } : {}
			}] });
			state.hasContent = true;
			state.hasToolCall = true;
			out.push({
				type: "block-start",
				index,
				blockType: "tool-call"
			});
			out.push({
				type: "tool-call-delta",
				index,
				id: CallId(toolId),
				name: toolName,
				argumentsDelta: argsText
			});
			out.push({
				type: "block-end",
				index,
				block
			});
		}
	}
	collectUsage(chunk.usageMetadata, state);
	if (responseData !== chunk) collectUsage(responseData.usageMetadata, state);
	const finishReason = asString(candidate?.finishReason) || asString(responseData.finishReason);
	if (finishReason) {
		state.finishReason = finishReason;
		out.push(...closeCurrentBlock(state));
	}
	return out;
}
function closeStream(state) {
	if (state.finished) return [];
	if (!state.finishReason && !state.done) throw new LlmError("Antigravity stream ended before its terminal response", "PROVIDER_ERROR");
	state.finished = true;
	const out = closeCurrentBlock(state);
	if (state.usageMetadata) out.push({
		type: "usage",
		usage: tokenUsage(state.usageMetadata)
	});
	const reason = state.finishReason === "MAX_TOKENS" ? { kind: "max-tokens" } : state.hasToolCall ? { kind: "tool-calls" } : { kind: "stop" };
	out.push({
		type: "finish",
		reason,
		replayState: {
			response: { provider: PROVIDER_ID },
			blocks: state.replayBlocks
		}
	});
	return out;
}
//#endregion
//#region src/host/antigravity/adapter.ts
var AntigravityAdapter = class extends LlmAdapter {
	store;
	modelSettings;
	preferences;
	options;
	constructor(store = new FileCredentialStore(), modelSettings = new FileModelSettingsStore(), preferences, options = {}) {
		super();
		this.store = store;
		this.modelSettings = modelSettings;
		this.preferences = preferences;
		this.options = options;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: PROVIDER_NAME
		};
	}
	async listModels(provider) {
		const prov = provider || "antigravity";
		const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read();
		const enabledSet = new Set(settings.enabledModelIds);
		const available = MODELS.filter((m) => enabledSet.has(m.id));
		const overrides = settings.contextWindowOverrides || {};
		return available.map((model) => ({
			provider: prov,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities,
			context: { contextWindow: overrides[model.id] || model.contextWindow },
			defaultMaxTokens: model.maxTokens,
			...model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}
		}));
	}
	async resolveModel(provider, modelId, signal) {
		if (signal?.aborted) throw new LlmError("antigravity model resolution aborted", "ABORTED");
		const model = MODELS.find((m) => m.id === modelId) || {
			id: modelId,
			name: modelId,
			inputModalities: ["text", "image"],
			contextWindow: 128e3,
			maxTokens: 65536
		};
		const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read();
		const overrides = settings.contextWindowOverrides || {};
		const efforts = model.reasoningEfforts || [
			"low",
			"medium",
			"high"
		];
		const defaultEffort = settings.defaultReasoningEffort || "medium";
		return {
			provider,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities,
			context: { contextWindow: overrides[model.id] || model.contextWindow },
			defaultMaxTokens: model.maxTokens,
			...model.reasoningEfforts ? { reasoning: {
				efforts: efforts.map((effort) => ({
					id: ReasoningEffortId(effort),
					name: effort
				})),
				defaultEffort: ReasoningEffortId(defaultEffort)
			} } : {}
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	async *stream(options) {
		const model = MODELS.find((m) => m.id === options.model) || {
			id: options.model,
			name: options.model,
			inputModalities: ["text", "image"],
			contextWindow: 128e3,
			maxTokens: 65536
		};
		const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read();
		const effectiveEffort = options.reasoningEffort || settings.defaultReasoningEffort || void 0;
		const effectiveOptions = effectiveEffort ? {
			...options,
			reasoningEffort: effectiveEffort
		} : options;
		yield* wrapStreamWithWatchdog((watchdogSignal) => this.requestStream(effectiveOptions, model, watchdogSignal), options.signal, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE, "Antigravity");
	}
	async *requestStream(options, model, signal) {
		const fetchFn = this.options.fetchFn ?? fetch;
		const { token, projectId: defaultProj } = await ensureApiKey(this.store, fetchFn);
		const projectId = defaultProj || "antigravity-default";
		const effort = String(options.reasoningEffort || "medium").toLowerCase();
		const routing = ROUTING[model.id];
		const initialRuntime = routing?.routing[effort] || routing?.defaultRequestId || model.id;
		const fallbackRuntime = routing?.off && routing.off !== initialRuntime ? routing.off : void 0;
		const candidates = [initialRuntime];
		if (fallbackRuntime && !candidates.includes(fallbackRuntime)) candidates.push(fallbackRuntime);
		if (routing?.fallbackCandidates) {
			for (const fc of routing.fallbackCandidates) if (!candidates.includes(fc)) candidates.push(fc);
		}
		let response;
		for (const runtimeModel of candidates) {
			const body = JSON.stringify(buildRequest(options, model, projectId, runtimeModel, effort));
			const headers = {
				...antigravityHeaders(token),
				...model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}
			};
			for (const endpoint of endpointCandidates()) try {
				response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers,
					body,
					signal
				});
				if (response.ok) break;
				if (response.status === 404) break;
			} catch (err) {
				if (signal.aborted) throw new LlmError("Antigravity request aborted", "ABORTED", { cause: err });
			}
			if (response && response.ok) break;
		}
		if (!response || !response.ok) {
			const status = response?.status ?? 500;
			const errText = await response?.text().catch(() => "");
			if (status === 429) throw new LlmError(`Antigravity 账号配额已耗尽或请求受限 (429 RESOURCE_EXHAUSTED)。请在插件设置页查看配额剩余百分比及重置倒计时。原始响应: ${errText || "No response"}`, "RATE_LIMIT", { status: 429 });
			throw new LlmError(`Antigravity API error (${status}): ${errText || "No response"}`, "PROVIDER_ERROR", { status });
		}
		if (!response.body) throw new LlmError("Antigravity returned empty response body", "PROVIDER_ERROR");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const state = createStreamState();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					const chunks = processStreamLine(trimmed, state);
					for (const chunk of chunks) yield chunk;
					if (state.finished) return;
				}
			}
			buffer += decoder.decode();
			if (buffer.trim()) {
				const chunks = processStreamLine(buffer.trim(), state);
				for (const chunk of chunks) yield chunk;
			}
			for (const chunk of closeStream(state)) yield chunk;
		} finally {
			reader.cancel().catch(() => void 0);
		}
	}
};
//#endregion
//#region src/host/antigravity/routes.ts
function sendJson(response, status, body) {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}
function sendMethodNotAllowed(response) {
	sendJson(response, 405, {
		ok: false,
		error: "Method Not Allowed"
	});
}
async function readRequestJson(request) {
	return new Promise((resolve, reject) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += String(chunk);
			if (raw.length > 64 * 1024) reject(/* @__PURE__ */ new Error("Request body too large"));
		});
		request.on("end", () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch (err) {
				reject(err);
			}
		});
		request.on("error", reject);
	});
}
async function getAntigravityWebStatus(store, modelSettings, preferences) {
	const credentials = await store.read();
	const settings = preferences ? preferences.status() : await modelSettings.read();
	const quota = getCachedQuota();
	const enabledSet = new Set(settings.enabledModelIds);
	const overrides = settings.contextWindowOverrides || {};
	const models = MODELS.map((m) => ({
		id: m.id,
		name: m.name,
		enabled: enabledSet.has(m.id),
		defaultContextWindow: m.contextWindow,
		contextWindow: overrides[m.id] || m.contextWindow,
		reasoningEfforts: m.reasoningEfforts
	}));
	return {
		authenticated: !!(credentials?.access || credentials?.access_token),
		email: credentials?.email,
		projectId: credentials?.projectId,
		hasCredentials: !!credentials,
		storagePath: store.path(),
		lastFetchedAt: quota?.fetchedAt,
		quota,
		models,
		contextWindowOverrides: overrides,
		defaultReasoningEffort: settings.defaultReasoningEffort || null
	};
}
function registerAntigravityRoutes(ctx, store, modelSettings, preferences, fetchFn = fetch) {
	return ctx.webServer.register({
		kind: "prefix",
		path: "/antigravity/api",
		handler: async (request, response) => {
			const path = new URL(request.url || "/", "http://dsh.local").pathname.replace(/^\/antigravity\/api\/?/, "");
			try {
				if (path === "status" || path === "") {
					if (request.method !== "GET") return sendMethodNotAllowed(response);
					return sendJson(response, 200, {
						ok: true,
						value: await getAntigravityWebStatus(store, modelSettings, preferences)
					});
				}
				if (path === "login") {
					if (request.method !== "POST") return sendMethodNotAllowed(response);
					return sendJson(response, 200, {
						ok: true,
						value: await beginWebLogin(store, fetchFn)
					});
				}
				if (path === "login/status") {
					if (request.method !== "GET") return sendMethodNotAllowed(response);
					return sendJson(response, 200, {
						ok: true,
						value: getWebLoginStatus()
					});
				}
				if (path === "quota") {
					if (request.method !== "GET" && request.method !== "POST") return sendMethodNotAllowed(response);
					const quota = await fetchAccountQuota(store, modelSettings, fetchFn);
					return sendJson(response, 200, {
						ok: true,
						value: {
							...await getAntigravityWebStatus(store, modelSettings, preferences),
							quota
						}
					});
				}
				if (path === "settings") {
					if (request.method !== "POST") return sendMethodNotAllowed(response);
					const body = await readRequestJson(request);
					if (preferences) await preferences.update(body);
					else await modelSettings.updateSettings(body);
					return sendJson(response, 200, {
						ok: true,
						value: await getAntigravityWebStatus(store, modelSettings, preferences)
					});
				}
				if (path === "models") {
					if (request.method === "GET") return sendJson(response, 200, {
						ok: true,
						value: (await getAntigravityWebStatus(store, modelSettings, preferences)).models
					});
					if (request.method === "POST") {
						const body = await readRequestJson(request);
						if (Array.isArray(body.enabledModelIds) || body.contextWindowOverrides || body.defaultReasoningEffort !== void 0) if (preferences) await preferences.update(body);
						else await modelSettings.updateSettings(body);
						return sendJson(response, 200, {
							ok: true,
							value: await getAntigravityWebStatus(store, modelSettings, preferences)
						});
					}
					return sendMethodNotAllowed(response);
				}
				if (path === "logout") {
					if (request.method !== "POST") return sendMethodNotAllowed(response);
					await store.delete();
					return sendJson(response, 200, {
						ok: true,
						value: await getAntigravityWebStatus(store, modelSettings)
					});
				}
				return sendJson(response, 404, {
					ok: false,
					error: "not-found"
				});
			} catch (err) {
				return sendJson(response, 500, {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
	});
}
//#endregion
//#region src/index.ts
const inject = [
	"webServer",
	"llm",
	"attachments",
	"tools",
	"web",
	"settings",
	"loader"
];
function apply(ctx) {
	const store = createPlatformTokenStore();
	const preferences = registerPreferenceStore(ctx.settings);
	const antigravityStore = new FileCredentialStore();
	const antigravityModelSettings = new FileModelSettingsStore();
	const antigravityPreferences = registerAntigravityPreferenceStore(ctx.settings, antigravityModelSettings);
	ctx.effect(() => {
		const proxyManager = new ProxyManager({
			getPreferences: () => preferences.status(),
			logger: ctx.logger
		});
		const proxyFetch = proxyManager.createFetch();
		const antigravityAdapter = new AntigravityAdapter(antigravityStore, antigravityModelSettings, antigravityPreferences, { fetchFn: proxyFetch });
		const disposeAntigravityAdapter = ctx.llm.registerAdapter([PROVIDER_ID], antigravityAdapter);
		const disposeAntigravityRoutes = registerAntigravityRoutes(ctx, antigravityStore, antigravityModelSettings, antigravityPreferences, proxyFetch);
		const oauth = new OAuthService(store, {
			fetchFn: proxyFetch,
			logger: ctx.logger
		});
		const usage = new UsageService(oauth, { fetchFn: proxyFetch });
		const adapter = new CodexChatGptAdapter(new ResponsesClient(oauth, ctx.attachments, {
			fetchFn: proxyFetch,
			localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
			onGenerationFinished: () => usage.invalidate(),
			outputVerbosity: () => preferences.status().outputVerbosity,
			fastMode: () => preferences.status().fastMode,
			reasoningSummary: () => preferences.status().reasoningSummary
		}), preferences);
		const searchSwitcher = new SearchProviderSwitcher(ctx.loader);
		const applySearchPreference = (searchProvider = preferences.status().searchProvider) => {
			searchSwitcher.select(searchProvider).catch((error) => {
				ctx.logger.warn(`[dsh-chatgpt-subscription] Search provider preference could not be applied: ${error instanceof Error ? error.message : String(error)}`);
			});
		};
		const disposeRoutes = registerRoutes(ctx, oauth, usage, preferences, proxyManager);
		const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID$1], adapter);
		const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments, { fetchFn: proxyFetch }));
		let disposeWebProviders = () => {};
		const registerWebProviders = () => {
			disposeWebProviders();
			if (ctx.web) {
				const d1 = ctx.web.registerSearchProvider(createCodexSearchProvider(oauth, { fetchFn: proxyFetch }));
				const d2 = ctx.web.registerFetchProvider(createCodexFetchProvider({ fetchFn: proxyFetch }));
				disposeWebProviders = () => {
					d1();
					d2();
				};
			}
		};
		registerWebProviders();
		const disposePreferenceWatch = preferences.watch((next) => applySearchPreference(next.searchProvider));
		applySearchPreference();
		return () => {
			disposePreferenceWatch();
			disposeWebProviders();
			disposeImageTool();
			disposeAdapter();
			disposeRoutes();
			disposeAntigravityRoutes();
			disposeAntigravityAdapter();
			oauth.dispose();
			proxyManager.dispose();
		};
	}, "dsh-chatgpt-subscription: adapter, routes, and lifecycle");
}
function localWebServerBaseUrl(host, port) {
	return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}
//#endregion
export { AntigravityAdapter, CodexChatGptAdapter, FileCredentialStore, FileModelSettingsStore, LinuxFileTokenStore, MacKeychainTokenStore, OAuthService, ProxyManager, ResponsesClient, UsageService, WindowsDpapiTokenStore, apply, beginWebLogin, createCodexFetchProvider, createCodexImageTool, createCodexSearchProvider, createPlatformTokenStore, credentialPath, detectSystemProxy, fetchAccountQuota, getCachedQuota, inject, loginAndSave, mapCodexUsage, modelSettingsPath, parseCodexUsage, parseResponsesStream, refreshAntigravityToken };
