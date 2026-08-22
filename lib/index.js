import { CallId, HarnessError, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, attributionHeaders, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebError } from "@deepseek-ai/dsh-web";
import http from "node:http";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { delegationDepthOf } from "@deepseek-ai/dsh-subagent";
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
const CODEX_ORIGINATOR = "opencode";
const CODEX_IMAGE_TOOL_NAME = "codex_image_generate";
const CODEX_IMAGE_MODEL = "gpt-image-2";
const CODEX_SEARCH_PROVIDER_ID = "codex-subscription";
const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15e3;
const OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
//#endregion
//#region src/shared/model-catalog.ts
const GPT_56_MAX_CONTEXT_WINDOW = 1e6;
const CODEX_MODEL_CATALOG = [
	{
		id: "gpt-5.6-sol",
		name: "5.6 Sol",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-5.6",
		supportsReasoningSummary: true
	},
	{
		id: "gpt-5.6-terra",
		name: "5.6 Terra",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-5.6",
		supportsReasoningSummary: true
	},
	{
		id: "gpt-5.6-luna",
		name: "5.6 Luna",
		contextWindow: 272e3,
		inputModalities: ["text", "image"],
		defaultReasoningEffort: "medium",
		reasoningProfile: "gpt-5.6",
		supportsReasoningSummary: true
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
		supportsReasoningSummary: true
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
const DEFAULT_CODEX_MODEL = CODEX_MODEL_CATALOG[0];
const CONFIGURABLE_CONTEXT_MODEL_IDS = [
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
function reasoningEffortsForModel(model) {
	return resolveCodexCatalogEntry(model).reasoningProfile === "gpt-5.6" ? GPT_56_REASONING_EFFORTS : STANDARD_REASONING_EFFORTS;
}
function isConfigurableContextModelId(model) {
	return typeof model === "string" && CONFIGURABLE_CONTEXT_MODEL_IDS.some((id) => id === model);
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
//#endregion
//#region src/host/model-catalog.ts
const PROVIDER_ID = CODEX_CHATGPT_PROVIDER_ID;
const PROVIDER_NAME = "Codex（ChatGPT 订阅）";
function listCodexModels() {
	return CODEX_MODEL_CATALOG.map((entry) => ({
		provider: PROVIDER_ID,
		id: entry.id,
		name: entry.name,
		inputModalities: [...entry.inputModalities]
	}));
}
function resolveCodexModel(model, preferences) {
	const entry = resolveCodexCatalogEntry(model);
	const configuredContextWindow = isConfigurableContextModelId(model) ? preferences?.status().contextWindowOverrides[model] : void 0;
	const efforts = reasoningEffortsForModel(model);
	return {
		provider: PROVIDER_ID,
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
	maxRetries: 2,
	retryableCodes: [
		"RATE_LIMIT",
		"SERVER_ERROR",
		"NETWORK"
	],
	backoff: {
		initialDelayMs: 1e3,
		maxDelayMs: 1e4,
		jitterRatio: .15
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
			name: PROVIDER_NAME
		};
	}
	providerRetryPolicy() {
		return RETRY_POLICY;
	}
	async listModels() {
		return listCodexModels();
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
			commands: {
				search_query: [{ q: query }],
				response_length: "short"
			},
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
//#region src/shared/preferences.ts
const PREFERENCES_NAMESPACE = "dsh-chatgpt-subscription";
const DEFAULT_PREFERENCES = {
	quickQuotaVisible: false,
	searchProvider: "dsh",
	subagentProvider: "codex-chatgpt",
	subagentModel: "gpt-5.6-sol",
	subagentReasoningEffort: "medium",
	subagentContextWindow: 272e3,
	subagentMaxDepth: 3,
	subagentMaxAgents: 8,
	contextWindowOverrides: {
		"gpt-5.6-sol": 272e3,
		"gpt-5.6-terra": 272e3,
		"gpt-5.6-luna": 272e3
	}
};
const SEARCH_PROVIDER_CODEX = "codex";
function isSearchProviderPreference(value) {
	return value === "dsh" || value === "codex";
}
//#endregion
//#region src/host/preferences.ts
function registerPreferenceStore(settings) {
	return new SettingsPreferenceStore(settings.register(settingsNamespace(PREFERENCES_NAMESPACE), z.object({
		quickQuotaVisible: z.boolean().default(DEFAULT_PREFERENCES.quickQuotaVisible),
		searchProvider: z.union([z.const("dsh"), z.const(SEARCH_PROVIDER_CODEX)]).default(DEFAULT_PREFERENCES.searchProvider),
		subagentProvider: z.string().default(DEFAULT_PREFERENCES.subagentProvider),
		subagentModel: z.string().default(DEFAULT_PREFERENCES.subagentModel),
		subagentReasoningEffort: z.union([z.string(), z.const(null)]).default(DEFAULT_PREFERENCES.subagentReasoningEffort),
		subagentContextWindow: z.number().step(1).min(1).default(DEFAULT_PREFERENCES.subagentContextWindow),
		subagentMaxDepth: z.number().step(1).min(0).max(3).default(DEFAULT_PREFERENCES.subagentMaxDepth),
		subagentMaxAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_PREFERENCES.subagentMaxAgents),
		contextWindowOverrides: z.object({
			"gpt-5.6-sol": z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-5.6-sol"]),
			"gpt-5.6-terra": z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-5.6-terra"]),
			"gpt-5.6-luna": z.number().step(1).min(1).max(GPT_56_MAX_CONTEXT_WINDOW).default(DEFAULT_PREFERENCES.contextWindowOverrides["gpt-5.6-luna"])
		}).default(DEFAULT_PREFERENCES.contextWindowOverrides)
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
		if (patch.searchProvider !== void 0) {
			if (!isSearchProviderPreference(patch.searchProvider)) throw new PreferenceError("Unsupported search provider preference.");
			normalized.searchProvider = patch.searchProvider;
		}
		if (patch.subagentProvider !== void 0) normalized.subagentProvider = patch.subagentProvider;
		if (patch.subagentModel !== void 0) normalized.subagentModel = patch.subagentModel;
		if (patch.subagentReasoningEffort !== void 0) normalized.subagentReasoningEffort = patch.subagentReasoningEffort;
		if (patch.subagentContextWindow !== void 0) normalized.subagentContextWindow = patch.subagentContextWindow;
		if (patch.subagentMaxDepth !== void 0) normalized.subagentMaxDepth = patch.subagentMaxDepth;
		if (patch.subagentMaxAgents !== void 0) normalized.subagentMaxAgents = patch.subagentMaxAgents;
		if (patch.contextWindowOverrides !== void 0) normalized.contextWindowOverrides = {
			...this.scope.get().contextWindowOverrides,
			...patch.contextWindowOverrides
		};
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
//#region src/host/responses-mapper.ts
function hiddenSandboxControlToolNames(options) {
	const retryTools = recentSandboxRetryToolNames(options.messages);
	return new Set(options.tools?.filter((tool) => hasSandboxControls(tool.parameters) && !retryTools.has(tool.name)).map((tool) => tool.name) ?? []);
}
async function buildResponsesPayload(options, attachments, localRawImages = {}) {
	const sandboxRetryTools = recentSandboxRetryToolNames(options.messages);
	const resolveLocalRawImages = supportsImageInput(options);
	const instructionParts = [
		options.system?.trim(),
		...options.messages.filter((message) => message.role === "system").map((message) => blocksToText(message.content).trim()),
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
		const replayItems = replayOutputItems(message);
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
			appendMissingToolCalls(input, knownToolCalls, message);
			continue;
		}
		const toolResult = message.content.find((block) => block.type === "tool-result");
		if (toolResult?.type === "tool-result") {
			const callId = String(toolResult.toolCallId);
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
					text: `Tool result for unavailable call ${callId}${toolResult.isError ? " (error)" : ""}:\n${rawOutput}`
				}]
			});
			continue;
		}
		const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages);
		if (content.length > 0) input.push({
			role: message.role,
			content
		});
		if (message.role === "assistant") appendMissingToolCalls(input, knownToolCalls, message);
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
	if (options.reasoningEffort !== void 0) payload.reasoning = codexModelSupportsReasoningSummary(options.model) ? {
		effort: options.reasoningEffort,
		summary: "auto"
	} : { effort: options.reasoningEffort };
	return payload;
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
function appendMissingToolCalls(input, knownToolCalls, message) {
	for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		const callId = String(block.id);
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
const MAX_VISIBLE_REASONING_CHARS = 12e3;
const REASONING_DELTA_FLUSH_CHARS = 768;
const REASONING_TRUNCATED_NOTICE = "\n\n[Reasoning summary truncated to keep the DSH web UI responsive.]";
var ResponsesClient = class {
	oauth;
	attachments;
	fetchFn;
	onGenerationFinished;
	constructor(oauth, attachments, options = {}) {
		this.oauth = oauth;
		this.attachments = attachments;
		this.fetchFn = options.fetchFn ?? fetch;
		this.localRawImages = options.localRawImages ?? {};
		this.onGenerationFinished = options.onGenerationFinished ?? (() => void 0);
	}
	localRawImages;
	async *stream(options) {
		const payload = await buildResponsesPayload(options, this.attachments, this.localRawImages);
		const hiddenSandboxControls = hiddenSandboxControlToolNames(options);
		const sessionId = stableSessionId(options.sessionId);
		try {
			yield* parseResponsesStream(await this.send(payload, sessionId, options.signal), options.signal, hiddenSandboxControls);
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
				id: string(item?.call_id) ?? string(event.call_id) ?? `call_${key}`,
				itemId,
				name: string(item?.name) ?? string(event.name) ?? "",
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
			tool.id = string(item?.call_id) ?? tool.id;
			tool.name = string(item?.name) ?? tool.name;
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
					id: CallId(tool.id),
					name: tool.name || void 0,
					argumentsDelta: initial
				};
				tool.arguments = initial;
			} else if (type === "response.output_item.done" && initial !== "") tool.arguments = initial;
			return;
		}
		if (type === "response.function_call_arguments.delta") {
			const tool = toolFor(event);
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
				id: CallId(tool.id),
				name: tool.name || void 0,
				argumentsDelta: delta
			};
			return;
		}
		if (type === "response.function_call_arguments.done") {
			const tool = toolFor(event);
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
			throw new LlmError(string(error?.message) ?? "Codex generation failed.", string(error?.code) ?? "PROVIDER_ERROR");
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
				id: CallId(tool.id),
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
	return { availableCount: Math.max(0, Math.floor(available)) };
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
//#region src/host/subagent-context-adapter.ts
/**
* A private provider route that delegates streaming to a selected registered
* provider while exposing a user-selected effective context window to DSH.
*/
var SubagentContextAdapter = class SubagentContextAdapter extends LlmAdapter {
	llm;
	selection;
	static provider = "dsh-subagent-model-override";
	constructor(llm, selection) {
		super();
		this.llm = llm;
		this.selection = selection;
	}
	providerInfo() {
		return {
			id: SubagentContextAdapter.provider,
			name: "Subagent model override"
		};
	}
	async listModels() {
		const selected = this.selection();
		return [{
			provider: SubagentContextAdapter.provider,
			id: selected.model,
			name: selected.model
		}];
	}
	async resolveModel(_provider, _model, signal) {
		const selected = this.selection();
		return {
			...await this.llm.resolveModelInfo(selected.provider, selected.model, signal),
			provider: SubagentContextAdapter.provider,
			id: selected.model,
			context: { contextWindow: selected.contextWindow }
		};
	}
	stream(options) {
		const selected = this.selection();
		const { preparedCall: _preparedCall, ...forwarded } = options;
		return this.llm.stream({
			...forwarded,
			provider: selected.provider,
			model: selected.model
		});
	}
};
//#endregion
//#region src/host/routes.ts
const MAX_BODY_BYTES = 64 * 1024;
function registerRoutes(ctx, oauth, usage, preferences) {
	const handler = async (request, response) => {
		const url = new URL(request.url ?? "/", "http://dsh.local");
		if (request.method === "GET" && url.pathname === `/api/dsh-chatgpt-subscription/models`) {
			json(response, {
				ok: true,
				value: await subagentModelCatalog(ctx)
			});
			return;
		}
		if (request.method === "GET" && url.pathname === `/api/dsh-chatgpt-subscription/status`) {
			const oauthStatus = await oauth.status();
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
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readPreferencesUpdate(value, current) {
	const patch = {};
	if ("quickQuotaVisible" in value) {
		if (typeof value.quickQuotaVisible !== "boolean") throw new PreferenceError("quickQuotaVisible must be a boolean.");
		patch.quickQuotaVisible = value.quickQuotaVisible;
	}
	if ("searchProvider" in value) {
		if (value.searchProvider !== "dsh" && value.searchProvider !== "codex") throw new PreferenceError("searchProvider must be dsh or codex.");
		patch.searchProvider = value.searchProvider;
	}
	if ("subagentProvider" in value) {
		if (typeof value.subagentProvider !== "string" || value.subagentProvider === "") throw new PreferenceError("subagentProvider must be a non-empty string.");
		patch.subagentProvider = value.subagentProvider;
	}
	if ("subagentModel" in value) {
		if (typeof value.subagentModel !== "string" || value.subagentModel === "") throw new PreferenceError("subagentModel must be a non-empty string.");
		patch.subagentModel = value.subagentModel;
	}
	if ("subagentReasoningEffort" in value) {
		if (value.subagentReasoningEffort !== null && (typeof value.subagentReasoningEffort !== "string" || value.subagentReasoningEffort === "")) throw new PreferenceError("subagentReasoningEffort must be null or a non-empty string.");
		patch.subagentReasoningEffort = value.subagentReasoningEffort;
	}
	if ("subagentContextWindow" in value) {
		if (!Number.isSafeInteger(value.subagentContextWindow) || value.subagentContextWindow < 1) throw new PreferenceError("subagentContextWindow must be a positive integer.");
		patch.subagentContextWindow = value.subagentContextWindow;
	}
	if ("subagentMaxDepth" in value) {
		if (!Number.isSafeInteger(value.subagentMaxDepth) || value.subagentMaxDepth < 0 || value.subagentMaxDepth > 3) throw new PreferenceError(`subagentMaxDepth must be an integer from 0 to 3.`);
		patch.subagentMaxDepth = value.subagentMaxDepth;
	}
	if ("subagentMaxAgents" in value) {
		if (!Number.isSafeInteger(value.subagentMaxAgents) || value.subagentMaxAgents < 1) throw new PreferenceError("subagentMaxAgents must be a positive integer.");
		patch.subagentMaxAgents = value.subagentMaxAgents;
	}
	if ("contextWindowOverrides" in value) {
		if (!isRecord(value.contextWindowOverrides)) throw new PreferenceError("contextWindowOverrides must be an object.");
		const overrides = {};
		for (const [model, contextWindow] of Object.entries(value.contextWindowOverrides)) {
			if (!isConfigurableContextModelId(model)) throw new PreferenceError("Only GPT-5.6 context windows can be changed.");
			if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 1e6) throw new PreferenceError(`contextWindowOverrides.${model} must be a positive integer no greater than the provider limit.`);
			overrides[model] = contextWindow;
		}
		patch.contextWindowOverrides = overrides;
	}
	return patch;
}
async function subagentModelCatalog(ctx) {
	const results = await Promise.all(ctx.llm.listProviders().filter((provider) => provider.id !== SubagentContextAdapter.provider).map(async (provider) => {
		try {
			const models = await ctx.llm.listModels(provider.id);
			return {
				kind: "provider",
				provider: {
					id: provider.id,
					name: provider.name,
					models: await Promise.all(models.map(async (model) => {
						const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
						return {
							id: model.id,
							name: model.name,
							...model.description === void 0 ? {} : { description: model.description },
							...resolved.context === void 0 ? {} : {
								contextWindow: resolved.context.contextWindow,
								maxContextWindow: provider.id === "codex-chatgpt" && isConfigurableContextModelId(model.id) ? GPT_56_MAX_CONTEXT_WINDOW : resolved.context.contextWindow
							},
							...resolved.reasoning === void 0 ? {} : { reasoning: {
								efforts: resolved.reasoning.efforts.map((effort) => ({
									id: effort.id,
									name: effort.name,
									...effort.description === void 0 ? {} : { description: effort.description }
								})),
								...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: resolved.reasoning.defaultEffort }
							} }
						};
					}))
				}
			};
		} catch (error) {
			return {
				kind: "failure",
				failure: {
					id: provider.id,
					name: provider.name,
					message: error instanceof Error ? error.message : String(error)
				}
			};
		}
	}));
	return {
		providers: results.filter((result) => result.kind === "provider").map((result) => result.provider),
		failures: results.filter((result) => result.kind === "failure").map((result) => result.failure)
	};
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
var MacKeychainTokenStore = class {
	service;
	account;
	storage = {
		kind: "macos-keychain",
		encrypted: true
	};
	constructor(service = DEFAULT_SERVICE, account = DEFAULT_ACCOUNT) {
		this.service = service;
		this.account = account;
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
			return parseStoredCredentials(JSON.parse(payload));
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
[IO.File]::WriteAllBytes($temporary, $cipher)
if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, $null) } else { [IO.File]::Move($temporary, $path) }
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
var WindowsDpapiTokenStore = class {
	path;
	storage = {
		kind: "windows-dpapi",
		encrypted: true
	};
	constructor(path = defaultDpapiCredentialPath()) {
		this.path = path;
		if (process.platform !== "win32") throw new Error("Windows DPAPI storage requires Windows");
		if (dirname(path) === path) throw new Error("invalid DPAPI credential path");
	}
	async load() {
		const result = await runPowerShell(UNPROTECT_SCRIPT, this.path, "");
		if (result.code === 3) return null;
		if (result.code !== 0) throw new Error("DPAPI credential read failed");
		try {
			return parseStoredCredentials(JSON.parse(result.stdout));
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
	originalProvider;
	initialized = false;
	constructor(loader) {
		this.loader = loader;
	}
	async select(preference) {
		const entry = this.findWebEntry();
		if (entry === null) return;
		const config = currentConfig(entry);
		if (!this.initialized) {
			this.originalProvider = typeof config.searchProvider === "string" && config.searchProvider !== "codex-subscription" ? config.searchProvider : void 0;
			this.initialized = true;
		}
		const selected = preference === "codex" ? CODEX_SEARCH_PROVIDER_ID : this.originalProvider;
		if (config.searchProvider === selected) return;
		const nextConfig = { ...config };
		if (selected === void 0) delete nextConfig.searchProvider;
		else nextConfig.searchProvider = selected;
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
//#region src/host/subagent-model-preference.ts
/** Apply the configured provider/model/reasoning route to every delegated Agent. */
function installSubagentModelPreference(ctx, preferences) {
	return ctx.on("agent/request", async (payload, next) => {
		const resolved = await next();
		if (payload.agent.session.header.origin !== "subagent") return resolved;
		const selection = preferences.status();
		return {
			...resolved,
			provider: SubagentContextAdapter.provider,
			model: selection.subagentModel,
			...selection.subagentReasoningEffort === null ? { reasoningEffort: void 0 } : { reasoningEffort: ReasoningEffortId(selection.subagentReasoningEffort) }
		};
	});
}
//#endregion
//#region src/host/subagent-policy.ts
const MANAGED_DELEGATION_TOOLS = /* @__PURE__ */ new Set(["subagent", "subagent_fork"]);
/**
* Enforce global limits with a user-facing preflight on built-in delegation
* tools and an authoritative synchronous Agent-publication gate. The latter
* also covers workflows, Ralph, and nested subagents without depending on the
* parent's provider or model. Throwing from `agent/created` vetoes and rolls
* back the new child before its loop starts; already-running children remain.
*/
function installSubagentPolicy(ctx, preferences) {
	const disposePreflight = ctx.on("tools/pre-execute", async (exec, next) => {
		const parent = exec.agent;
		if (parent === void 0 || !MANAGED_DELEGATION_TOOLS.has(exec.name)) return next();
		const { subagentMaxDepth, subagentMaxAgents } = preferences.status();
		const attemptedDepth = delegationDepthOf(parent) + 1;
		if (attemptedDepth > subagentMaxDepth) return {
			kind: "deny",
			reason: `Subagent nesting depth limit reached: attempted depth ${attemptedDepth}, configured maximum ${subagentMaxDepth}.`
		};
		const activeAgents = activeDescendantCount(ctx, subagentTreeRoot(ctx, parent).id);
		if (activeAgents >= subagentMaxAgents) return {
			kind: "deny",
			reason: `Subagent limit reached: ${activeAgents} active descendants in the Agent tree, configured maximum ${subagentMaxAgents}. Wait for one to finish or raise the global limit in Subagents settings.`
		};
		return next();
	});
	const disposePublicationGate = ctx.on("agent/created", ({ agent }) => {
		if (agent.session.header.origin !== "subagent") return;
		const { subagentMaxDepth, subagentMaxAgents } = preferences.status();
		const depth = delegationDepthOf(agent);
		if (depth > subagentMaxDepth) throw new Error(`Subagent nesting depth limit reached: attempted depth ${depth}, configured maximum ${subagentMaxDepth}.`);
		const activeAgents = activeDescendantCount(ctx, subagentTreeRoot(ctx, agent).id);
		if (activeAgents > subagentMaxAgents) throw new Error(`Subagent limit reached: attempted ${activeAgents} active descendants in the Agent tree, configured maximum ${subagentMaxAgents}. Wait for one to finish or raise the global limit in Subagents settings.`);
	});
	return () => {
		disposePublicationGate();
		disposePreflight();
	};
}
/** Return the highest currently live ancestor that owns this subagent tree. */
function subagentTreeRoot(ctx, agent) {
	let current = agent;
	const visited = /* @__PURE__ */ new Set([agent.id]);
	while (current.session.header.origin === "subagent") {
		const parentId = current.session.header.parentSession;
		if (parentId === void 0 || visited.has(parentId)) break;
		const parent = ctx.agents.get(parentId);
		if (parent === void 0) break;
		visited.add(parent.id);
		current = parent;
	}
	return current;
}
/** Return currently live descendants in one caller's subagent tree. */
function activeDescendantIds(ctx, parentId) {
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const agent of ctx.agents.list()) {
		if (agent.session.header.origin !== "subagent") continue;
		const directParent = agent.session.header.parentSession;
		if (directParent === void 0) continue;
		const children = childrenByParent.get(directParent) ?? [];
		children.push(agent.id);
		childrenByParent.set(directParent, children);
	}
	const descendants = /* @__PURE__ */ new Set();
	const pending = [...childrenByParent.get(parentId) ?? []];
	while (pending.length > 0) {
		const id = pending.pop();
		if (descendants.has(id)) continue;
		descendants.add(id);
		pending.push(...childrenByParent.get(id) ?? []);
	}
	return descendants;
}
function activeDescendantCount(ctx, parentId) {
	return activeDescendantIds(ctx, parentId).size;
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
	"loader",
	"agents"
];
function apply(ctx) {
	const oauth = new OAuthService(createPlatformTokenStore(), { logger: ctx.logger });
	const usage = new UsageService(oauth);
	const preferences = registerPreferenceStore(ctx.settings);
	const adapter = new CodexChatGptAdapter(new ResponsesClient(oauth, ctx.attachments, {
		localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
		onGenerationFinished: () => usage.invalidate()
	}), preferences);
	ctx.effect(() => {
		const searchSwitcher = new SearchProviderSwitcher(ctx.loader);
		const applySearchPreference = (searchProvider = preferences.status().searchProvider) => {
			searchSwitcher.select(searchProvider).catch((error) => {
				ctx.logger.warn(`[dsh-chatgpt-subscription] Search provider preference could not be applied: ${error instanceof Error ? error.message : String(error)}`);
			});
		};
		const disposeRoutes = registerRoutes(ctx, oauth, usage, preferences);
		const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
		const subagentContextAdapter = new SubagentContextAdapter(ctx.llm, () => {
			const selected = preferences.status();
			return {
				provider: selected.subagentProvider,
				model: selected.subagentModel,
				contextWindow: selected.subagentContextWindow
			};
		});
		const disposeSubagentContextAdapter = ctx.llm.registerAdapter([SubagentContextAdapter.provider], subagentContextAdapter);
		const disposeSubagentModelPreference = installSubagentModelPreference(ctx, preferences);
		const disposeSubagentPolicy = installSubagentPolicy(ctx, preferences);
		const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments));
		const disposeSearchProvider = ctx.web.registerSearchProvider(createCodexSearchProvider(oauth));
		const disposePreferenceWatch = preferences.watch((next) => applySearchPreference(next.searchProvider));
		applySearchPreference();
		return () => {
			disposePreferenceWatch();
			disposeSubagentPolicy();
			disposeSubagentModelPreference();
			disposeSearchProvider();
			disposeImageTool();
			disposeSubagentContextAdapter();
			disposeAdapter();
			disposeRoutes();
			oauth.dispose();
		};
	}, "dsh-chatgpt-subscription: adapter, routes, and lifecycle");
}
function localWebServerBaseUrl(host, port) {
	return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}
//#endregion
export { CodexChatGptAdapter, LinuxFileTokenStore, MacKeychainTokenStore, OAuthService, ResponsesClient, UsageService, WindowsDpapiTokenStore, apply, createCodexImageTool, createCodexSearchProvider, createPlatformTokenStore, inject, mapCodexUsage, parseCodexUsage, parseResponsesStream };
